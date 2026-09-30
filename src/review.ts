import type { TumwaterConfig } from "./config-schema.js";
import type { PiRunResult } from "./pi.js";
import type { LoopState } from "./loop-state.js";
import { reviewRunConfig } from "./config-views.js";
import { logEvent, warnEvent } from "./events.js";
import { git, headOf, patchId } from "./git.js";
import { aheadOfMainDiff, aheadOfMainFiles } from "./git-diff.js";
import { resetWorktreeToMain } from "./worktree.js";
import { piLogPath, reviewSessionDir } from "./paths.js";
import { hasResumableSession, runPi } from "./pi.js";
import { readPrinciples } from "./prompt.js";
import { buildReviewPrompt, buildVerdictRequestPrompt } from "./gate-prompts.js";
import { parseVerdict } from "./review-verdict.js";
import { recordReview } from "./tick-outcome.js";
import { saveLoopState } from "./loop-state.js";
import { shortSha } from "./text.js";
import { BUILD_CHECK_TIMEOUT_MS } from "./build-check-detect.js";
import { runScopedBuildCheck } from "./build-check.js";
import { checkFailureReasons, describeCheck, failureHeadline } from "./build-check-report.js";
import { sleptPhrase, unverifiedTreeOutcome } from "./build-check-events.js";
import { sampleSleepClock, type SleepSampler } from "./host-sleep.js";
import { isExemptDiff } from "./exemptions.js";
import { falseFixReason } from "./fix-claim.js";
import { backlogStructureReason } from "./backlog-structure.js";
import { suiteRerunWarning, type ToolCallStart } from "./suite-rerun.js";
import { setLandingStage } from "./landing-slot.js";
import { mainTipVerdict } from "./main-red.js";

/** Consecutive failed reviews of one branch HEAD after which the leftover is discarded with
 * a warning: a misconfigured reviewer model must not be able to wedge a loop into re-reviewing
 * the same commit forever. */
export const REVIEW_FAILURE_LIMIT = 3;

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
  signal?: AbortSignal;
  /** Cap for the deterministic build pre-check run; defaults to BUILD_CHECK_TIMEOUT_MS.
   * A test seam — production callers leave it unset. */
  buildCheckTimeoutMs?: number;
  /** The sleep clock the pre-check measures host suspension with; defaults to the real
   * sampleSleepClock. A test seam — production callers leave it unset. */
  sampleSleep?: SleepSampler;
}

/** What the gate decided and what the caller should do next. "approved"/"exempt": safe to
 * merge (the work was reviewed, or needed no review). "rejected"/"failed": already handled
 * per policy (branch reset / commit left for retry) — never merge. */
export interface GateResult {
  decision: "approved" | "exempt" | "rejected" | "failed";
  /** The branch HEAD this gate invocation's pre-check just ran green on — the one tree the
   * landing path may trust without re-running the check (src/landing-merge.ts seeds the red-main
   * baseline with it when the rebase is a no-op, and re-verifies anything else). Absent when
   * no fresh green observation was made: gate disabled, exempt diff, already-approved early
   * return, or a pre-check that failed or skipped. */
  verifiedHead?: string;
  /** The reviewer run was killed by harness shutdown mid-review: fail closed, leave the
   * commit, and let the tick report aborted (resume re-reviews via the combined diff). */
  aborted?: boolean;
  /** The strike-cap discard fired: the gate itself reset the worktree off the reviewed head,
   * so the commit is gone and any pin naming the old head must go too. An under-cap failure
   * leaves this absent — its commit stays for re-review. The discard is invisible in the
   * decision alone, which is the same "failed" shape an under-cap failure reports. */
  discarded?: boolean;
  /** The pre-check failed twice on a tree whose main is red at its tip ("failed"): not this
   * change's failure, so its landing reports `main_red` — pin kept, no strike, and none of the
   * error streak a dead reviewer backend feeds (the batch's own attribution says the same). */
  mainRed?: boolean;
  /** The pre-check's every attempt spanned a host sleep, so nothing judged the tree
   * ("failed"): not this change's failure either — its landing keeps the pin for a re-land
   * with no strike, and the detail names the sleep (BUGS.md 2026-09-30). */
  unverified?: boolean;
  /** Failure message ("failed") or first rejection reason ("rejected"), for lastSummary. */
  detail?: string;
  /** The reviewer's pi run, for usage folding into the loop totals — absent when no review
   * ran (gate disabled, exempt diff, or an already-approved HEAD or patch). */
  run?: PiRunResult;
  /** The follow-up turn that recovered (or failed to recover) a missing VERDICT line, when
   * one ran — folded into the loop totals by the caller right after `run`. Absent when the
   * reviewer's own reply parsed (no follow-up needed) or there was no session to continue. */
  followUpRun?: PiRunResult;
}

