// vocabulary: plain
/** The review gate's deterministic build pre-check — split out of review.ts so the gate keeps
 * one responsibility (running the model reviewer and acting on its verdict) while this module
 * owns the pre-review verification: the one scoped build-check run, its flake re-run, the
 * sleep-unverified and main-red attributions. No model
 * runs here — everything is decided by the project's declared check, so a deterministic
 * rejection never shows as "reviewing" on the dashboards and consumes no reviewer budget. */

import type { ReviewContext, GateResult } from "./review.js";
import type { RunnerState } from "../runner/runner-state.js";
import { warnEventBestEffort } from "../events/events.js";
import { BUILD_CHECK_TIMEOUT_MS } from "../build/build-check-detect.js";
import { runScopedBuildCheck } from "../build/build-check-scoped.js";
import { checkFailureReasons, describeCheck, failureHeadline } from "../build/build-check-report.js";
import { sleptPhrase, UNVERIFIED_TREE, unverifiedTreeOutcome } from "../build/build-check-events.js";
import { sampleSleepClock } from "../build/host-sleep.js";
import { recordReview } from "../tick/tick-apply.js";
import { mainRedNotMine } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { checkWaitStage, setMergeStage } from "../merge/merge-slot.js";
import { mainTipVerdict } from "../baseline/main-red.js";
import { onlyKnownMainFailures } from "../baseline/main-watch.js";
import { FLAKY_WARNING_PREFIX, isKnownFlake, quarantineTests } from "./known-flakes.js";

/** What the pre-check decided: either the gate is resolved without a reviewer run
 * (`resolved` — a deterministic rejection, failure, or unverified tree) or the tree passed
 * and the reviewer run may proceed, carrying the verified head. */
interface GatePrecheckResult {
  /** Set when the pre-check alone resolved the gate; the caller returns it verbatim. */
  resolved?: GateResult;
  /** The head the pre-check just verified (see GateResult.verifiedHead) — handed to the
   * merge path, which owns the baseline seeding for the SHA that actually becomes main. */
  verifiedHead?: string;
  /** Set when the gate check failed only main's known failures (the watch's, via
   * onlyKnownMainFailures): the change goes on to review unverified by a green run, and the
   * reviewer's prompt names these as main's. */
  knownMainFailures?: string[];
}

/** Run the gate's deterministic build pre-check. `reject` is the gate's one shared rejection
 * path (review.ts's reject closure): the pre-check routes a reproduced failure through it so
 * the bookkeeping (lastReview, branch reset, review_rejected event) cannot drift from the
 * model-verdict path. */
