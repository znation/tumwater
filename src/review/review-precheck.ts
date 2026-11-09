/** The review gate's deterministic build pre-check — split out of review.ts so the gate keeps
 * one responsibility (running the model reviewer and acting on its verdict) while this module
 * owns the pre-review verification: the one scoped build-check run, its flake re-run, the
 * sleep-unverified and main-red attributions. No model
 * runs here — everything is decided by the project's declared check, so a deterministic
 * rejection never shows as "reviewing" on the dashboards and consumes no reviewer budget. */

import type { ReviewContext, GateResult } from "./review.js";
import { abortedGateResult } from "./gate-result.js";
import type { RunnerState } from "../runner/runner-state.js";
import { warnEventBestEffort } from "../events/events.js";
import { BUILD_CHECK_TIMEOUT_MS } from "../build/build-check-detect.js";
import { runScopedBuildCheck } from "../build/build-check-scoped.js";
import { checkFailureReasons, FAILING_TESTS_MAX, redCheckHeadline } from "../build/build-check-report.js";
import { sleptPhrase, UNVERIFIED_TREE, unverifiedTreeOutcome } from "../build/build-check-events.js";
import { sampleSleepClock } from "../build/host-sleep.js";
import { mainRedNotTheseFailures } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { checkWaitStage, setMergeStage } from "../merge/merge-slot.js";
import { mainTipFailures, mainTipGateVerdict, namedFailures, rerunAtMainTip } from "../baseline/main-red.js";
import { knownMainFailures, onlyKnownMainFailures } from "../baseline/main-watch.js";
import { watchedBaseline } from "../baseline/main-baseline.js";
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

/** The prefix a policy scan gives each offender as its own failing test (`violation <file>:<line>
 * (<kind>)`, test/comment-width.test.ts and its three siblings). A base verdict saved before that
 * naming carries only the scan's aggregate title, so its offender subtests cannot match by name;
 * treating those as gaps would reject a branch for its base's own offender. */
const POLICY_OFFENDER_TEST_PREFIX = "violation ";

/** The tests a gate failure shares with the change's own base, when that base is not main's tip:
 * the main watch recorded the base red with every one of them. A branch behind a fix fails the
 * old test on its base while main's tip is green (2026-10-20, report --role), so the tip verdict
 * alone is the wrong question. Null when the failures are not all the base's, the list may have
 * been cut short (the cap onlyKnownMainFailures uses), or git cannot say. A base verdict saved
 * before policy scans named their offenders has only the aggregate title; then compare the
 * names that verdict can hold and let its scan's offender subtests through, today's name-only
 * behaviour. */
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
    const baseNamesOffenders = baseFailed.some((t) => t.startsWith(POLICY_OFFENDER_TEST_PREFIX));
    const comparable = baseNamesOffenders
      ? [...failingTests]
      : failingTests.filter((t) => !t.startsWith(POLICY_OFFENDER_TEST_PREFIX));
    if (comparable.length === 0 || !comparable.every((t) => baseFailed.includes(t))) return null;
    return { base, tests: comparable };
  } catch {
    return null;
  }
}

/** Whose failure a twice-failed gate check is when main is red too, from the gate's complete list
 * of failing tests and main's (`mainFailing`; each empty when it names none or may have been cut
 * short): `main` — every test the gate names is one main fails, or a known main failure; `own` —
 * it fails more than main does: the named tests main does not fail. A nameless check never reaches
 * here: it is decided by running the gate command at main's tip (mainTipGateVerdict), so a red
 * that names no failure cannot make the change's failure indistinguishable. A red main excuses
 * only its own failures, so it never blocks a change on failures of the change's own. */
type RedAttribution = { kind: "main" } | { kind: "own"; tests: string[] };

function attributeOnRedMain(root: string, failed: readonly string[], mainFailing: readonly string[]): RedAttribution {
  const known = new Set([...mainFailing, ...knownMainFailures(root)]);
  const own = failed.filter((t) => !known.has(t));
  return own.length === 0 ? { kind: "main" } : { kind: "own", tests: own };
}

/** The one scoped gate build-check run: the pre-check and its flake re-run are the same call in
 * the same scope, worktree, and config, so a result is the check plus its outcome. */
