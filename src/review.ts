import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LoopState, PiRunResult, TumwaterConfig } from "./types.js";
import { reviewConfig } from "./config.js";
import { logEvent } from "./events.js";
import { aheadOfMainDiff, aheadOfMainFiles, git, headOf, resetWorktreeToMain } from "./git.js";
import { piLogPath, reviewSessionDir } from "./paths.js";
import { runPi } from "./pi.js";
import { buildReviewPrompt, readPrinciples } from "./prompt.js";
import { verdictLines } from "./reply-contract.js";
import { saveLoopState } from "./state.js";
import { shortSha } from "./text.js";

const execFileAsync = promisify(execFile);

/** Consecutive failed reviews of one branch HEAD after which the leftover is discarded with
 * a warning: a misconfigured reviewer model must not be able to wedge a loop into re-reviewing
 * the same commit forever. */
export const REVIEW_FAILURE_LIMIT = 3;

/** Convert one exemption glob pattern to an anchored regex: `**` crosses path segments, `*`
 * stays within one segment, everything else is literal. */
function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|+?()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when the repo-relative path matches one exemption pattern. A pattern containing no
 * "/" matches the file's BASENAME at any depth (`*.md` exempts `docs/notes.md` too); a
 * pattern containing "/" matches the full repo-relative path, where `*` stays within one
 * segment and `**` crosses segments (`docs/**` = everything under docs/). */
export function isExemptPath(relPath: string, patterns: string[]): boolean {
  const norm = relPath.replace(/\\/g, "/");
  for (const p of patterns) {
    if (!p) continue;
    const target = p.includes("/") ? norm : (norm.split("/").pop() ?? norm);
    if (globToRegex(p).test(target)) return true;
  }
  return false;
}

/** True when EVERY changed file in the diff matches some exemption pattern — doc-only diffs
 * stay cheap by construction. An empty diff is vacuously exempt: there is nothing to review. */
export function isExemptDiff(files: string[], patterns: string[]): boolean {
  return files.every((f) => isExemptPath(f, patterns));
}

// ── Deterministic build pre-check ────────────────────────────────────────────────────────
// A check whose correctness must not depend on model compliance is run by the harness, not
// asked of the reviewer (plans/review-gate.md): the reviewer may not run state-changing
// commands, and `npm run build` is exactly that — type errors are invisible to a model that
// cannot compile.

/** The project's declared deterministic check: an npm script name plus the directory whose
 * package.json declares it (the walk-up target holding both package.json and node_modules). */
export interface BuildCheck {
  /** Directory holding the qualifying package.json + node_modules. */
  rootDir: string;
  /** The npm script to run — `typecheck` preferred, else `build`. */
  script: string;
}

/** True when `dir` holds both a package.json and a node_modules/ directory — the structural
 * signature of an installed JS project root. */
function hasInstall(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, "package.json"));
    return fs.statSync(path.join(dir, "node_modules")).isDirectory();
  } catch {
    return false;
  }
}

/** Read the check script from `dir`'s package.json: prefer typecheck, else build; null when
 * neither is present or the file cannot be read/parsed (detection never throws). */
function buildCheckFrom(dir: string): BuildCheck | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null; // Missing/unreadable/malformed — no check.
  }
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const s = scripts as Record<string, unknown>;
  if (typeof s.typecheck === "string" && s.typecheck) return { rootDir: dir, script: "typecheck" };
  if (typeof s.build === "string" && s.build) return { rootDir: dir, script: "build" };
  return null;
}

/** Find the project's deterministic build check by walking UP from `startDir` — at most
 * `maxLevels` ancestors (default 5) — to the nearest directory containing BOTH a package.json
 * and a node_modules/ directory, then preferring scripts.typecheck over scripts.build. The
 * walk is required: tumwater worktrees live under `<repo>/.tumwater/worktrees/<role>` with no
 * install of their own (node_modules is gitignored — it exists only where someone ran npm
 * install), so a literal startDir check would silently disable the pre-check forever in
 * dogfood. The FIRST qualifying directory is the project: if its package.json has neither
 * script, there is no check (an unrelated ancestor further up must never be used). Returns
 * null when no ancestor qualifies or the file is missing/unreadable/malformed — detection
 * never throws into the gate. */
export function detectBuildCheck(startDir: string, maxLevels = 5): BuildCheck | null {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level++) {
    if (hasInstall(dir)) return buildCheckFrom(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // Filesystem root reached.
    dir = parent;
  }
  return null;
}

/** Hard cap on one build check run — a hung script (watch mode) must not wedge the tick, and
 * a timeout is environmental, never fail-closed. A parameter of runBuildCheck so tests can
 * shorten it. */