export async function gateBuildPrecheck(
  ctx: ReviewContext,
  state: RunnerState,
  head: string,
  reject: (reasons: string[], durationMs?: number) => Promise<GateResult>,
): Promise<GatePrecheckResult> {
  const { root, role, wt, mainBranch, config } = ctx;
  // The merge cell's stage (a no-op outside a queued merge — see setMergeStage): the
  // pre-check, its one re-run, and any attribution check behind them are the gate's first
  // long phase.
  setMergeStage(root, role, "build-check");
  // The gate's one check invocation — the pre-check and its one flake re-run below are the
  // same run in the same scope, worktree, and config with the same resolved timeout, so the
  // scope and timeout resolution live here once and cannot drift between the two calls.
  const runGateCheck = () =>
    runScopedBuildCheck(
      root,
      role,
      "gate",
      wt,
      config,
      ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS,
      ctx.sampleSleep ?? sampleSleepClock,
      undefined,
      checkWaitStage(root, [role]),
    );
  const preCheck = await runGateCheck();
  if (preCheck) {
    const { check } = preCheck;
    let { outcome } = preCheck;
    if (outcome.status === "failed") {
      // A failure that does not reproduce on one immediate re-run is a flake, not a red tree:
      // the suite has load-sensitive assertions, and most failures the gate met on the loaded
      // host were exactly that (BUGS.md 2026-09-23). The re-run is one more check, priced as
      // its own build_check event; if it passes, the tree is verified exactly like a
      // first-time pass and the flake is named in a warning (the headline clusters in the
      // digest, so telemetry and bugfix can go after the flaky test). A re-run that fails
      // again goes to attribution below; a skipped one says nothing about the tree, so the
      // first failure stands.
      // A failure naming only known tests (main's, or quarantined) is judged below as it stands:
      // a re-run could only repeat it.
      const retry = onlyKnownMainFailures(root, outcome.failingTests) ? undefined : await runGateCheck();
      if (retry?.outcome.status === "passed") {
        // When the failed run spanned a host sleep, the pass says the tree is fine and the
        // sleep is the story — not a flaky test (BUGS.md 2026-09-30): the digest clusters
        // these warnings, and a sleep is weather, not an assertion to hunt.
        if (unverifiedTreeOutcome(outcome)) {
          warnEventBestEffort(root, role, sleptPhrase("gate check", outcome.run!.sleptMs!, "then passed on retry"));
        } else {
          const flaky = failureHeadline(outcome.outputTail) ?? describeCheck(check);
          warnEventBestEffort(root, role, `${FLAKY_WARNING_PREFIX}${flaky}`);
          // Each test the failed run named failed and then passed on this same tree: quarantined.
          quarantineTests(root, outcome.failingTests, outcome.outputTail);
        }
        outcome = retry.outcome;
      } else if (retry?.outcome.status === "failed") {
        outcome = retry.outcome;
      }
    }
    if (outcome.status === "failed" && unverifiedTreeOutcome(outcome)) {
      // The run spanned a host sleep past the tolerance and no clean attempt judged the tree
      // (runScopedBuildCheck already retried once): nothing here is the change's failure, so
      // the gate attributes nothing — it keeps the commit and reports the sleep, and the
      // merge path keeps the pin for a re-merge (BUGS.md 2026-09-30).
      const detail = sleptPhrase("gate check", outcome.run!.sleptMs!, UNVERIFIED_TREE);
      warnEventBestEffort(root, role, `${detail}; keeping the commit for another merge attempt`);
      return { resolved: { decision: "failed", detail, unverified: true } };
    }
    if (outcome.status === "failed") {
      // A claimed failure the gate itself already recorded as flaky within the window (its own
      // re-run passed on this exact headline) says nothing about this change: attribute nothing
      // — keep the commit and the pin, count no strike — and name the flake, exactly as the
      // host-sleep path above does. Before this, the repeat was attributed through main's
      // per-SHA baseline cache (usually a green seeded by an earlier merge), so a load- or
      // clock-sensitive test rejected whichever unrelated change hit it (BUGS.md 2026-10-06).
      // The excuse is not a failure of the gate, so the change goes on to the model review
      // instead of ending the merge attempt as review_error and paying a requeue. It carries no
      // verifiedHead — the tree was not verified — so the merge
      // path's own check still judges the tree before it reaches main.
      const flaky = failureHeadline(outcome.outputTail) ?? describeCheck(check);
      // A failure that names only tests main already fails is main's, not this change's: it goes
      // on to review with no fresh run on main. No verifiedHead — the tree did not pass, so the
      // merge path must not seed a green for it — and the merge check judges it by the same rule.
      const known = onlyKnownMainFailures(root, outcome.failingTests);
      if (known) {
        warnEventBestEffort(root, role, `gate check fails only main's known failures: ${known.join(", ")}`);
        return { knownMainFailures: known };
      }
      // The headline excuse stays for a failure that names no test: quarantine covers named ones.
      if (isKnownFlake(root, flaky)) {
        warnEventBestEffort(root, role, `known-flaky failure, merge kept: ${flaky}`);
        return {};
      }
      const reasons = checkFailureReasons(check, outcome);
      // A failure that reproduced is attributed, never fixed here: the one merge slot the
      // whole queue waits on is no place for a model run (the in-slot build-fix run this
      // replaces held it for hours and never once led to a merge — PLANS.md "Land-queue
      // speed 1/3"). The question is whose failure it is, and main's own verdict at its tip
      // answers it. A failure matching no recorded flake bypasses the per-SHA cache and runs
      // main's check now (forceFresh): a clock- or load-sensitive test can pass on an immutable
      // SHA early and fail later, so a cached green — usually seeded by an earlier merge —
      // may no longer be true, and trusting it rejected an unrelated change (BUGS.md
      // 2026-10-06). A shutdown already under way skips the question and fails closed like any
      // abort.
      if (ctx.signal?.aborted) return { resolved: { decision: "failed", aborted: true } };
      const main = await mainTipVerdict(root, role, mainBranch, config, true);
      // A check killed by that shutdown reads as a skip, never as evidence against the author.
      if (ctx.signal?.aborted) return { resolved: { decision: "failed", aborted: true } };
      if (main.status === "red") {
        // Main fails too: not this change's failure. Leave the commit (and with it the pin) and
        // do not advance the discard counter — the transport-failure rule (BUGS.md 2026-09-20):
        // nothing judged this diff. main-red.ts's gate and the bugfix handoff own the repair,
        // and the author's next tick re-merges the change once main is green again.
        const detail = mainRedNotMine(main.sha);
        recordReview(state, "failed", [detail], head);
        warnEventBestEffort(root, role, `gate check failed on ${shortSha(head)}, but ${detail}; merge kept`);
        return { resolved: { decision: "failed", detail, mainRed: true } };
      }
      // Main green: the change broke the check — rejected deterministically through the shared
      // reject path, no pi run consumed, reasons injected into the author's next tick. With no
      // verdict for main the author's failure is still the safe default, and the reasons say
      // the attribution could not be made.
      return {
        resolved: await reject(
          main.status === "green"
            ? reasons
            : [...reasons, `main's baseline was unavailable (${main.why}), so the failure is attributed to this change`],
        ),
      };
    }
    if (outcome.status === "passed") {
      // Passed: this exact tree just went green under the project's own declared check. Hand
      // the verdict to the merge path via verifiedHead — it seeds the red-main baseline with
      // the SHA that actually becomes main (the rebased head, which may differ from `head`),
      // so every role's next fresh tick is a cache hit instead of one redundant full-suite
      // re-run on an already-verified tree.
      return { verifiedHead: head };
    }
  }
  return {};
}
