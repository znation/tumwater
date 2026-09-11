import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gitTry } from "./git.js";
import { truncate } from "./text.js";

const execFileAsync = promisify(execFile);

/** The deterministic build pre-check the review gate runs before any model reviewer: detect
 * the project's declared check (an npm script — `test` preferred per npm convention, then
 * `typecheck`, then `build`) by walking up to the installed root, run it in the worktree with a
 * hard timeout, and classify the outcome. Split out of review.ts — which
 * keeps the adversarial review gate itself — because this is a self-contained concern with its
 * own data model (BuildCheck/BuildCheckOutcome), detection algorithm (walk-up to the install),
 * and execution/classification logic: deterministic process verification, distinct from the
 * model-based review. The gate (review.ts) consumes detectBuildCheck + runBuildCheck for its
 * per-merge pre-check; main-red.ts's red-main baseline gate (checkMainBaseline below) reuses
 * the same machinery to verify main itself once per SHA before an authoring run is spent on
 * top of it. clipReason/MAX_REASON_CHARS live here too — they bound one line of machine text, shared
 * by clipBuildTail and parseVerdict in review.ts — so that helper has a single home. */

/** Per-reason length cap with ellipsis — bounds one line of machine-generated or reviewer
 * text so it cannot bloat persisted state (shared by clipBuildTail here and parseVerdict in
 * review.ts). */
const MAX_REASON_CHARS = 300;

/** Cap one line of text to MAX_REASON_CHARS with an ellipsis (unchanged when it fits). */
export function clipReason(r: string): string {
  return truncate(r, MAX_REASON_CHARS);
}

// ── Detection ─────────────────────────────────────────────────────────────────────────────
// A check whose correctness must not depend on model compliance is run by the harness, not
// asked of the reviewer (plans/review-gate.md): the reviewer may not run state-changing
// commands, and `npm run build` is exactly that — type errors are invisible to a model that
// cannot compile.

/** The project's declared deterministic check: an npm script name plus the directory whose
 * package.json declares it (the walk-up target holding both package.json and node_modules). */
interface BuildCheck {
  /** Directory holding the qualifying package.json + node_modules. */
  rootDir: string;
  /** The npm script to run — `test` preferred, then `typecheck`, else `build`. */
  script: string;
}

/** How many ancestors a walk-up may climb before giving up. Five covers every layout the
 * harness sees — a tumwater worktree sits three levels under the install
 * (`<repo>/.tumwater/worktrees/<role>`) — while stopping a stray temp directory from wandering
 * into an unrelated project further up. Shared by both walk-ups below. */
const WALK_UP_LEVELS = 5;

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

/** Read the check script from `dir`'s package.json: prefer test — npm convention makes
 * `npm test` the canonical verify command — then typecheck, then build; null when none is
 * present or the file cannot be read/parsed (detection never throws). For tumwater itself
 * `test` subsumes `build`: its script runs `npm run build && node --test …`, so one gate run
 * verifies both. */
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
  if (typeof s.test === "string" && s.test) return { rootDir: dir, script: "test" };
  if (typeof s.typecheck === "string" && s.typecheck) return { rootDir: dir, script: "typecheck" };
  if (typeof s.build === "string" && s.build) return { rootDir: dir, script: "build" };
  return null;
}

/** Walk UP from `startDir` — at most `maxLevels` ancestors, starting with `startDir`
 * itself — calling `visit` on each directory and returning the first non-null result; null
 * when no level qualifies or the filesystem root is reached. The shared climb of both
 * walk-ups in this file (and the one npm's run-script PATH walk makes). */
function walkUp<T>(startDir: string, maxLevels: number, visit: (dir: string) => T | null): T | null {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level++) {
    const found = visit(dir);
    if (found !== null) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break; // Filesystem root reached.
    dir = parent;
  }
  return null;
}

/** Find the project's deterministic build check by walking UP from `startDir` — at most
 * `maxLevels` ancestors (default 5) — to the nearest directory containing BOTH a package.json
 * and a node_modules/ directory, then preferring scripts.test over scripts.typecheck and
 * scripts.build (npm convention: `test` is the canonical verify command). The
 * walk is required: tumwater worktrees live under `<repo>/.tumwater/worktrees/<role>` with no
 * install of their own (node_modules is gitignored — it exists only where someone ran npm
 * install), so a literal startDir check would silently disable the pre-check forever in
 * dogfood. The FIRST qualifying directory is the project: if its package.json has neither
 * script, there is no check (an unrelated ancestor further up must never be used). Returns
 * null when no ancestor qualifies or the file is missing/unreadable/malformed — detection
 * never throws into the gate. */
export function detectBuildCheck(startDir: string, maxLevels = WALK_UP_LEVELS): BuildCheck | null {
  const root = walkUp(startDir, maxLevels, (dir) => (hasInstall(dir) ? dir : null));
  return root === null ? null : buildCheckFrom(root);
}

