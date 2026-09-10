import type { LoopState, PiRunResult, TumwaterConfig } from "./types.js";
import { reviewConfig } from "./config.js";
import { logEvent } from "./events.js";
import { aheadOfMainDiff, aheadOfMainFiles, git, headOf } from "./git.js";
import { resetWorktreeToMain } from "./worktree.js";
import { piLogPath, reviewSessionDir } from "./paths.js";
import { runPi } from "./pi.js";
import { buildReviewPrompt, readPrinciples } from "./prompt.js";
import { verdictLines } from "./reply-contract.js";
import { saveLoopState } from "./state.js";
import { shortSha } from "./text.js";
import {
  BUILD_CHECK_TIMEOUT_MS,
  clipReason,
  detectBuildCheck,
  noteGreenBaseline,
  runBuildCheck,
} from "./build-check.js";
import { isExemptDiff } from "./exemptions.js";

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
  const after = text.slice(last.end);
  const lines = after.split("\n").map((l) => l.trim()).filter(Boolean);
  let reasons = lines
    .map((l) => l.match(/^(?:\d+[.)]|[-*])\s+(.+)$/)?.[1]?.trim())
    .filter((r): r is string => Boolean(r));
  if (reasons.length === 0) reasons = lines; // Prose fallback: every non-empty line.
  return { verdict: last.verdict, reasons: reasons.slice(0, MAX_REASONS).map(clipReason) };
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
 * accordingly. Shared by the tick path (after commitAll) and leftover recovery
 * (leftover.ts's recoverLeftover) — every path
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
  if (isExemptDiff(files, config.review.exemptPaths)) return { decision: "exempt" };

  // Deterministic build pre-check — after BOTH early returns above (an md-only diff cannot
  // break the build) and before any reviewer run or the phase/event that would show
  // "reviewing": a deterministic rejection never shows as reviewing on the dashboards. Both
  // gate callers (the tick path and leftover.ts's recoverLeftover) get it for free.
  const check = detectBuildCheck(wt);
  // Named in the reviewer's prompt when the pre-check ran green: the model reviewer then spends
  // its run on what a passing suite cannot show instead of re-running `npm test` itself.
  let verifiedByHarness: string | undefined;
  if (check) {
    const timeoutMs = ctx.buildCheckTimeoutMs ?? BUILD_CHECK_TIMEOUT_MS;
    const checkStartedAt = Date.now();
    const outcome = await runBuildCheck(wt, check, timeoutMs);
    // Every pre-check run is an event with its cost: the gate is where the fleet's compute
    // goes after the authoring run, and "how long does npm test take per merge" must be
    // answerable from the feed, not by timing it by hand.
    logEvent(root, {
      loop: role,
      type: "build_check",
      scope: "gate",
      status: outcome.status,
      script: check.script,
      durationMs: Date.now() - checkStartedAt,
    });
    if (outcome.status === "failed") {
      // Machine-generated reasons: the header joined to the first output line (so the
      // compiler error sits right after it in the injected next-tick note), then the rest of
      // the clipped tail. The rejection itself routes through the shared reject path — no pi
      // run consumed, unreviewFailures resetting exactly like a model reject.
      const first = (outcome.outputTail ?? [])[0];
      const reasons =
        first !== undefined
          ? [`build check failed (${check.script}): ${first}`, ...(outcome.outputTail ?? []).slice(1)]
          : [`build check failed (${check.script})`];
      return reject(reasons);
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
    } else {
      // Passed: this exact tree just went green under the project's own declared check. Seed
      // the red-main baseline cache with that verdict (noteGreenBaseline) so that after the
      // merge lands — main now points at this very SHA — every role's next fresh tick is a
      // cache hit instead of one redundant full-suite re-run on an already-verified tree.
      noteGreenBaseline(head);
      verifiedByHarness = `\`npm run ${check.script}\` (the project's declared check) passed`;
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
  // against the actual diff is exactly the adversarial angle (recovery re-reviews pass none:
  // the original run is gone).
  const pi = await runPi({
    cwd: wt,
    prompt: buildReviewPrompt(diff, summary, commitBody, readPrinciples(root), highFriction, verifiedByHarness),
    config: reviewConfig(config),
    // Fresh session every time (no --continue): the reviewer must not inherit the author's
    // context. Unique name per run — a fixed name would let pi resume an old review's
    // context; old files are cleaned by the age-based prune at orchestrator start.
    sessionDir: reviewSessionDir(root, role),
    sessionName: `tumwater-review-${role}-${ctx.tick}${ctx.sessionSuffix ?? ""}`,
    rawLogFile: piLogPath(root, role),
    // Label this run in the shared transcript (src/transcript.ts renders it as
    // `── review @ <ts> ──`) so an operator can tell reviewer runs from author ticks.
    label: "review",
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
    logEvent(root, { loop: role, type: "review_failed", head, message, durationMs: Date.now() - reviewStartedAt });
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
    const rejected = await reject(verdict.reasons, Date.now() - reviewStartedAt);
    return { ...rejected, run: pi };
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
  return { decision: "approved", run: pi };
}
