import { type BuildCheckOutcome, detectBuildCheck, runBuildCheck } from "./build-check.js";
import { gitTry } from "./git.js";

/** The fleet-shared verdict of main's own build/test suite at one SHA, and the one-run-per-SHA
 * machinery that produces it. Split out of build-check.ts — which keeps detecting and running
 * the project's declared check — because a verdict ABOUT a specific SHA is a different concern
 * from the mechanics of running one: this module owns the cache, the in-flight dedup, the
 * re-verification policy that keeps one worktree's environmental red from blocking the fleet,
 * and the presentation of a red's failure tail. main-red.ts's gate consumes it; merge.ts seeds
 * a green here after a post-rebase re-check; redeploy.ts re-verifies a red here before it
 * strands the fleet on a stale build. */

/** The line of a failure tail worth putting in a one-line warning. clipBuildTail keeps the LAST
 * ten meaningful lines, so a check that died on an unhandled rejection ends mid-stack and the
 * tail's FIRST line is a frame: every red-main warning logged before 2026-09-18 read
 * "main <sha> is red (test: at process.processTicksAndRejections (node:internal/...))" — where,
 * never what, which is why a false red that blocked the fleet for hours could not be diagnosed
 * from the event feed at all (BUGS.md). Prefer the first line that is not a stack frame; fall
 * back to the tail's first line when every line is one, so a caller always has something to
 * print. Frames are the only thing skipped — an assertion diff, a compiler error and a bare
 * "1) test name" all read as the headline they are. */
export function failureHeadline(tail: readonly string[] | undefined): string | undefined {
  if (!tail?.length) return undefined;
  return tail.find((line) => !/^at\s/.test(line)) ?? tail[0];
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
  /** Red only: clipped failure tail (clipBuildTail) — failureHeadline picks the line that goes
   * into the warning event so an operator sees what broke without opening a transcript. */
  outputTail?: string[];
  /** Red only: the worktrees that have independently observed this red. A red seen in ONE
   * worktree is provisional evidence about the environment as much as the tree, so it is
   * re-verified elsewhere before it blocks the fleet; two distinct worktrees agreeing makes it
   * authoritative. Never set on a green — a green is authoritative wherever it was observed. */
  redFrom?: string[];
}

/** checkMainBaseline's result. `baseline` is null when nothing blocks authoring: either no
 * declared build check at all (nothing to verify → nothing to block on, consistent with the
 * gate skipping its pre-check) or an environmental skip (`skipReason` set — timeout/no-npm/
 * broken toolchain), which the caller warns about and proceeds with, exactly like the gate's
 * pre-check. Skips are never cached red: a hung script — or a broken toolchain (BUGS.md
 * 2026-09-15) — must not wedge authoring, or the fleet's restart, for the life of the process. */
interface MainBaselineCheck {
  baseline: MainBaseline | null;
  /** Set when a detected check could not be run (timeout, no npm on PATH, or a broken toolchain). */
  skipReason?: "timeout" | "no-npm" | "toolchain";
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
 * green from that run promotes the SHA for everyone. Since 2026-09-18 that re-verification is
 * not opt-in only: a red carries the worktrees that observed it (`redFrom`) and is re-run by the
 * next DIFFERENT worktree to consult it, so a single environmental red can no longer block every
 * role until main moves — see shouldRerunRed. */
const baselineCache = new Map<string, MainBaseline>();

/** In-flight dedup: concurrent ticks on the same not-yet-cached SHA (a fresh main move wakes
 * every blocked role at once) share one check run instead of racing N npm invocations. Keyed by
 * SHA for ordinary checks; a re-verification adds its worktree, because joining another
 * worktree's run would observe the wrong environment — the one thing it exists to re-test. */
const baselineInFlight = new Map<string, Promise<MainBaselineCheck>>();

/** Should a cached RED be re-run here instead of trusted? A red says as much about the
 * environment the check ran in as about the tree — a worktree mid-install, or a machine under
 * the load the fleet deliberately creates starving a timing-sensitive test (BUGS.md's
 * load-sensitive tests entry). The role loops consult this fleet-shared cache and, before
 * 2026-09-18, trusted a red forever: one environmental red blocked every code role until main
 * moved, and main could not move, because blocking the code roles is exactly what stops it —
 * a deadlock broken only by restarting the orchestrator, since the cache is per-process.
 *
 * So a red is provisional until two DIFFERENT worktrees have seen it. The second observer pays
 * one extra suite run and a green from it promotes the SHA fleet-wide; a second red makes the
 * verdict authoritative for everyone. The cost is bounded at ONE confirmation run per SHA, not
 * one per role. `reverifyRed` still forces a run unconditionally for the redeploy gate, whose
 * false block is expensive enough to always pay for its own opinion. */
function shouldRerunRed(cached: MainBaseline, wt: string, reverifyRed: boolean): boolean {
  if (cached.status !== "red") return false;
  if (reverifyRed) return true;
  const seen = cached.redFrom ?? [];
  return seen.length < 2 && !seen.includes(wt);
}

/** Record a green baseline verdict for `sha` WITHOUT running anything. The callers are the
 * landing path (src/merge.ts's verifyLanding) and the batch lander (src/lander.ts' landBatch) —
 * both call it only after their fast-forward SUCCEEDED, with the exact SHA that just became
 * main: verifyLanding with the POST-rebase head in two cases — its own in-lock re-check just ran
 * this project's declared check green on that tree, or the rebase was a no-op so the review
 * gate's pre-check (which runs outside the merge lock) had already run green on exactly this
 * tree — and landBatch with the stacked tip when the batch's one scope-`batch` check ran green
 * on it (a skipped check seeds nothing, and a merge_blocked stack seeds nothing either).
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
  if (cached && !shouldRerunRed(cached, wt, reverifyRed)) return { baseline: cached };
  // A re-run of a red keys the in-flight map by worktree: joining another worktree's run would
  // observe the environment this run exists to re-test.
  const key = cached?.status === "red" ? `${sha}\u0000${wt}` : sha;
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
      const prior = baselineCache.get(sha);
      const priorRedFrom = prior?.status === "red" ? (prior.redFrom ?? []) : [];
      const baseline: MainBaseline =
        outcome.status === "passed"
          ? { status: "green", sha }
          : {
              status: "red",
              sha,
              script: outcome.script,
              outputTail: outcome.outputTail,
              redFrom: priorRedFrom.includes(wt) ? priorRedFrom : [...priorRedFrom, wt],
            };
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