/** Resolve `node_modules/<rel>` by walking UP from `startDir` — the same climb detectBuildCheck
 * makes, and the same one npm's run-script PATH walk makes: a tumwater worktree has no install
 * of its own (node_modules is gitignored, so it exists only where someone ran npm install), and
 * neither does a project nested under an installed root. Returns the first existing path, or
 * null when no ancestor within `maxLevels` has it. Assuming a local install instead is what
 * broke the fleet's own redeploy on 2026-09-08: compileStaged looked only at
 * `<root>/node_modules/typescript`, so its test could not pass in a bare worktree, the failing
 * suite made main read red, and the blocked restart stranded the fleet on a stale build
 * (BUGS.md). Never throws. */
export function resolveFromNodeModules(startDir: string, rel: string, maxLevels = WALK_UP_LEVELS): string | null {
  return walkUp(startDir, maxLevels, (dir) => {
    const candidate = path.join(dir, "node_modules", rel);
    return fs.existsSync(candidate) ? candidate : null;
  });
}

// ── Execution ─────────────────────────────────────────────────────────────────────────────

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
  /** Clipped tail of the combined output on failure — last ≤10 meaningful lines (non-blank,
   * npm banner excluded), each clipped to MAX_REASON_CHARS. */
  outputTail?: string[];
  /** Why no verdict was reached ("skipped"). */
  skipReason?: "timeout" | "no-npm";
}

/** Keep the TAIL of a build's combined output: last ≤10 meaningful lines, each via clipReason —
 * so a chatty build cannot bloat persisted state or the injected next-tick note. Blank lines
 * and npm's own script banner (`> pkg@1.0 script`, `> <command>`) are dropped: they name the
 * script that ran, not what broke in it. */
export function clipBuildTail(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^>\s/.test(l));
  return lines.slice(-10).map(clipReason);
}

/** Run `npm run <script>` in the worktree (cwd = wt), capturing combined output with a hard
 * timeout. Never throws: every outcome is classified per BuildCheckOutcome. Running a local
 * script needs no network.
 * No env manipulation is needed even though the worktree has no node_modules of its own
 * (gitignored): npm's run-script walks UP from the project path, adding EVERY level's
 * `node_modules/.bin` to the script's PATH (@npmcli/run-script setPATH), so the toolchain at
 * check.rootDir — an ancestor of wt by detectBuildCheck construction — is resolvable without
 * any help. The script still runs in wt, compiling the branch state — which is what this
 * check exists for; build-check.test.ts pins the no-node_modules-worktree resolution. */
