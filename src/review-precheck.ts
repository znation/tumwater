/** The review gate's deterministic build pre-check — split out of review.ts so the gate keeps
 * one responsibility (running the model reviewer and acting on its verdict) while this module
 * owns the pre-review verification: the one scoped build-check run, its flake re-run, the
 * sleep-unverified and main-red attributions, and the harness's own counts sentence. No model
 * runs here — everything is decided by the project's declared check, so a deterministic
 * rejection never shows as "reviewing" on the dashboards and consumes no reviewer budget. */

import type { ReviewContext, GateResult } from "./review.js";
import type { LoopState } from "./loop-state.js";
import { warnEvent } from "./events.js";
import { BUILD_CHECK_TIMEOUT_MS } from "./build-check-detect.js";
import { runScopedBuildCheck } from "./build-check.js";
import { checkFailureReasons, describeCheck, failureHeadline } from "./build-check-report.js";
import { sleptPhrase, unverifiedTreeOutcome } from "./build-check-events.js";
import { sampleSleepClock } from "./host-sleep.js";
import { recordReview } from "./tick-apply.js";
import { mainRedPhrase } from "./phrases.js";
import { shortSha } from "./text.js";
import { checkWaitStage, setLandingStage } from "./landing-slot.js";
import { mainTipVerdict } from "./main-red.js";

/** What the pre-check decided: either the gate is resolved without a reviewer run
 * (`resolved` — a deterministic rejection, failure, or unverified tree) or the tree passed
 * and the reviewer run may proceed, carrying the verified head and the harness's counts
 * sentence for the reviewer's prompt. */
interface GatePrecheckResult {
  /** Set when the pre-check alone resolved the gate; the caller returns it verbatim. */
  resolved?: GateResult;
  /** The head the pre-check just verified (see GateResult.verifiedHead) — handed to the
   * landing path, which owns the baseline seeding for the SHA that actually becomes main. */
  verifiedHead?: string;
  /** The harness's own counts sentence, named in the reviewer's prompt when the pre-check ran
   * green: the model reviewer then spends its run on what a passing suite cannot show instead
   * of re-running `npm test` itself (the prompt's no-re-run rule, and the suite-rerun tripwire
   * after the reviewer run, both key on it). */
  verifiedByHarness?: string;
}

/** Run the gate's deterministic build pre-check. `reject` is the gate's one shared rejection
 * path (review.ts's reject closure): the pre-check routes a reproduced failure through it so
 * the bookkeeping (lastReview, branch reset, review_rejected event) cannot drift from the
 * model-verdict path. */
export async function gateBuildPrecheck(
  ctx: ReviewContext,
  state: LoopState,
  head: string,
  reject: (reasons: string[], durationMs?: number) => Promise<GateResult>,
): Promise<GatePrecheckResult> {
  const { root, role, wt, mainBranch, config } = ctx;
  // The landing cell's stage (a no-op outside a queued landing — see setLandingStage): the
  // pre-check, its one re-run, and any attribution check behind them are the gate's first
  // long phase.
  setLandingStage(root, role, "build-check");
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
      const retry = await runGateCheck();
      if (retry?.outcome.status === "passed") {
        // When the failed run spanned a host sleep, the pass says the tree is fine and the
        // sleep is the story — not a flaky test (BUGS.md 2026-09-30): the digest clusters
        // these warnings, and a sleep is weather, not an assertion to hunt.
        if (unverifiedTreeOutcome(outcome)) {
          warnEvent(root, role, sleptPhrase("gate check", outcome.run!.sleptMs!, "then passed on retry"));
        } else {
          const flaky = failureHeadline(outcome.outputTail) ?? describeCheck(check);
          warnEvent(root, role, `gate check failed then passed on retry — flaky: ${flaky}`);
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
      // landing path keeps the pin for a re-land (BUGS.md 2026-09-30).
      const detail = sleptPhrase("gate check", outcome.run!.sleptMs!, "the tree is unverified");
      warnEvent(root, role, `${detail}; keeping the commit for a re-land`);
      return { resolved: { decision: "failed", detail, unverified: true } };
    }
    if (outcome.status === "failed") {
      const reasons = checkFailureReasons(check, outcome);
      // A failure that reproduced is attributed, never fixed here: the one landing slot the
      // whole queue waits on is no place for a model run (the in-slot build-fix run this
      // replaces held it for hours and never once led to a landing — PLANS.md "Land-queue
      // speed 1/3"). The question is whose failure it is, and main's own verdict at its tip
      // answers it — usually a cache hit, since every landing seeds the SHA it moved main to.
      // A shutdown already under way skips the question and fails closed like any abort.
      if (ctx.signal?.aborted) return { resolved: { decision: "failed", aborted: true } };
      const main = await mainTipVerdict(root, role, mainBranch, config);
      // A check killed by that shutdown reads as a skip, never as evidence against the author.
      if (ctx.signal?.aborted) return { resolved: { decision: "failed", aborted: true } };
      if (main.status === "red") {
        // Main fails too: not this change's failure. Leave the commit (and with it the pin) and
        // do not advance the discard counter — the transport-failure rule (BUGS.md 2026-09-20):
        // nothing judged this diff. main-red.ts's gate and the bugfix handoff own the repair,
        // and the author's next tick re-lands the change once main is green again.
        const detail = `${mainRedPhrase(main.sha)} — not this change's failure`;
        recordReview(state, "failed", [detail], head);
        warnEvent(root, role, `gate check failed on ${shortSha(head)}, but ${detail}; landing kept`);
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
      // the verdict to the landing path via verifiedHead — it seeds the red-main baseline with
      // the SHA that actually becomes main (the rebased head, which may differ from `head`),
      // so every role's next fresh tick is a cache hit instead of one redundant full-suite
      // re-run on an already-verified tree.
      // The counts are the harness's own reading of the runner's summary (parseTestCounts):
      // attesting them here means neither the author nor the reviewer states a total, which is
      // where most record-claim rejections came from (PLANS.md 2026-09-29).
      return {
        verifiedHead: head,
        verifiedByHarness: outcome.counts
          ? `${describeCheck(check)} (the project's declared check) passed — ${outcome.counts.pass} pass, ${outcome.counts.fail} fail, ${outcome.counts.skipped} skipped of ${outcome.counts.tests}`
          : `${describeCheck(check)} (the project's declared check) passed`,
      };
    }
  }
  return {};
}