type GateCheckRun = NonNullable<Awaited<ReturnType<typeof runScopedBuildCheck>>>;
type GateOutcome = GateCheckRun["outcome"];
/** Main's tip verdict on the attribution question (main-red.ts's MainTipVerdict, kept private
 * there): green, red (with its failing tests), or unavailable (with why). */
type MainTip = Awaited<ReturnType<typeof mainTipFailures>>;
/** The gate's one shared rejection path (review.ts's reject closure). */
type GateReject = (reasons: string[], durationMs?: number) => Promise<GateResult>;

/** The failed check's one re-run, and when it changes the verdict: a failure naming only known
 * tests (main's, or quarantined) is judged as it stands — a re-run could only repeat it; a
 * passing re-run warns the flake (or the host sleep that is the real story, BUGS.md 2026-09-30)
 * and quarantines the named tests, then the tree is verified like a first-time pass; a re-run
 * that fails again stands in for the first outcome; a skipped re-run says nothing, so the first
 * failure stands. */
async function retriedGateOutcome(
  root: string,
  role: string,
  check: GateCheckRun["check"],
  outcome: GateOutcome,
  runGateCheck: () => Promise<GateCheckRun | null>,
): Promise<GateOutcome> {
  if (outcome.status !== "failed") return outcome;
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
    return retry.outcome;
  }
  if (retry?.outcome.status === "failed") return retry.outcome;
  return outcome;
}

/** A failure that spanned a host sleep past the tolerance, with no clean attempt to judge the
 * tree (runScopedBuildCheck already retried once): nothing here is the change's failure, so the
 * gate attributes nothing — it keeps the commit and reports the sleep, and the merge path keeps
 * the pin for a re-merge (BUGS.md 2026-09-30). Null when the outcome is not such a failure. */
function unverifiedSleepResult(
  root: string,
  role: string,
  outcome: GateOutcome,
): GatePrecheckResult | null {
  if (outcome.status === "failed" && unverifiedTreeOutcome(outcome)) {
    const detail = sleptPhrase("gate check", outcome.run!.sleptMs!, UNVERIFIED_TREE);
    warnEventBestEffort(root, role, `${detail}; keeping the commit for another merge attempt`);
    return { resolved: { decision: "failed", detail, unverified: true } };
  }
  return null;
}

/** A failed check the gate itself already knows is not the change's: one naming only tests main
 * already fails goes on to review as a known main failure (no fresh run on main), and a headline
 * the gate recorded as flaky within the window keeps the merge. The excuse is not a failure of
 * the gate — no verifiedHead is carried, so nothing records a green for the tree — so the change
 * goes on to the model review instead of ending the merge attempt as review_error
 * and paying a requeue (BUGS.md 2026-10-06). Null when neither arm fires. */
function knownFailureResult(
  root: string,
  role: string,
  check: GateCheckRun["check"],
  outcome: GateOutcome,
): GatePrecheckResult | null {
  const flaky = redCheckHeadline(check, outcome.outputTail);
  // A failure that names only tests main already fails is main's, not this change's: it goes
  // on to review with no fresh run on main. No verifiedHead — the tree did not pass, so nothing
  // records a green for it.
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
  return null;
}

/** What main's tip says about a twice-failed check's named tests — the attribution question,
 * answered by running something on main's tip, never by waiting on the main watch: named
 * failures are re-run alone on main's tip when they can be (mainTipFailures), else main's full
 * check runs fresh, bypassing the per-SHA cache, because a clock- or load-sensitive test can
 * pass on an immutable SHA early and fail later, and a cached green — usually seeded by an
 * earlier merge — rejected an unrelated change (BUGS.md 2026-10-06). A failure that names no
 * test runs the gate command itself at main's tip (mainTipGateVerdict). */