export async function runBuildCheck(
  wt: string,
  check: BuildCheck,
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
): Promise<BuildCheckOutcome> {
  try {
    await execFileAsync("npm", ["run", check.script], {
      cwd: wt,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
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

// ── Main baseline (red-main gate) ────────────────────────────────────────────────────────
// The review gate verifies worktree = main + changes before every merge; this checks MAIN
// ITSELF — once per SHA, fleet-wide — before an authoring run is spent on top of it. A red
// main rejects every code diff deterministically at the gate (BUGS.md's nine "build/tests red
// on main" entries), so while a SHA is known red the harness skips authoring for the
// code-producing roles instead of burning runs that are guaranteed to fail (PLANS.md, "Red-
// main baseline check").

/** The fleet-shared verdict of main's own build/test suite at one SHA. */
interface MainBaseline {
  status: "green" | "red";
  /** The main HEAD this verdict covers. */
  sha: string;
  /** Red only: the script that failed. */
  script?: string;
  /** Red only: clipped failure tail (clipBuildTail) — its first line goes into the warning
   * event so an operator sees what broke without opening a transcript. */
  outputTail?: string[];
}

/** checkMainBaseline's result. `baseline` is null when nothing blocks authoring: either no
 * declared build check at all (nothing to verify → nothing to block on, consistent with the
 * gate skipping its pre-check) or an environmental skip (`skipReason` set — timeout/no-npm),
 * which the caller warns about and proceeds with, exactly like the gate's pre-check. Skips are
 * never cached red: a hung script must not wedge authoring for the life of the process. */
interface MainBaselineCheck {
  baseline: MainBaseline | null;
  /** Set when a detected check could not be run (timeout or no npm on PATH). */
  skipReason?: "timeout" | "no-npm";
}

/** Fleet-shared verdict cache, keyed by main SHA. In-memory only: after a restart the cache is
 * cold and one re-check per red SHA happens — cheap and deterministic, mirroring the budget
 * gate's stateless resume. Entries come from two sources: checkMainBaseline's own runs, and
 * noteGreenBaseline seeding a green verdict for a SHA that just became main (src/merge.ts:
 * either its in-lock post-rebase re-check passed on exactly that tree, or the rebase was a
 * no-op so the review gate's pre-check had already run green on it).
 *
 * The two verdicts are not equally trustworthy, and the cache is written accordingly. A GREEN
 * is authoritative wherever it was observed — the suite ran on this immutable tree and passed —
 * so it is never re-run and never overwritten. A RED is only provisional evidence about the
 * tree: the same SHA can fail in one worktree and pass in another when the failure is really
 * about the environment the check ran in (a worktree with no install, a half-written
 * node_modules). On 2026-09-08 exactly that happened — a role worktree's environmental red
 * became the fleet-wide verdict that blocked the harness's own restart (BUGS.md) — so a caller
 * whose false block is expensive may re-verify a red in its own worktree (`reverifyRed`), and a
 * green from that run promotes the SHA for everyone. */
const baselineCache = new Map<string, MainBaseline>();

/** In-flight dedup: concurrent ticks on the same not-yet-cached SHA (a fresh main move wakes
 * every blocked role at once) share one check run instead of racing N npm invocations. Keyed by
 * SHA for ordinary checks; a re-verification adds its worktree, because joining another
 * worktree's run would observe the wrong environment — the one thing it exists to re-test. */
const baselineInFlight = new Map<string, Promise<MainBaselineCheck>>();

/** Record a green baseline verdict for `sha` WITHOUT running anything. The sole caller is the
 * landing path (src/merge.ts's verifyLanding), which calls it with the POST-rebase head — the
 * exact SHA about to become main — in two cases: its own in-lock re-check just ran this
 * project's declared check green on that tree, or the rebase was a no-op so the review gate's
 * pre-check (which runs outside the merge lock) had already run green on exactly this tree.
 * Seeding here means that once the merge lands — main now points at this very SHA — the next
 * fresh tick's checkMainBaseline is a cache hit instead of re-running the full suite on an
 * already-verified tree: for tumwater itself that saves one redundant `npm test` (~1 min) per
 * merged code tick, plus every other role waking on "main moved" stalling behind that in-flight
 * run. Never seed a pre-rebase head: whenever main moved under the review, that SHA never
 * becomes main and the entry would silently miss (BUGS.md 2026-09-08). Safe because git trees
 * are immutable — a SHA's content cannot change under a cached verdict, the same staleness
 * semantics checkMainBaseline already has for its own entries. Only a directly observed pass
 * may seed this; skips and failures leave the baseline unknown (the caller decides). */
export function noteGreenBaseline(sha: string): void {
  baselineCache.set(sha, { status: "green", sha });
}

/** Verify main's own build/test suite at `wt`'s HEAD — which must be pristine main (the caller
 * is the fresh-tick path right after resetWorktreeToMain; a dirty or ahead worktree would
 * measure the wrong thing). Cache hit returns immediately; on miss runs detectBuildCheck +
 * runBuildCheck once per SHA (in-flight deduped) and caches green/red. Never throws: git,
 * detection, and execution failures all resolve to "nothing blocks authoring". */
export async function checkMainBaseline(
  wt: string,
  /** Called once per actual script run (never for cache hits or deduped waiters) with what ran
   * and how long it took — the caller's hook for a build_check event. */
  onRun?: (run: { outcome: BuildCheckOutcome; durationMs: number }) => void,
  /** Ignore a cached RED verdict and run the suite here instead (a cached green still short-
   * circuits — see baselineCache). For the caller whose false block is expensive enough to pay
   * one extra run: the redeploy gate, where trusting another worktree's environmental red
   * strands the whole fleet on a stale build until main moves. A green from the re-run promotes
   * the SHA fleet-wide, which unblocks the role loops too. */
  reverifyRed = false,
): Promise<MainBaselineCheck> {
  const sha = await gitTry(wt, "rev-parse", "HEAD");
  if (!sha) return { baseline: null }; // No HEAD (unborn branch) — nothing to key on.
  const cached = baselineCache.get(sha);
  if (cached && !(reverifyRed && cached.status === "red")) return { baseline: cached };
  const key = reverifyRed ? `${sha}\u0000${wt}` : sha;
  let pending = baselineInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const check = detectBuildCheck(wt);
      if (!check) return { baseline: null }; // No declared check — nothing to verify, nothing to block on.
      const startedAt = Date.now();
      const outcome = await runBuildCheck(wt, check);
      onRun?.({ outcome, durationMs: Date.now() - startedAt });
      if (outcome.status === "skipped") {
        // Environmental (timeout/no-npm): warn-and-proceed semantics like the gate's pre-check;
        // never cache red for a skip.
        return { baseline: null, skipReason: outcome.skipReason };
      }
      const baseline: MainBaseline =
        outcome.status === "passed"
          ? { status: "green", sha }
          : { status: "red", sha, script: outcome.script, outputTail: outcome.outputTail };
      // A green always lands (promoting a provisional red); a red never overwrites a green —
      // a concurrent run may have promoted this SHA while this one was still going.
      if (baselineCache.get(sha)?.status !== "green") baselineCache.set(sha, baseline);
      return { baseline };
    })();
    baselineInFlight.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    if (baselineInFlight.get(key) === pending) baselineInFlight.delete(key);
  }
}
