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
import { checkFailureReasons, FAILING_TESTS_MAX, redCheckHeadline } from "../build/build-check-report.js";
import { sleptPhrase, UNVERIFIED_TREE, unverifiedTreeOutcome } from "../build/build-check-events.js";
import { sampleSleepClock } from "../build/host-sleep.js";
import { recordReview } from "../run/run-apply.js";
import { mainRedNotMine, mainRedNotTheseFailures, mainUncheckedNotJudged } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { checkWaitStage, setMergeStage } from "../merge/merge-slot.js";
import { mainTipFailures, namedFailures, rerunAtMainTip, watchedMainVerdict } from "../baseline/main-red.js";
import { knownMainFailures, onlyKnownMainFailures } from "../baseline/main-watch.js";
import { watchedBaseline, watchVerifiesMain } from "../baseline/main-baseline.js";
import { changeBaseRev } from "../git/git.js";
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

/** The tests a gate failure shares with the change's own base, when that base is not main's tip:
 * the main watch recorded the base red with every one of them. A branch behind a fix fails the
 * old test on its base while main's tip is green (2026-10-20, report --role), so the tip verdict
 * alone is the wrong question. Null when the failures are not all the base's, the list may have
 * been cut short (the cap onlyKnownMainFailures uses), or git cannot say. */
async function staleBaseFailures(
  wt: string,
  mainBranch: string,
  head: string,
  mainTip: string,
  failingTests: readonly string[] | undefined,
): Promise<{ base: string; tests: string[] } | null> {
  if (!failingTests || failingTests.length === 0 || failingTests.length >= FAILING_TESTS_MAX) return null;
  try {
    const base = await changeBaseRev(wt, mainBranch, head);
    if (base === mainTip) return null;
    const verdict = await watchedBaseline(wt, base);
    if (verdict?.status !== "red") return null;
    const baseFailed = verdict.failingTests ?? [];
    if (!failingTests.every((t) => baseFailed.includes(t))) return null;
    return { base, tests: [...failingTests] };
  } catch {
    return null;
  }
}

/** Whose failure a twice-failed gate check is when main is red too, from the gate's complete list
 * of failing tests and main's (`mainFailing`; each empty when it names none or may have been cut
 * short): `main` — every test the gate names is one main fails, or a known main failure; `own` —
 * it fails more than main does: the named tests main does not fail, or, when the gate named no
 * test, a failure outside main's named ones (a compile or lint error, a crash); `unknown` — main
 * names no failure the gate's can be told apart from. A red main excuses only its own failures,
 * so it never blocks a change on failures of the change's own. */
type RedAttribution = { kind: "main" } | { kind: "own"; tests: string[] } | { kind: "unknown" };