async function mainVerdictForFailure(
  ctx: ReviewContext,
  failed: { tests: string[]; files: Record<string, string> | undefined },
): Promise<MainTip> {
  const { root, role, mainBranch, config, wt } = ctx;
  // A nameless failure (a compile or lint error, a crash) is decided by the gate command
  // itself at main's tip. A named one is asked about by re-running only those tests there,
  // and only falls back to main's full check when they cannot be re-run.
  let main =
    failed.tests.length === 0
      ? await mainTipGateVerdict(root, role, mainBranch, config)
      : await mainTipFailures(root, role, wt, mainBranch, config, failed);
  // A red that names no test (main's check died before its tests ran, or its list may have
  // been cut short) cannot be subtracted from the change's named failures: ask main's tip
  // about just those tests instead.
  if (main.status === "red" && namedFailures(main).length === 0 && failed.tests.length > 0) {
    main = (await rerunAtMainTip(root, role, wt, mainBranch, config, failed)) ?? main;
  }
  return main;
}

/** The nameless-failure decision — a compile or lint error, a crash — from the gate command's
 * own verdict at main's tip: green there convicts the change (rejected through the shared
 * reject path); red there makes the failure main's, whatever test names either side printed, so
 * the change goes on to review; an unavailable verdict cannot attribute it, so the author's
 * failure is the safe default and the reasons say the baseline could not be had. */
async function namelessFailureResult(
  root: string,
  role: string,
  main: MainTip,
  reasons: string[],
  reject: GateReject,
): Promise<GatePrecheckResult> {
  if (main.status === "green") return { resolved: await reject(reasons) };
  if (main.status === "red") {
    warnEventBestEffort(
      root,
      role,
      `gate check fails on main ${shortSha(main.sha)} too, with no test named; going on to review`,
    );
    return {};
  }
  return {
    resolved: await reject([
      ...reasons,
      `main's baseline was unavailable (${main.why}), so the failure is attributed to this change`,
    ]),
  };
}

/** A named failure's decision from main's tip verdict: main is red only to excuse its own
 * failures (attributeOnRedMain), so a change that fails nothing main does not goes on to review
 * as a known main failure, and one that fails more is judged like a change on a green main — a
 * red main never holds back a change for a failure of the change's own (main is healed in
 * parallel by ci, main-red.ts's heal hand-offs). A failure whose base already failed, on a main
 * tip green or red, is the base's (staleBaseFailures) and goes on to review the same way;
 * otherwise the change broke the check and is rejected deterministically through the shared
 * reject path, no pi run consumed, reasons injected into the author's next run. */
