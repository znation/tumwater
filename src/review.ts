import type { TumwaterConfig } from "./config-schema.js";
import type { LoopState, PiRunResult } from "./types.js";
import { reviewRunConfig } from "./config.js";
import { logEvent, warnEvent } from "./events.js";
import { git, headOf, patchId } from "./git.js";
import { aheadOfMainDiff, aheadOfMainFiles } from "./git-diff.js";
import { resetWorktreeToMain } from "./worktree.js";
import { piLogPath, reviewSessionDir } from "./paths.js";
import { runPi } from "./pi.js";
import { readPrinciples } from "./prompt.js";
import { buildReviewPrompt } from "./gate-prompts.js";
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
import { suiteRerunWarning, type ToolCallStart } from "./suite-rerun.js";
import { setLandingStage } from "./landing-slot.js";
import { mainTipVerdict } from "./main-red.js";

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
  /** The strike-cap discard fired: the gate itself reset the worktree off the reviewed head,
   * so the commit is gone and any pin naming the old head must go too. An under-cap failure
   * leaves this absent — its commit stays for re-review. The discard is invisible in the
   * decision alone, which is the same "failed" shape an under-cap failure reports. */
  discarded?: boolean;
  /** The pre-check failed twice on a tree whose main is red at its tip ("failed"): not this
   * change's failure, so its landing reports `main_red` — pin kept, no strike, and none of the
   * error streak a dead reviewer backend feeds (the batch's own attribution says the same). */
  mainRed?: boolean;
  /** Failure message ("failed") or first rejection reason ("rejected"), for lastSummary. */
  detail?: string;
  /** The reviewer's pi run, for usage folding into the loop totals — absent when no review
   * ran (gate disabled, exempt diff, or an already-approved HEAD or patch). */
  run?: PiRunResult;
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
 *   leave the commit on the branch for the next tick's re-review, counting consecutive
 *   failures per HEAD; past REVIEW_FAILURE_LIMIT discard the leftover with a warning.
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
  const preCheck = await runScopedBuildCheck(
    root,
    role,
    "gate",
    wt,
    config,
    ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS,
  );
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
      const retry = await runScopedBuildCheck(
        root,
        role,
        "gate",
        wt,
        config,
        ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS,
      );
      if (retry?.outcome.status === "passed") {
        const flaky = failureHeadline(outcome.outputTail) ?? describeCheck(check);
        warnEvent(root, role, `gate check failed then passed on retry — flaky: ${flaky}`);
        outcome = retry.outcome;
      } else if (retry?.outcome.status === "failed") {
        outcome = retry.outcome;
      }
    }
    if (outcome.status === "failed") {
      // Machine-generated reasons: the headline joined to the rest of the clipped tail (so the
      // compiler error sits right after it in the injected next-tick note). The headline is
      // failureHeadline's — the first line that is not a stack frame — not outputTail[0]: a
      // suite that dies on an unhandled rejection opens mid-stack, and naming the frame tells
      // the author where it broke, never what (BUGS.md 2026-09-19).
      const tail = outcome.outputTail ?? [];
      const headline = failureHeadline(tail);
      const what = describeCheck(check);
      const reasons =
        headline !== undefined
          ? [`build check failed (${what}): ${headline}`, ...tail.filter((l) => l !== headline)]
          : [`build check failed (${what})`];
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
        state.lastReview = { verdict: "failed", reasons: [detail], head, at: Date.now() };
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
      verifiedByHarness = `${describeCheck(check)} (the project's declared check) passed`;
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
    sessionName: `tumwater-review-${role}-${ctx.tick}${ctx.sessionSuffix ?? ""}`,
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
      return { decision: "failed", detail: message, run: pi };
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
    return { decision: "failed", detail: message, run: pi, ...(discarded ? { discarded: true } : {}) };
  }

  if (verdict.verdict === "reject") {
    const rejected = await reject(verdict.reasons, Date.now() - reviewStartedAt);
    return { ...rejected, run: pi };
  }

  // Approve: record the reviewed HEAD and discard any stray working-tree edits the reviewer
  // made while reading around — its only output channel is the verdict. The patch-id keys the
  // approval to the diff it judged; unreadable, it clears any older one (no reuse at all).
  state.lastApprovedHead = head;
  state.lastApprovedPatchId = (await patchId(wt, mainBranch, head)) ?? undefined;
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
  return { decision: "approved", run: pi, verifiedHead };
}
