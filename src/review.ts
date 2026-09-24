import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, PiRunResult } from "./types.js";
import { reviewConfig } from "./config.js";
import { logEvent, warnEvent } from "./events.js";
import { commitAll, git, gitLines, gitTry, headOf } from "./git.js";
import { aheadOfMainDiff, aheadOfMainFiles } from "./git-diff.js";
import { resetWorktreeToMain } from "./worktree.js";
import { piLogPath, reviewSessionDir } from "./paths.js";
import { runPi } from "./pi.js";
import { readPrinciples } from "./prompt.js";
import type { BuildFixCommit } from "./gate-prompts.js";
import { buildBuildFixPrompt, buildReviewPrompt } from "./gate-prompts.js";
import type { VerdictMatch } from "./reply-contract.js";
import { verdictLines } from "./reply-contract.js";
import { saveLoopState } from "./state.js";
import { shortSha } from "./text.js";
import {
  BUILD_CHECK_TIMEOUT_MS,
  clipReason,
  describeCheck,
  failureHeadline,
  runScopedBuildCheck,
} from "./build-check.js";
import { isExemptDiff } from "./exemptions.js";
import { falseFixReason } from "./fix-claim.js";

/** Consecutive failed reviews of one branch HEAD after which the leftover is discarded with
 * a warning: a misconfigured reviewer model must not be able to wedge a loop into re-reviewing
 * the same commit forever. */
export const REVIEW_FAILURE_LIMIT = 3;

/** A parsed reviewer verdict with its reasons (numbered lines after the VERDICT line; any
 * other non-empty prose as a fallback). */
interface ReviewVerdict {
  verdict: "approve" | "reject";
  reasons: string[];
}

/** Cap on recorded reasons, so a chatty reviewer cannot bloat persisted state. */
const MAX_REASONS = 10;

/** Parse the reviewer's reply: the LAST VERDICT line wins (the prompt asks for exactly one),
 * followed by its reasons — numbered/bulleted lines first, any other non-empty prose as a
 * fallback. Null when no parseable verdict exists: that is a FAILED review, never an approval
 * (fail closed). */
export function parseVerdict(text: string): ReviewVerdict | null {
  const matches = verdictLines(text);
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  if (!last) return null; // Unreachable: the length check above guarantees a match.
  // A verdict line is a marker, not a boundary: reasons may sit below the LAST verdict
  // line (the prompt's advertised shape — searched first), anywhere above it, or as prose
  // anywhere in the reply. Each region yields its numbered/bulleted lines, falling back to
  // its non-empty prose, and the first region with something wins.
  const after = text.slice(last.end);
  for (const reasons of [reasonsFrom(after), reasonsFrom(textWithoutVerdictLines(text, matches))]) {
    if (reasons.length > 0) {
      return { verdict: last.verdict, reasons: reasons.slice(0, MAX_REASONS).map(clipReason) };
    }
  }
  return { verdict: last.verdict, reasons: [] };
}

/** Numbered/bulleted lines first, any other non-empty prose as a fallback — over one region
 * of a reviewer reply. The prose fallback skips lead-ins and headings (isPreamble), so the
 * first reason is the reply's first finding, not "…Findings:" or "## Review"; a region of
 * nothing but those still yields them, since a lead-in beats recording no reason at all.
 * Empty when the region carries no lines at all. */
function reasonsFrom(region: string): string[] {
  const lines = region.split("\n").map((l) => l.trim()).filter(Boolean);
  const numbered = lines.map(listItemText).filter((r): r is string => Boolean(r));
  if (numbered.length > 0) return numbered;
  const findings = lines.filter((l) => !isPreamble(l));
  return findings.length > 0 ? findings : lines;
}

/** A list item: `1.`/`1)` numbering or a `-`/`*` bullet, optionally inside a markdown
 * heading (`### 1. X`) and/or opened by bold (`**1.** X`, `**1. X.** body` — the shape
 * reviewers most often number their findings in, which a bare-marker match missed so the
 * whole reply fell to the prose fallback and its preamble became the first reason). Group 1
 * is the bold opener, group 2 a bold closer directly after the marker, group 3 the text. */