export const BUILD_CHECK_TIMEOUT_MS = 300_000;

/** What the deterministic build check concluded. "passed": proceed to the reviewer unchanged.
 * "failed": a started process exited nonzero — a deterministic REJECTION with the clipped
 * output tail as machine-generated reasons (no pi run consumed). "skipped": environmental
 * (timeout, or no npm on PATH) — warn and still proceed to the model review; deliberately NOT
 * fail-closed so a hung build script cannot wedge every code tick into the 3-strike discard. */
export interface BuildCheckOutcome {
  status: "passed" | "failed" | "skipped";
  /** The script that was run (or attempted). */
  script: string;
  /** Clipped tail of the combined output on failure — last ≤10 non-empty lines, each clipped
   * to MAX_REASON_CHARS. */
  outputTail?: string[];
  /** Why no verdict was reached ("skipped"). */
  skipReason?: "timeout" | "no-npm";
}

/** Keep the TAIL of a build's combined output: last ≤10 non-empty lines, each via clipReason —
 * so a chatty build cannot bloat persisted state or the injected next-tick note. */
export function clipBuildTail(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-10).map(clipReason);
}

/** Run `npm run <script>` in the worktree (cwd = wt), capturing combined output with a hard
 * timeout. Never throws: every outcome is classified per BuildCheckOutcome. Running a local
 * script needs no network.
 * The PATH env prepends `<rootDir>/node_modules/.bin` — the installed root detectBuildCheck
 * found — because npm resolves script binaries from the NEAREST package.json, and in a
 * tumwater worktree that is the checkout's own tracked copy: it has no node_modules
 * (gitignored), so without this the script shell cannot find the toolchain (`sh: tsc:
 * command not found`, exit 127) and every code change would be rejected as a build failure.
 * npm passes inherited PATH entries through to the script's shell, so prepending is all that
 * is needed; the script still runs in wt, compiling the branch state — which is what this
 * check exists for. */
export async function runBuildCheck(
  wt: string,
  check: BuildCheck,
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
): Promise<BuildCheckOutcome> {
  const rootBin = path.join(check.rootDir, "node_modules", ".bin");
  try {
    await execFileAsync("npm", ["run", check.script], {
      cwd: wt,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      // TEMP-REVERT-FOR-TEST
    });
    return { status: "passed", script: check.script };
  } catch (err) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
    };
    // Killed by the timeout (or an output overflow): environmental — warn and proceed.
    if (e.killed || e.signal) return { status: "skipped", script: check.script, skipReason: "timeout" };
    // A started process that exited nonzero is a deterministic failure of the build itself.
    if (typeof e.code === "number") {
      return {
        status: "failed",
        script: check.script,
        outputTail: clipBuildTail(`${e.stdout ?? ""}${e.stderr ?? ""}`),
      };
    }
    // Spawn failed before anything ran — the npm binary is missing from PATH.
    return { status: "skipped", script: check.script, skipReason: "no-npm" };
  }
}

/** A parsed reviewer verdict with its reasons (numbered lines after the VERDICT line; any
 * other non-empty prose as a fallback). */
export interface ReviewVerdict {
  verdict: "approve" | "reject";
  reasons: string[];
}

/** Cap on recorded reasons, so a chatty reviewer cannot bloat persisted state. */
const MAX_REASONS = 10;
/** Per-reason length cap with ellipsis. */
const MAX_REASON_CHARS = 300;

function clipReason(r: string): string {
  return r.length > MAX_REASON_CHARS ? r.slice(0, MAX_REASON_CHARS - 1) + "…" : r;
}

/** Parse the reviewer's reply: the LAST VERDICT line wins (the prompt asks for exactly one),
 * followed by its reasons — numbered/bulleted lines first, any other non-empty prose as a
 * fallback. Null when no parseable verdict exists: that is a FAILED review, never an approval
 * (fail closed). */