/** Hard caps on the VERDICT follow-up turn: it should take one short reply on a warm session,
 * so it never gets the review run's own budget (mirrors LoopPi's SUMMARY-request caps). */
const VERDICT_REQUEST_TIMEOUT_S = 900;
const VERDICT_REQUEST_QUIET_S = 300;

/** Ask the reviewer's own session (--continue) for the missing VERDICT line: one tightly
 * bounded turn on the just-finished review's session, mirroring LoopPi.requestSummary on the
 * author side (BUGS.md 2026-09-29). Null when there is no session to continue — the caller
 * then counts the strike exactly as before. The run is returned even when it failed so the
 * caller can honor a shutdown abort and fold the spend. */
async function requestVerdict(ctx: ReviewContext): Promise<PiRunResult | null> {
  const sessionDir = reviewSessionDir(ctx.root, ctx.role);
  if (!hasResumableSession(sessionDir)) return null;
  const cfg = reviewRunConfig(ctx.config);
  return runPi({
    cwd: ctx.wt,
    prompt: buildVerdictRequestPrompt(),
    config: {
      ...cfg,
      tickTimeoutSeconds: Math.min(cfg.tickTimeoutSeconds, VERDICT_REQUEST_TIMEOUT_S),
      quietTimeoutSeconds:
        cfg.quietTimeoutSeconds > 0
          ? Math.min(cfg.quietTimeoutSeconds, VERDICT_REQUEST_QUIET_S)
          : VERDICT_REQUEST_QUIET_S,
    },
    sessionDir,
    // The whole point: continue the just-finished review's session, which already holds
    // everything the reviewer read and concluded.
    continueSession: true,
    sessionName: `tumwater-review-${ctx.role}-${ctx.tick}-verdict`,
    rawLogFile: piLogPath(ctx.root, ctx.role),
    label: "review-verdict",
    signal: ctx.signal,
    onToolCallStalled: (message) => warnEvent(ctx.root, ctx.role, message),
  });
}