async function namedFailureResult(
  ctx: ReviewContext,
  head: string,
  failed: { tests: string[] },
  outcome: GateOutcome,
  main: MainTip,
  reasons: string[],
  reject: GateReject,
): Promise<GatePrecheckResult> {
  const { root, role, wt, mainBranch } = ctx;
  const red = main.status === "red" ? attributeOnRedMain(root, failed.tests, namedFailures(main)) : null;
  if (main.status === "red" && red?.kind === "main") {
    warnEventBestEffort(
      root,
      role,
      `gate check fails only tests main ${shortSha(main.sha)} fails too: ${failed.tests.join(", ")}; going on to review`,
    );
    return { knownMainFailures: [...failed.tests] };
  }
  const own = red?.kind === "own" ? red.tests : outcome.failingTests;
  if (main.status === "green" || main.status === "red") {
    const stale = await staleBaseFailures(wt, mainBranch, head, main.sha, own);
    if (stale) {
      // Same hand-off as the known-failure branch: no verifiedHead, so nothing records a green
      // for the rebased tree.
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
  return { resolved: await reject(rejectionReasons(reasons, main, own)) };
}

/** The three-arm final rejection reasons: on a green main, the check's own reasons; on a red
 * main, those plus which failures are the change's own (mainRedNotTheseFailures); with no
 * verdict for main, those plus that the baseline could not be had and the failure is the
 * change's. Same text and order as the original attribution. */
function rejectionReasons(
  reasons: string[],
  main: MainTip,
  own: readonly string[] | undefined,
): string[] {
  if (main.status === "green") return reasons;
  if (main.status === "red") return [...reasons, mainRedNotTheseFailures(main.sha, own ?? [])];
  return [...reasons, `main's baseline was unavailable (${main.why}), so the failure is attributed to this change`];
}

/** Run the gate's deterministic build pre-check. `reject` is the gate's one shared rejection
 * path (review.ts's reject closure): the pre-check routes a reproduced failure through it so
 * the bookkeeping (lastReview, branch reset, review_rejected event) cannot drift from the
 * model-verdict path. */
export async function gateBuildPrecheck(
  ctx: ReviewContext,
  _state: RunnerState,
  head: string,
  reject: (reasons: string[], durationMs?: number) => Promise<GateResult>,
): Promise<GatePrecheckResult> {
  const { root, role, wt, config } = ctx;
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
  if (!preCheck) return {};
  // A check the harness stopped on the verify's abort (a user abort or a shutdown) is not the
  // tree's verdict and not a flake: fail closed as aborted before the re-run, the quarantine
  // and the attribution — the signal fires MID-check (runScriptGroup returns an `aborted`
  // skip), and `reviewPinnedChange` settles the verify `aborted` on this result so an abort
  // never has to wait a parked check out — nor a queued one: a check still waiting for a check
  // permit when the signal fires never spawns, and settles `aborted` here too. A check that
  // finds its permit free under an already-aborted signal still runs and reaches its own
  // verdict, caught by the abort check after its retry below, so the pre-existing shutdown case
  // keeps its two attempts.
  if (preCheck.outcome.skipReason === "aborted") {
    return { resolved: abortedGateResult() };
  }
  const { check, outcome } = preCheck;
  const settled = await retriedGateOutcome(root, role, check, outcome, runGateCheck);
  // An abort that fired while the check ran is authoritative over whatever it decided
  // (BUGS.md 2026-11-08): a user abort or shutdown kills a check still running (skipReason
  // "aborted", above), but under load the kill can land after the check's own subprocess
  // finished (a bounded wait cap, a slow SIGTERM), which would otherwise let a stopped change
  // sail through the gate into the merge — a green verdict, but equally a skipped check or a
  // failure the gate would excuse and approve. reviewPinnedChange observes the signal before
  // the gate, but this verdict is the seam the late kill slips through; fail closed so a
  // consumed abort always stops the change before any approving path reads the outcome.
  if (ctx.signal?.aborted) {
    return { resolved: abortedGateResult() };
  }
  // A failed run that spanned a host sleep past the tolerance leaves the tree unverified: the
  // gate attributes nothing and keeps the commit for a re-merge.
  const sleep = unverifiedSleepResult(root, role, settled);
  if (sleep) return sleep;
  if (settled.status === "passed") {
    // Passed: this exact tree just went green under the project's own declared check. Hand
    // the verdict to the merge path via verifiedHead — it pins the merge to the SHA that
    // actually becomes main (the rebased head, which may differ from `head`), so the change
    // merges the tree the gate judged.
    return { verifiedHead: head };
  }
  // A check the harness skipped for a reason other than the verify's abort (a killed run) is
  // not the tree's verdict either: it falls through to the same "no verdict" return.
  if (settled.status !== "failed") return {};
  // A failed check the gate already knows is not the change's — main's known failures or a
  // recorded flake — goes on to review without a fresh run on main.
  const known = knownFailureResult(root, role, check, settled);
  if (known) return known;
  const reasons = checkFailureReasons(check, settled);
  // A failure that reproduced is attributed, never fixed here: the one merge slot the whole
  // queue waits on is no place for a model run (the in-slot build-fix run this replaces held
  // it for hours and never once led to a merge — PLANS.md "Land-queue speed 1/3"). The
  // question is whose failure it is, and main's own verdict at its tip answers it at once,
  // never by waiting on the main watch. A shutdown already under way skips the question and
  // fails closed like any abort.
  if (ctx.signal?.aborted) return { resolved: abortedGateResult() };
  const failed = { tests: namedFailures(settled), files: settled.failingTestFiles };
  const main = await mainVerdictForFailure(ctx, failed);
  // A check killed by that shutdown reads as a skip, never as evidence against the author.
  if (ctx.signal?.aborted) return { resolved: abortedGateResult() };
  // The nameless failure is the gate command's verdict at main's tip; the named one is judged
  // against main's own failures there.
  if (failed.tests.length === 0) {
    return namelessFailureResult(root, role, main, reasons, reject);
  }
  return namedFailureResult(ctx, head, failed, settled, main, reasons, reject);
}