const LIST_ITEM = /^(?:#{1,6}\s+)?(\*\*)?(?:\d+[.)]|[-*])(\*\*)?\s+(.+)$/;

/** A list line's item text with the list's own markup gone — marker, heading hashes, and
 * the bold pair around the marker, whose closer sits right after it (`**1.** X`) or ends the
 * lead (`**1. X.** body` → `X. body`), so no reason carries a dangling `**`. Emphasis inside
 * the item (`1. **X** body`) is the reviewer's own and is kept. Undefined for a non-item. */
function listItemText(line: string): string | undefined {
  const m = line.match(LIST_ITEM);
  if (!m?.[3]) return undefined;
  const text = m[1] && !m[2] ? m[3].replace("**", "") : m[3];
  return text.trim() || undefined;
}

/** A prose line that introduces findings rather than stating one: a markdown heading
 * (`## Review`) or a lead-in ending in a colon ("…Findings:", "Here is what I verified:",
 * "**Summary:**"). */
function isPreamble(line: string): boolean {
  return /^#{1,6}(?:\s|$)/.test(line) || /:(?:\*\*)?$/.test(line);
}

/** The reply with every VERDICT line removed, so reasons are read from the whole text (a
 * verdict line is a marker, not the start of the payload) without a verdict line itself
 * surfacing as a prose-fallback reason. */
function textWithoutVerdictLines(text: string, matches: VerdictMatch[]): string {
  let out = "";
  let pos = 0;
  for (const m of matches) {
    out += text.slice(pos, m.index);
    pos = m.end;
  }
  return out + text.slice(pos);
}

/** The gate's build-fix commit(s) between the author's head and the fixed head, for the
 * reviewer's prompt: the whole range, not just the harness's own commit, so a commit the fix run
 * made itself despite its prompt is named too. A git read that fails falls back to the fixed
 * head alone and no file list — the block still tells the reviewer the harness added a commit,
 * which is what keeps it from reading as the author's unclaimed change. */
async function buildFixCommit(
  wt: string,
  authorHead: string,
  fixedHead: string,
  failure: string[],
  rechecked: boolean,
): Promise<BuildFixCommit> {
  const range = `${authorHead}..${fixedHead}`;
  const [commits, files] = await Promise.all([
    gitTry(wt, "rev-list", "--reverse", range),
    gitTry(wt, "diff", "--name-only", authorHead, fixedHead),
  ]);
  const shas = gitLines(commits);
  return {
    commits: shas.length > 0 ? shas : [fixedHead],
    files: gitLines(files),
    failure,
    rechecked,
  };
}

/** Everything reviewAheadOfMain needs from its caller (a LoopRunner tick or recovery). */
interface ReviewContext {
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
  /** The branch HEAD this gate invocation's pre-check just ran green on — the one tree the
   * landing path may trust without re-running the check (src/merge.ts seeds the red-main
   * baseline with it when the rebase is a no-op, and re-verifies anything else). Absent when
   * no fresh green observation was made: gate disabled, exempt diff, already-approved early
   * return, or a pre-check that failed or skipped. */
  verifiedHead?: string;
  /** The reviewer run was killed by harness shutdown mid-review: fail closed, leave the
   * commit, and let the tick report aborted (resume re-reviews via the combined diff). */
  aborted?: boolean;
  /** The gate's bounded build-fix run (a failed deterministic pre-check gets one model run to
   * turn the check green before rejecting). Present on every outcome the fix run reached —
   * approve, reject, and failure alike — so its spend folds into the loop totals exactly once
   * per invocation, whichever way the gate then decided. */
  fixRun?: PiRunResult;
  /** The strike-cap discard fired: the gate itself reset the worktree off the reviewed head,
   * so the commit is gone and any pin naming the old head must go too. An under-cap failure
   * leaves this absent — its commit (possibly with a build-fix commit on top) stays for
   * re-review. The discard is invisible in the decision alone, which is the same "failed"
   * shape an under-cap failure reports. */
  discarded?: boolean;
  /** Failure message ("failed") or first rejection reason ("rejected"), for lastSummary. */
  detail?: string;
  /** The reviewer's pi run, for usage folding into the loop totals — absent when no review
   * ran (gate disabled, exempt diff, or an already-approved HEAD). */
  run?: PiRunResult;
}

/** Run the adversarial review gate over everything ahead of main in `wt` and update `state`
 * accordingly. Shared by the tick path (after commitAll) and leftover recovery
 * (leftover.ts's recoverLeftover) — every path
 * that can move a commit into main routes through here, so no crash or abort path smuggles
 * unreviewed work in:
 * - gate disabled, or an already-approved HEAD, or an exempt (doc-only) diff → merge as-is;
 * - approve → record lastApprovedHead and discard the reviewer's stray working-tree edits
 *   (its only output channel is the verdict);
 * - reject → reset the branch to main, record reasons in state.lastReview (injected into the
 *   role's next tick prompt), log review_rejected;
 * - fail with an unparseable reply (the reviewer ran to completion but emitted no VERDICT) →
 *   leave the commit on the branch for the next tick's re-review, counting consecutive
 *   failures per HEAD; past REVIEW_FAILURE_LIMIT discard the leftover with a warning.
 * - fail because the run itself failed (transport/spawn/timeout, pi.ok false) → leave the
 *   commit and do NOT advance the count: the reviewer never judged the diff, so the failure
 *   is evidence about the backend, never about the commit (BUGS.md 2026-09-20). Never throws.
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

  // `let` because a build-fix run may commit on top of it: everything downstream (lastReview,
  // events, lastApprovedHead, verifiedHead) must name the tree the verdict actually judged.
  let head = await headOf(wt, "HEAD");

  // The one reject path: every rejection of this HEAD — deterministic build-check failure or
  // model verdict — shares this bookkeeping. Record lastReview (injected into the role's next
  // tick prompt), reset the failure count (a verdict about this HEAD is a successful review
  // either way), discard the branch by resetting it to main, and log review_rejected.
  // Callers attach `run` when a pi run was consumed.
  const reject = async (reasons: string[], durationMs?: number): Promise<GateResult> => {
    state.lastReview = { verdict: "reject", reasons, head, at: Date.now() };
    state.unreviewFailures = 0;
    await resetWorktreeToMain(wt, mainBranch);
    logEvent(root, {
      loop: role,
      type: "review_rejected",
      head,
      reasons,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
    return { decision: "rejected", detail: reasons[0] ?? "no reasons given" };
  };

  // Already reviewed this exact HEAD (e.g. a merge_blocked retry): do not burn another run.
  if (state.lastApprovedHead === head) return { decision: "approved" };

  const files = await aheadOfMainFiles(wt, mainBranch);
  if (isExemptDiff(files, config.review.exemptPaths)) {
    // The exemption is a fast path, not a blind eye: an md-only diff that moves a bug to
    // Fixed must have its fix's symbols on this tree, or it records code that does not
    // exist (BUGS.md 2026-09-22 — 9cea8c3 landed a Fix paragraph naming runScriptGroup
    // and signalTree with no source behind it). A deterministic rejection, like the
    // pre-check below: no pi run consumed, reasons injected into the author's next tick.
    const falseFix = await falseFixReason(wt, mainBranch, files);
    if (falseFix) return reject([falseFix]);
    return { decision: "exempt" };
  }

  // Deterministic build pre-check — after BOTH early returns above (an md-only diff cannot
  // break the build) and before any reviewer run or the phase/event that would show
  // "reviewing": a deterministic rejection never shows as reviewing on the dashboards. Both
  // gate callers (the tick path and leftover.ts's recoverLeftover) get it for free. The run
  // itself (build_check event, environmental-skip warning) lives in runScopedBuildCheck,
  // shared with the landing path's in-lock re-check.
  // Named in the reviewer's prompt when the pre-check ran green: the model reviewer then spends
  // its run on what a passing suite cannot show instead of re-running `npm test` itself.
  let verifiedByHarness: string | undefined;
  // The head the pre-check just verified (see GateResult.verifiedHead) — handed to the landing
  // path, which owns the baseline seeding for the SHA that actually becomes main.
  let verifiedHead: string | undefined;
  // A build-fix run the gate spent (see GateResult.fixRun) — set once, carried on EVERY
  // subsequent return so its spend folds no matter how the gate then decided.
  let fixRun: PiRunResult | undefined;
  // The commit(s) that run left on the branch, named in the reviewer's prompt: the diff below
  // now carries a harness-authored change the author's summary and body cannot claim, and an
  // unexplained one reads as unclaimed scope (BUGS.md 2026-09-23 — b020f67 turned dry's check
  // green and the reviewer rejected the landing for it).
  let buildFix: BuildFixCommit | undefined;
  const preCheck = await runScopedBuildCheck(
    root,
    role,
    "gate",
    wt,
    config,
    ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS,
  );
  if (preCheck) {
    const { check, outcome } = preCheck;
    if (outcome.status === "failed") {
      // Machine-generated reasons: the headline joined to the rest of the clipped tail (so the
      // compiler error sits right after it in the injected next-tick note). The headline is
      // failureHeadline's — the first line that is not a stack frame — not outputTail[0]: a
      // suite that dies on an unhandled rejection opens mid-stack, and naming the frame tells
      // the author where it broke, never what (BUGS.md 2026-09-19). The rejection itself routes
      // through the shared reject path — no pi run consumed, unreviewFailures resetting exactly
      // like a model reject.
      const tail = outcome.outputTail ?? [];
      const headline = failureHeadline(tail);
      const what = describeCheck(check);
      const reasons =
        headline !== undefined
          ? [`build check failed (${what}): ${headline}`, ...tail.filter((l) => l !== headline)]
          : [`build check failed (${what})`];
      // One bounded fix run before rejecting: a red tree otherwise rejects every queued
      // landing for a failure none of their authors caused. The run edits the worktree; the
      // harness commits whatever it produced. Its spend folds through GateResult.fixRun on
      // EVERY outcome it reached — abort, no-change reject, still-red reject, and approval
      // alike — so accounting never drops a consumed run.
      const fixPi = await runPi({
        cwd: wt,
        prompt: buildBuildFixPrompt(role, describeCheck(check), reasons),
        config: reviewConfig(config),
        sessionDir: reviewSessionDir(root, role),
        sessionName: `tumwater-buildfix-${role}-${ctx.tick}${ctx.sessionSuffix ?? ""}`,
        rawLogFile: piLogPath(root, role),
        label: "build-fix",
        signal: ctx.signal,
        onToolCallStalled: (message) => warnEvent(root, role, message),
      });
      if (fixPi.aborted) {
        // Shutdown mid-fix: fail closed — the (still-failing) commit stays on the branch and
        // the ref with it; the next tick re-lands it through this same gate.
        return { decision: "failed", aborted: true, fixRun: fixPi };
      }
      fixRun = fixPi;
      if ((await git(wt, "status", "--porcelain")).trim() === "") {
        // No changes: the fix run had nothing to offer — reject exactly as before, one run
        // spent, no retry loop.
        return { ...(await reject(reasons)), fixRun };
      }
      const authorHead = head;
      head = await commitAll(wt, `tumwater(${role}): fix failing build check`);
      const recheck = await runScopedBuildCheck(
        root,
        role,
        "gate",
        wt,
        config,
        ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS,
      );
      if (recheck && recheck.outcome.status === "failed") {
        return {
          ...(await reject([...reasons, "the fix attempt did not turn the check green"])),
          fixRun,
        };
      }
      if (recheck && recheck.outcome.status === "passed") {
        // The fix turned the check green: this exact tree just went green under the declared
        // check — carry it to the landing path the way an initial pass would.
        verifiedHead = head;
        verifiedByHarness = `${describeCheck(recheck.check)} (the project's declared check) passed`;
      }
      // A skipped re-check (environmental) proceeds like an initial skip: unverified tree, the
      // model reviewer and the landing path's own in-lock check still stand behind it. Either
      // way the reviewer is told which commit the harness added and why (see buildFix above).
      buildFix = await buildFixCommit(wt, authorHead, head, reasons, recheck?.outcome.status === "passed");
    }
    if (outcome.status === "passed") {
      // Passed: this exact tree just went green under the project's own declared check. Hand
      // the verdict to the landing path via verifiedHead — it seeds the red-main baseline with
      // the SHA that actually becomes main (the rebased head, which may differ from `head`),
      // so every role's next fresh tick is a cache hit instead of one redundant full-suite
      // re-run on an already-verified tree.
      verifiedHead = head;
      verifiedByHarness = `${describeCheck(check)} (the project's declared check) passed`;
    }
  }

  logEvent(root, { loop: role, type: "review_start", head });
  // Persist the phase BEFORE the run so a dashboard mid-review shows "reviewing" and a crash
  // mid-review is distinguishable from a crash mid-author-run on resume (stray edits are the
  // reviewer's then, not the author's). Cleared at tick end alongside `running`.
  state.phase = "review";
  saveLoopState(root, state);

  const diff = await aheadOfMainDiff(wt, mainBranch);
  // The reviewer run's wall time rides on its verdict event: a reviewer that takes an hour per
  // merge on local hardware is a fleet-level cost an operator must be able to see.
  const reviewStartedAt = Date.now();
  // The author's claimed WHY/RISK/VERIFIED ride along when present — checking those claims
  // against the actual diff is exactly the adversarial angle (recovery landings reconstruct
  // them from the pinned commit's message).
  const pi = await runPi({
    cwd: wt,
    prompt: buildReviewPrompt(
      diff,
      summary,
      commitBody,
      readPrinciples(root),
      highFriction,
      verifiedByHarness,
      undefined,
      buildFix,
    ),
    config: reviewConfig(config),
    // Fresh session every time (no --continue): the reviewer must not inherit the author's
    // context. Unique name per run — a fixed name would let pi resume an old review's
    // context; old files are cleaned by the age-based prune at orchestrator start.
    sessionDir: reviewSessionDir(root, role),
    sessionName: `tumwater-review-${role}-${ctx.tick}${ctx.sessionSuffix ?? ""}`,
    rawLogFile: piLogPath(root, role),
    // Label this run in the shared transcript (src/ui/transcript.ts renders it as
    // `── review @ <ts> ──`) so an operator can tell reviewer runs from author ticks.
    label: "review",
    signal: ctx.signal,
    // A stalled tool call during review hangs the gate just like one during authoring —
    // name it in the event feed while the quiet watchdog still counts down.
    onToolCallStalled: (message) => warnEvent(root, role, message),
  });

  if (pi.aborted) {
    // Shutdown mid-review: fail closed without bookkeeping — the commit stays on the branch
    // and the resumed/following tick re-reviews it via the combined ahead-of-main diff.
    return { decision: "failed", aborted: true, run: pi, fixRun };
  }

  const verdict = parseVerdict(pi.verdictText ?? "");
  if (!verdict) {
    const message = pi.errorMessage ?? "no parseable VERDICT line in the reviewer's reply";
    logEvent(root, { loop: role, type: "review_failed", head, message, durationMs: Date.now() - reviewStartedAt });
    // A run that FAILED (`ok` false: transport error, failed spawn, timeout) produced no
    // reply, so it is evidence about the backend, not about the diff. Leave the commit for
    // the next tick's re-review and do not advance the per-HEAD discard counter — a dead
    // reviewer must never destroy committed work (BUGS.md 2026-09-20). Only a run that
    // completed and replied without a parseable VERDICT is a strike against this HEAD.
    if (!pi.ok) {
      state.lastReview = { verdict: "failed", reasons: [message], head, at: Date.now() };
      return { decision: "failed", detail: message, run: pi, fixRun };
    }
    // Consecutive failures of THIS HEAD only: a new commit (new HEAD) starts fresh. Read
    // *before* overwriting lastReview with this failure.
    const prev = state.lastReview;
    const sameHead = prev?.verdict === "failed" && prev.head === head;
    state.unreviewFailures = (sameHead ? (state.unreviewFailures ?? 0) : 0) + 1;
    state.lastReview = { verdict: "failed", reasons: [message], head, at: Date.now() };
    let discarded = false;
    if ((state.unreviewFailures ?? 0) >= REVIEW_FAILURE_LIMIT) {
      await resetWorktreeToMain(wt, mainBranch);
      state.unreviewFailures = 0; // The HEAD is gone; nothing left to count against.
      discarded = true;
      warnEvent(root, role, `discarding unreviewed leftover after ${REVIEW_FAILURE_LIMIT} failed reviews (${shortSha(head)})`);
    }
    return { decision: "failed", detail: message, run: pi, fixRun, ...(discarded ? { discarded: true } : {}) };
  }

  if (verdict.verdict === "reject") {
    const rejected = await reject(verdict.reasons, Date.now() - reviewStartedAt);
    return { ...rejected, run: pi, fixRun };
  }

  // Approve: record the reviewed HEAD and discard any stray working-tree edits the reviewer
  // made while reading around — its only output channel is the verdict.
  state.lastApprovedHead = head;
  state.lastReview = { verdict: "approve", reasons: verdict.reasons, head, at: Date.now() };
  state.unreviewFailures = 0;
  await git(wt, "reset", "--hard", "HEAD");
  logEvent(root, {
    loop: role,
    type: "review_verdict",
    head,
    reason: verdict.reasons[0],
    durationMs: Date.now() - reviewStartedAt,
  });
  return { decision: "approved", run: pi, verifiedHead, fixRun };
}