/** Run the adversarial review gate over everything ahead of main in `wt` and update `state`
 * accordingly. Shared by the tick path (after commitAll) and leftover recovery
 * (leftover.ts's recoverLeftover) — every path
 * that can move a commit into main routes through here, so no crash or abort path smuggles
 * unreviewed work in:
 * - gate disabled, or an already-approved HEAD, or an exempt (doc-only) diff → merge as-is;
 * - a new HEAD carrying the last approved patch (lastApprovedPatchId) → approved after the
 *   build pre-check, with no reviewer run;
 * - approve → record lastApprovedHead and its patch-id, and discard the reviewer's stray
 *   working-tree edits (its only output channel is the verdict);
 * - reject → reset the branch to main, record reasons in state.lastReview (injected into the
 *   role's next tick prompt), log review_rejected;
 * - fail with an unparseable reply (the reviewer ran to completion but emitted no VERDICT) →
 *   one capped follow-up turn on the reviewer's own session asks for the missing line
 *   (mirroring requestSummary — BUGS.md 2026-09-29); only a follow-up that also yields
 *   nothing counts the strike. Leave the commit on the branch for the next tick's re-review,
 *   counting consecutive failures per HEAD; past REVIEW_FAILURE_LIMIT discard the leftover
 *   with a warning.
 * - fail because the run itself failed (transport/spawn/timeout, pi.ok false) → leave the
 *   commit and do NOT advance the count: the reviewer never judged the diff, so the failure
 *   is evidence about the backend, never about the commit (BUGS.md 2026-09-20).
 * - the declared check fails, and fails again on its one re-run → reject with the check's
 *   reasons, no pi run, when main's own tip is green (or has no verdict); when main is red too,
 *   fail without advancing the count and leave the commit — the failure is main's. Never throws.
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

  // The one reject path: every rejection of this HEAD — deterministic build-check failure or
  // model verdict — shares this bookkeeping. Record lastReview (injected into the role's next
  // tick prompt), reset the failure count (a verdict about this HEAD is a successful review
  // either way), discard the branch by resetting it to main, and log review_rejected.
  // Callers attach `run` when a pi run was consumed.
  const reject = async (reasons: string[], durationMs?: number): Promise<GateResult> => {
    recordReview(state, "reject", reasons, head);
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
    // Same cross-check as the landing path (backlog-structure.ts): an md-only diff that
    // duplicates or drops a `## ` section heading would land unreviewed — md-only edits skip
    // the reviewer by design, and a malformed backlog stays invisible until an entry ends up
    // on the wrong side of a heading (PLANS.md 2026-09-25, 52cbadd1).
    const structure = await backlogStructureReason(wt, mainBranch, files);
    if (structure) return reject([structure]);
    return { decision: "exempt" };
  }

  // The backlog-structure check for code diffs too, before the build pre-check: a change that
  // duplicates or drops a `## ` section heading in PLANS.md, BUGS.md, or QUESTIONS.md cannot
  // land, and the rejection is deterministic — no pi run and no check run spent on a tree the
  // heading set already condemns.
  const structure = await backlogStructureReason(wt, mainBranch, files);
  if (structure) return reject([structure]);

  // Deterministic build pre-check — after BOTH early returns above (an md-only diff cannot
  // break the build) and before any reviewer run or the phase/event that would show
  // "reviewing": a deterministic rejection never shows as reviewing on the dashboards. Both
  // gate callers (the tick path and leftover.ts's recoverLeftover) get it for free. The run
  // itself (build_check event, environmental-skip warning) lives in runScopedBuildCheck,
  // shared with the landing path's in-lock re-check.
  // Named in the reviewer's prompt when the pre-check ran green: the model reviewer then spends
  // its run on what a passing suite cannot show instead of re-running `npm test` itself (the
  // prompt's no-re-run rule, and the suite-rerun tripwire after the reviewer run, both key on it).
  let verifiedByHarness: string | undefined;
  // The head the pre-check just verified (see GateResult.verifiedHead) — handed to the landing
  // path, which owns the baseline seeding for the SHA that actually becomes main.
  let verifiedHead: string | undefined;
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
      return { decision: "failed", detail, unverified: true };
    }
    if (outcome.status === "failed") {
      const reasons = checkFailureReasons(check, outcome);
      // A failure that reproduced is attributed, never fixed here: the one landing slot the
      // whole queue waits on is no place for a model run (the in-slot build-fix run this
      // replaces held it for hours and never once led to a landing — PLANS.md "Land-queue
      // speed 1/3"). The question is whose failure it is, and main's own verdict at its tip
      // answers it — usually a cache hit, since every landing seeds the SHA it moved main to.
      // A shutdown already under way skips the question and fails closed like any abort.
      if (ctx.signal?.aborted) return { decision: "failed", aborted: true };
      const main = await mainTipVerdict(root, role, mainBranch, config);
      // A check killed by that shutdown reads as a skip, never as evidence against the author.
      if (ctx.signal?.aborted) return { decision: "failed", aborted: true };
      if (main.status === "red") {
        // Main fails too: not this change's failure. Leave the commit (and with it the pin) and
        // do not advance the discard counter — the transport-failure rule (BUGS.md 2026-09-20):
        // nothing judged this diff. main-red.ts's gate and the bugfix handoff own the repair,
        // and the author's next tick re-lands the change once main is green again.
        const detail = `main ${shortSha(main.sha)} is red — not this change's failure`;
        recordReview(state, "failed", [detail], head);
        warnEvent(root, role, `gate check failed on ${shortSha(head)}, but ${detail}; landing kept`);
        return { decision: "failed", detail, mainRed: true };
      }
      // Main green: the change broke the check — rejected deterministically through the shared
      // reject path, no pi run consumed, reasons injected into the author's next tick. With no
      // verdict for main the author's failure is still the safe default, and the reasons say
      // the attribution could not be made.
      return reject(
        main.status === "green"
          ? reasons
          : [...reasons, `main's baseline was unavailable (${main.why}), so the failure is attributed to this change`],
      );
    }
    if (outcome.status === "passed") {
      // Passed: this exact tree just went green under the project's own declared check. Hand
      // the verdict to the landing path via verifiedHead — it seeds the red-main baseline with
      // the SHA that actually becomes main (the rebased head, which may differ from `head`),
      // so every role's next fresh tick is a cache hit instead of one redundant full-suite
      // re-run on an already-verified tree.
      verifiedHead = head;
      // The counts are the harness's own reading of the runner's summary (parseTestCounts):
      // attesting them here means neither the author nor the reviewer states a total, which is
      // where most record-claim rejections came from (PLANS.md 2026-09-29).
      verifiedByHarness = outcome.counts
        ? `${describeCheck(check)} (the project's declared check) passed — ${outcome.counts.pass} pass, ${outcome.counts.fail} fail, ${outcome.counts.skipped} skipped of ${outcome.counts.tests}`
        : `${describeCheck(check)} (the project's declared check) passed`;
    }
  }

  // A review judges a diff, not a sha: a head carrying exactly the patch this role's last
  // approval judged (the approved head cleanly rebased onto a moved main) reuses that verdict
  // instead of paying a second reviewer run. Only the model review is reused — the pre-check
  // above has just run on this tree (a failure rejected it there), and its verifiedHead rides
  // on the result as for any approval.
  if (state.lastApprovedPatchId !== undefined) {
    if ((await patchId(wt, mainBranch, head)) === state.lastApprovedPatchId) {
      state.lastApprovedHead = head;
      return { decision: "approved", verifiedHead };
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
  // The reviewer's started tool calls, collected only when the no-re-run rule stands (a verified
  // pre-check) — the one case the suite-rerun tripwire below can fire.
  const reviewerCalls: ToolCallStart[] = [];
  // The landing cell switches to the reviewer run's live detail (no-op outside a queued
  // landing). runPi writes the run's `tumwater_run` label line before spawning pi, and that
  // line resets the gate progress accumulator, so the cell never shows a previous run's counts.
  setLandingStage(root, role, "reviewing");
  // The author's claimed WHY/RISK/VERIFIED ride along when present — checking those claims
  // against the actual diff is exactly the adversarial angle (recovery landings reconstruct
  // them from the pinned commit's message).
  const pi = await runPi({
    cwd: wt,
    prompt: buildReviewPrompt(diff, summary, commitBody, readPrinciples(root), highFriction, verifiedByHarness),
    // The reviewer runs on its own time budget (review.timeoutSeconds), never longer than a
    // tick's: a timed-out review is a FAILED run (pi.ok false), so it takes the dead-backend
    // path below — commit kept, no strike — and re-lands through the author's next tick
    // instead of holding the land queue for a whole authoring tick.
    config: reviewRunConfig(config),
    // Fresh session every time (no --continue): the reviewer must not inherit the author's
    // context. Unique name per run — a fixed name would let pi resume an old review's
    // context; old files are cleaned by the age-based prune at orchestrator start.
    sessionDir: reviewSessionDir(root, role),
    sessionName: `tumwater-review-${role}-${ctx.tick}`,
    rawLogFile: piLogPath(root, role),
    // Label this run in the shared transcript (src/ui/transcript.ts renders it as
    // `── review @ <ts> ──`) so an operator can tell reviewer runs from author ticks.
    label: "review",
    signal: ctx.signal,
    // A stalled tool call during review hangs the gate just like one during authoring —
    // name it in the event feed while the quiet watchdog still counts down.
    onToolCallStalled: (message) => warnEvent(root, role, message),
    onToolCallStart: verifiedByHarness
      ? (toolName, args) => {
          reviewerCalls.push({ toolName, args });
        }
      : undefined,
  });

  // A reviewer told the pre-check passed that re-ran the full suite anyway held the landing
  // slot and loaded the shared host for a result the harness already had (BUGS.md 2026-09-23:
  // scratch copies under /tmp, `npm ci` and `npm test` there). Warned on every outcome, abort
  // included — the run happened either way; the verdict itself is not touched.
  const rerun = suiteRerunWarning(reviewerCalls);
  if (rerun) warnEvent(root, role, rerun);

  if (pi.aborted) {
    // Shutdown mid-review: fail closed without bookkeeping — the commit stays on the branch
    // and the resumed/following tick re-reviews it via the combined ahead-of-main diff.
    return { decision: "failed", aborted: true, run: pi };
  }

  let verdict = parseVerdict(pi.verdictText ?? "");
  // A run that FAILED (`ok` false: transport error, failed spawn, timeout) produced no reply,
  // so no follow-up is attempted — it is evidence about the backend, and the strike-free
  // branch below keeps it that way (BUGS.md 2026-09-20). Only a run that completed and
  // replied without a parseable VERDICT earns the recovery turn: that is evidence about the
  // reviewer's output format, not about the diff, and it is as recoverable as the author
  // side's missing SUMMARY (BUGS.md 2026-09-29).
  let followUp: PiRunResult | null = null;
  if (!verdict && pi.ok) {
    followUp = await requestVerdict(ctx);
    if (followUp?.aborted) return { decision: "failed", aborted: true, run: pi, followUpRun: followUp };
    const recovered = followUp ? parseVerdict(followUp.verdictText ?? "") : null;
    if (recovered) {
      verdict = recovered;
      warnEvent(root, role, "the reviewer's reply had no VERDICT line — recovered it with a follow-up turn on its own session");
    }
  }
  if (!verdict) {
    const followUpError = followUp && !followUp.ok ? followUp.errorMessage : undefined;
    const message =
      followUpError ??
      pi.errorMessage ??
      `no parseable VERDICT line in the reviewer's reply${followUp ? ", even after a follow-up turn on its session" : ""}`;
    logEvent(root, { loop: role, type: "review_failed", head, message, durationMs: Date.now() - reviewStartedAt });
    // A dead reviewer must never destroy committed work (BUGS.md 2026-09-20): leave the commit
    // for the next tick's re-review and do not advance the per-HEAD discard counter. That
    // holds for the review run itself (BUGS.md 2026-09-20) AND for the verdict-recovery
    // follow-up (BUGS.md 2026-09-29): the follow-up's death is the backend failing after the
    // reviewer had already judged nothing — evidence about the world, never about the diff.
    if (!pi.ok || (followUp && !followUp.ok)) {
      recordReview(state, "failed", [message], head);
      return { decision: "failed", detail: message, run: pi, ...(followUp ? { followUpRun: followUp } : {}) };
    }
    // Consecutive failures of THIS HEAD only: a new commit (new HEAD) starts fresh. Read
    // *before* overwriting lastReview with this failure.
    const prev = state.lastReview;
    const sameHead = prev?.verdict === "failed" && prev.head === head;
    state.unreviewFailures = (sameHead ? (state.unreviewFailures ?? 0) : 0) + 1;
    recordReview(state, "failed", [message], head);
    let discarded = false;
    if ((state.unreviewFailures ?? 0) >= REVIEW_FAILURE_LIMIT) {
      await resetWorktreeToMain(wt, mainBranch);
      state.unreviewFailures = 0; // The HEAD is gone; nothing left to count against.
      discarded = true;
      warnEvent(root, role, `discarding unreviewed leftover after ${REVIEW_FAILURE_LIMIT} failed reviews (${shortSha(head)})`);
    }
    return {
      decision: "failed",
      detail: message,
      run: pi,
      ...(followUp ? { followUpRun: followUp } : {}),
      ...(discarded ? { discarded: true } : {}),
    };
  }

  if (verdict.verdict === "reject") {
    const rejected = await reject(verdict.reasons, Date.now() - reviewStartedAt);
    return { ...rejected, run: pi, ...(followUp ? { followUpRun: followUp } : {}) };
  }

  // Approve: record the reviewed HEAD and discard any stray working-tree edits the reviewer
  // made while reading around — its only output channel is the verdict. The patch-id keys the
  // approval to the diff it judged; unreadable, it clears any older one (no reuse at all).
  state.lastApprovedHead = head;
  state.lastApprovedPatchId = (await patchId(wt, mainBranch, head)) ?? undefined;
  recordReview(state, "approve", verdict.reasons, head);
  state.unreviewFailures = 0;
  await git(wt, "reset", "--hard", "HEAD");
  logEvent(root, {
    loop: role,
    type: "review_verdict",
    head,
    reason: verdict.reasons[0],
    durationMs: Date.now() - reviewStartedAt,
  });
  return { decision: "approved", run: pi, verifiedHead, ...(followUp ? { followUpRun: followUp } : {}) };
}