export function parseVerdict(text: string): ReviewVerdict | null {
  const matches = verdictLines(text);
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  if (!last) return null; // Unreachable: the length check above guarantees a match.
  const after = text.slice(last.end);
  const lines = after.split("\n").map((l) => l.trim()).filter(Boolean);
  let reasons = lines
    .map((l) => l.match(/^(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]?.trim())
    .filter((r): r is string => Boolean(r));
  if (reasons.length === 0) reasons = lines; // Prose fallback: every non-empty line.
  return { verdict: last.verdict, reasons: reasons.slice(0, MAX_REASONS).map(clipReason) };
}

/** Everything reviewAheadOfMain needs from its caller (a LoopRunner tick or recovery). */
export interface ReviewContext {
  root: string;
  role: string;
  /** The author's worktree, post-commit — the reviewer reads the full tree there. */
  wt: string;
  mainBranch: string;
  config: TumwaterConfig;
  /** Current tick number, for the unique per-run session name. */
  tick: number;
  /** Suffix for the session name — recovery reviews pass "-recovery" so a single tick's
   * recovery review and gate review (both numbered by the same tick) never collide. */
  sessionSuffix?: string;
  signal?: AbortSignal;
  /** Cap for the deterministic build pre-check run; defaults to BUILD_CHECK_TIMEOUT_MS.
   * A test seam — production callers leave it unset. */
  buildCheckTimeoutMs?: number;
}

/** What the gate decided and what the caller should do next. "approved"/"exempt": safe to
 * merge (the work was reviewed, or needed no review). "rejected"/"failed": already handled
 * per policy (branch reset / commit left for retry) — never merge. */
export interface GateResult {
  decision: "approved" | "exempt" | "rejected" | "failed";
  /** The reviewer run was killed by harness shutdown mid-review: fail closed, leave the
   * commit, and let the tick report aborted (resume re-reviews via the combined diff). */
  aborted?: boolean;
  /** Failure message ("failed") or first rejection reason ("rejected"), for lastSummary. */
  detail?: string;
  /** The reviewer's pi run, for usage folding into the loop totals — absent when no review
   * ran (gate disabled, exempt diff, or an already-approved HEAD). */
  run?: PiRunResult;
}

/** Run the adversarial review gate over everything ahead of main in `wt` and update `state`
 * accordingly. Shared by the tick path (after commitAll) and recoverLeftover — every path
 * that can move a commit into main routes through here, so no crash or abort path smuggles
 * unreviewed work in:
 * - gate disabled, or an already-approved HEAD, or an exempt (doc-only) diff → merge as-is;
 * - approve → record lastApprovedHead and discard the reviewer's stray working-tree edits
 *   (its only output channel is the verdict);
 * - reject → reset the branch to main, record reasons in state.lastReview (injected into the
 *   role's next tick prompt), log review_rejected;
 * - fail (no parseable verdict, pi error, timeout) → leave the commit on the branch for the
 *   next tick's re-review, counting consecutive failures per HEAD; past REVIEW_FAILURE_LIMIT
 *   discard the leftover with a warning. Never throws.
 * `highFriction` marks a change whose authoring run burned more than the configured turn/time
 * thresholds (plans/refusal-and-thrash.md): the flag rides along in the review prompt so the
 * reviewer applies extra scrutiny to whether the work should exist at all. */
export async function reviewAheadOfMain(
  ctx: ReviewContext,
  state: LoopState,
  summary?: string,
  commitBody?: string,
  highFriction?: boolean,
): Promise<GateResult> {
  const { root, role, wt, mainBranch, config } = ctx;
  if (!config.review.enabled) return { decision: "exempt" };

  const head = await headOf(wt, "HEAD");
  // Already reviewed this exact HEAD (e.g. a merge_blocked retry): do not burn another run.
  if (state.lastApprovedHead === head) return { decision: "approved" };

  const files = await aheadOfMainFiles(wt, mainBranch);
  if (isExemptDiff(files, config.review.exemptPaths)) return { decision: "exempt" };

  // Deterministic build pre-check — after BOTH early returns above (an md-only diff cannot
  // break the build) and before any reviewer run or the phase/event that would show
  // "reviewing": a deterministic rejection never shows as reviewing on the dashboards. Both
  // gate callers (the tick path and recoverLeftover) get it for free.
  const check = detectBuildCheck(wt);
  if (check) {
    const timeoutMs = ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS;
    const outcome = await runBuildCheck(wt, check, timeoutMs);
    if (outcome.status === "failed") {
      // A deterministic rejection routed through the existing reject path verbatim: branch
      // reset, machine-generated reasons recorded for next-prompt injection, review_rejected
      // logged — with no pi run consumed and unreviewFailures resetting exactly like a model
      // reject (a deterministic verdict about this HEAD).
      // Machine-generated reasons: the header joined to the first output line (so the
      // compiler error sits right after it in the injected next-tick note), then the rest of
      // the clipped tail.
      const first = (outcome.outputTail ?? [])[0];
      const reasons =
        first !== undefined
          ? [`build check failed (${check.script}): ${first}`, ...(outcome.outputTail ?? []).slice(1)]
          : [`build check failed (${check.script})`];
      state.lastReview = { verdict: "reject", reasons, head, at: Date.now() };
      state.unreviewFailures = 0;
      await resetWorktreeToMain(wt, mainBranch);
      logEvent(root, { loop: role, type: "review_rejected", head, reasons });
      return { decision: "rejected", detail: reasons[0] ?? `build check failed (${check.script})` };
    }
    if (outcome.status === "skipped") {
      // Environmental — warn and proceed to the model review; deliberately NOT fail-closed,
      // so a hung build script cannot wedge every code tick into the 3-strike discard.
      logEvent(root, {
        loop: role,
        type: "warning",
        message:
          outcome.skipReason === "no-npm"
            ? `no npm on PATH; skipping build check`
            : `build check timed out after ${timeoutMs / 1000}s; proceeding to model review`,
      });
    }
  }

  logEvent(root, { loop: role, type: "review_start", head });
  // Persist the phase BEFORE the run so a dashboard mid-review shows "reviewing" and a crash
  // mid-review is distinguishable from a crash mid-author-run on resume (stray edits are the
  // reviewer's then, not the author's). Cleared at tick end alongside `running`.
  state.phase = "review";
  saveLoopState(root, state);

  const diff = await aheadOfMainDiff(wt, mainBranch);
  // The author's claimed WHY/RISK/VERIFIED ride along when present — checking those claims
  // against the actual diff is exactly the adversarial angle (recovery re-reviews pass none:
  // the original run is gone).
  const pi = await runPi({
    cwd: wt,
    prompt: buildReviewPrompt(diff, summary, commitBody, readPrinciples(root), highFriction),
    config: reviewConfig(config),
    // Fresh session every time (no --continue): the reviewer must not inherit the author's
    // context. Unique name per run — a fixed name would let pi resume an old review's
    // context; old files are cleaned by the age-based prune at orchestrator start.
    sessionDir: reviewSessionDir(root, role),
    sessionName: `tumwater-review-${role}-${ctx.tick}${ctx.sessionSuffix ?? ""}`,
    rawLogFile: piLogPath(root, role),
    signal: ctx.signal,
  });

  if (pi.aborted) {
    // Shutdown mid-review: fail closed without bookkeeping — the commit stays on the branch
    // and the resumed/following tick re-reviews it via the combined ahead-of-main diff.
    return { decision: "failed", aborted: true, run: pi };
  }

  const verdict = parseVerdict(pi.verdictText ?? "");
  if (!verdict) {
    const message = pi.errorMessage ?? "no parseable VERDICT line in the reviewer's reply";
    // Consecutive failures of THIS HEAD only: a new commit (new HEAD) starts fresh. Read
    // *before* overwriting lastReview with this failure.
    const prev = state.lastReview;
    const sameHead = prev?.verdict === "failed" && prev.head === head;
    state.unreviewFailures = (sameHead ? (state.unreviewFailures ?? 0) : 0) + 1;
    state.lastReview = { verdict: "failed", reasons: [message], head, at: Date.now() };
    logEvent(root, { loop: role, type: "review_failed", head, message });
    if ((state.unreviewFailures ?? 0) >= REVIEW_FAILURE_LIMIT) {
      await resetWorktreeToMain(wt, mainBranch);
      state.unreviewFailures = 0; // The HEAD is gone; nothing left to count against.
      logEvent(root, {
        loop: role,
        type: "warning",
        message: `discarding unreviewed leftover after ${REVIEW_FAILURE_LIMIT} failed reviews (${shortSha(head)})`,
      });
    }
    return { decision: "failed", detail: message, run: pi };
  }

  if (verdict.verdict === "reject") {
    state.lastReview = { verdict: "reject", reasons: verdict.reasons, head, at: Date.now() };
    // A parseable verdict is a successful review: the failure count resets either way.
    state.unreviewFailures = 0;
    await resetWorktreeToMain(wt, mainBranch);
    logEvent(root, { loop: role, type: "review_rejected", head, reasons: verdict.reasons });
    return { decision: "rejected", detail: verdict.reasons[0] ?? "no reasons given", run: pi };
  }

  // Approve: record the reviewed HEAD and discard any stray working-tree edits the reviewer
  // made while reading around — its only output channel is the verdict.
  state.lastApprovedHead = head;
  state.lastReview = { verdict: "approve", reasons: verdict.reasons, head, at: Date.now() };
  state.unreviewFailures = 0;
  await git(wt, "reset", "--hard", "HEAD");
  logEvent(root, { loop: role, type: "review_verdict", head, reason: verdict.reasons[0] });
  return { decision: "approved", run: pi };
}