function attributeOnRedMain(root: string, failed: readonly string[], mainFailing: readonly string[]): RedAttribution {
  if (failed.length === 0) return mainFailing.length > 0 ? { kind: "own", tests: [] } : { kind: "unknown" };
  const known = new Set([...mainFailing, ...knownMainFailures(root)]);
  const own = failed.filter((t) => !known.has(t));
  if (own.length === 0) return { kind: "main" };
  return mainFailing.length > 0 ? { kind: "own", tests: own } : { kind: "unknown" };
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
      undefined,
      ctx.signal,
    );
  const preCheck = await runGateCheck();
  // A check the harness stopped on the verify's abort (a user abort or a shutdown) is not the
  // tree's verdict and not a flake: fail closed as aborted before the re-run, the quarantine
  // and the attribution — the signal fires MID-check (runScriptGroup returns an `aborted`
  // skip), and `reviewPinnedChange` settles the verify `aborted` on this result so an abort
  // never has to wait a parked check out — nor a queued one: a check still waiting for a check
  // permit when the signal fires never spawns, and settles `aborted` here too. A check that finds
  // its permit free under an already-aborted signal still runs and reaches its own verdict, caught
  // by the `aborted` checks in the attribution path below, so the pre-existing shutdown case keeps
  // its two attempts.
  if (preCheck?.outcome.skipReason === "aborted") {
    return { resolved: { decision: "failed", aborted: true } };
  }
  if (preCheck) {
    const { check } = preCheck;
    let { outcome } = preCheck;
    if (outcome.status === "failed") {
      // A failure that does not reproduce on one immediate re-run is a flake, not a red tree:
      // the suite has load-sensitive assertions, and most failures the gate met on the loaded
      // host were exactly that (BUGS.md 2026-09-23). The re-run is one more check, priced as
      // its own build_check event; if it passes, the tree is verified exactly like a
      // first-time pass and the flake is named in a warning (the headline clusters in the
      // digest, so selfcheck and bugfix can go after the flaky test). A re-run that fails
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
          const flaky = redCheckHeadline(check, outcome.outputTail);
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
      const flaky = redCheckHeadline(check, outcome.outputTail);
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
      // answers it. When the main watch verifies main, the gate runs no full check of its own:
      // the watch's verdicts answer, and a change the watch has not caught up with yet is kept
      // until it has (watchedMainVerdict). Otherwise — or when that wait timed out — main is
      // asked here (mainTipFailures): the failing tests alone are re-run on main's tip when they
      // can be, else main's full check runs fresh, bypassing the per-SHA cache, because a clock-
      // or load-sensitive test can pass on an immutable SHA early and fail later, and a cached
      // green — usually seeded by an earlier merge — rejected an unrelated change (BUGS.md
      // 2026-10-06). A shutdown already under way skips the question and fails closed like any
      // abort.
      if (ctx.signal?.aborted) return { resolved: { decision: "failed", aborted: true } };
      const base = await changeBaseRev(wt, mainBranch, head);
      const failed = { tests: namedFailures(outcome), files: outcome.failingTestFiles };
      let main = watchVerifiesMain(root, config)
        ? await watchedMainVerdict(root, role, wt, mainBranch, config, base, ctx.watchWait, failed)
        : await mainTipFailures(root, role, wt, mainBranch, config, failed);
      // A red that names no test (main's check died before its tests ran, or its list may have
      // been cut short) cannot be subtracted from the change's named failures: ask main's tip
      // about just those tests instead.
      if (main.status === "red" && namedFailures(main).length === 0 && failed.tests.length > 0) {
        main = (await rerunAtMainTip(root, role, wt, mainBranch, config, failed)) ?? main;
      }
      // A check killed by that shutdown reads as a skip, never as evidence against the author.
      if (ctx.signal?.aborted) return { resolved: { decision: "failed", aborted: true } };
      if (main.status === "awaiting") {
        // Nothing judged this diff yet: keep it with no strike — the pin stays — and name the
        // commit it waits on, so the merge pipeline re-queues it once the watch's verdict covers
        // that commit (merge-requeue.ts's requeueMainRedPin).
        const detail = mainUncheckedNotJudged(base, main.sha);
        recordReview(state, "failed", [detail], head);
        warnEventBestEffort(root, role, `gate check failed on ${shortSha(head)}, but ${detail}; merge kept`);
        return { resolved: { decision: "failed", detail, mainRed: true, awaitingWatch: base } };
      }
      // Main is red too: it excuses only its own failures. A change that fails nothing main does
      // not goes on to review exactly as a known failure does; one that fails more is judged
      // like a change on a green main, so a red main never holds back a change for a failure of
      // the change's own — main is healed in parallel by ci (main-red.ts's heal hand-offs).
      const red = main.status === "red" ? attributeOnRedMain(root, failed.tests, namedFailures(main)) : null;
      if (main.status === "red" && red?.kind === "main") {
        warnEventBestEffort(
          root,
          role,
          `gate check fails only tests main ${shortSha(main.sha)} fails too: ${failed.tests.join(", ")}; going on to review`,
        );
        return { knownMainFailures: [...failed.tests] };
      }
      if (main.status === "red" && red?.kind === "unknown") {
        // Neither check names a test, so nothing tells this failure from main's: keep the commit
        // (and with it the pin) and do not advance the discard counter — the transport-failure
        // rule (BUGS.md 2026-09-20): nothing judged this diff. The orchestrator poll
        // (requeueMainRedPin) re-queues the kept pin once main's head moves; leftover recovery
        // holds it until then.
        const detail = mainRedNotMine(main.sha);
        recordReview(state, "failed", [detail], head);
        warnEventBestEffort(root, role, `gate check failed on ${shortSha(head)}, but ${detail}; merge kept`);
        return { resolved: { decision: "failed", detail, mainRed: true } };
      }
      const own = red?.kind === "own" ? red.tests : outcome.failingTests;
      if (main.status === "green" || main.status === "red") {
        const stale = await staleBaseFailures(wt, mainBranch, head, main.sha, own);
        if (stale) {
          // Same hand-off as the known-failure branch: no verifiedHead, so the merge check on the
          // rebased tree still judges it.
          warnEventBestEffort(
            root,
            role,
            `gate check fails only tests its base ${shortSha(stale.base)} already failed, and main ${shortSha(main.sha)} is ${main.status}: ${stale.tests.join(", ")}; going on to review`,
          );
          return { knownMainFailures: main.status === "red" ? [...failed.tests] : stale.tests };
        }
      }
      // Main green, or red with fewer failures: the change broke the check — rejected
      // deterministically through the shared reject path, no pi run consumed, reasons injected
      // into the author's next run. With no verdict for main the author's failure is still the
      // safe default, and the reasons say the attribution could not be made.
      return {
        resolved: await reject(
          main.status === "green"
            ? reasons
            : main.status === "red"
              ? [...reasons, mainRedNotTheseFailures(main.sha, own ?? [])]
              : [...reasons, `main's baseline was unavailable (${main.why}), so the failure is attributed to this change`],
        ),
      };
    }
    if (outcome.status === "passed") {
      // Passed: this exact tree just went green under the project's own declared check. Hand
      // the verdict to the merge path via verifiedHead — it seeds the red-main baseline with
      // the SHA that actually becomes main (the rebased head, which may differ from `head`),
      // so every role's next fresh run is a cache hit instead of one redundant full-suite
      // re-run on an already-verified tree.
      return { verifiedHead: head };
    }
  }
  return {};
}
