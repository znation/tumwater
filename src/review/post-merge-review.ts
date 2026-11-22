import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { compareCodeUnits, increment } from "../collections.js";
import { postReviewPath, postReviewWorktreePath, nativeLogPath, piLogPath, reviewRunSessionDir, reviewFixRef } from "../paths.js";
import { reviewConfig, reviewRunConfig } from "../config/config-views.js";
import { sampleHostLoad } from "../build/host-sleep.js";
import { seamFree, piModelsPath, readPiProviders } from "../pi/pi-models.js";
import { readAccount } from "../agent/subscription-account.js";
import { readOpencodeCache } from "../agent/opencode/opencode-catalog.js";
import type { SubscriptionAccount } from "../agent/subscription-account.js";
import type { OpencodeCatalogCache } from "../agent/opencode/opencode-catalog.js";
import { logEventBestEffort, TUMWATER_SOURCE, tryOrWarn } from "../events/events.js";
import { isJsonObject } from "../files/json-object.js";
import { git, gitCouldNotStart, gitTry } from "../git/git-run.js";
import { commitAll, deleteRef, setRef } from "../git/git.js";
import { ensureDetachedWorktree } from "../git/worktree.js";
import { useWorktree } from "../git/worktree-use.js";
import { readPrinciples } from "../prompt/principles.js";
import { buildReviewPrompt } from "../prompt/gate-prompts.js";
import { shortSha } from "../text/format.js";
import { DAY_MS } from "../text/datetime.js";
import { errorMessage } from "../text/text.js";
import { revisionRoundOf } from "../run/commit-message.js";
import { REVISION_BACKSTOP } from "../runner/runner-revision.js";
import { eventRole, eventWithheldFix } from "../events/event-read.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { fixLine } from "../verdict/reply-contract.js";
import type { HarnessEvent } from "../events/events.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import type { GateRunsPi } from "../runner/runner-pi.js";
import { parseVerdict } from "./review-verdict.js";

/** A merged commit, waiting for its review after merging
 * (.tumwater/state/post-review.json). `rejected` holds the reviewer's recorded reasons once it
 * rejected the commit. */

export interface PostReview {
  commit: string;
  role: string;
  summary: string;
  body?: string;
  /** Review runs that ended without a verdict. */
  failures?: number;
  /** The most recent verdict-less run's detail: replaced on each failed run and cleared when the
   * entry is settled or removed. */
  lastFailure?: string;
  rejected?: string[];
  /** What the reviewer objected to in the reviewed commit, kept from its verdict while a repair
   * of its own is still trying to land. A settled `rejected` entry carries those reasons in
   * `rejected`; an entry whose fix was withheld by the fix's own pre-check is NOT settled, so
   * without this field the finding would exist nowhere a reader can see it — the entry would show
   * only the pre-check failure and the filed BUGS.md entry would repeat the commit's subject
   * (BUGS.md 2026-11-21). */
  finding?: string[];
  /** The sha of the reviewer's landed fix commit, when the review repaired what it found instead
   * of rejecting (Forward never back 1a/6). The entry then names both shas: `commit` is the
   * reviewed commit C and `fixed` the one fix commit that merged on top of it. */
  fixed?: string;
  /** When the entry was first queued for review, epoch ms; absent on an entry an older file
   * wrote. `settlePostReview` already spreads `next`, so a failed re-settle and a rejection
   * keep the original stamp. */
  enqueuedAt?: number;
  /** The earliest time a further review may start, epoch ms. A run that ended on a transient
   * provider failure (a 429 or quota wall, a backend failure) stamps it — the longer of the run's
   * retry-after and the team-hold base doubled with the entry's consecutive transient failures,
   * capped at the team-hold cap — and the drain skips the entry until it passes, so a multi-hour
   * wall re-probes a few times an hour instead of re-reviewing the same commit on every poll
   * (BUGS.md 2026-11-16). Cleared when the entry is settled or re-queued. */
  notBeforeMs?: number;
  /** How many consecutive runs this entry has ended on a transient provider failure, present only
   * while that streak is being re-armed: the drain's infrastructure arm increments it, and the
   * backoff grows (doubled) with it, capped at the team-hold cap, so a multi-hour quota wall
   * re-probes a few times an hour rather than a steady rate. A non-transient (content) failure
   * means the provider served the model, so that arm resets the streak to 0; the verdict arms
   * (approve / reject / fixed) and `settlePostReview(null)` leave it or drop it, but a settled
   * entry is never re-selected, so a counter riding a settled record is inert. */
  consecutiveTransientFailures?: number;
  /** The most recent run timed out while still making progress, so its session is kept: the next
   * run continues that session (continueSession) instead of starting fresh, and a review longer
   * than its budget carries its progress from one attempt to the next (BUGS.md 2026-11-18). Set
   * only by a progressing timeout and cleared by any other settle. */
  resume?: boolean;
}

/** A commit's review is dropped, with a warning, after this many runs with no verdict. */
export const POST_REVIEW_FAILURE_LIMIT = 3;

/** The wording agent-settle.ts gives a run that timed out while still making progress, and the
 * reworded tail a post-merge review reports for the same timeout: its session is kept and the next
 * run continues it, but its worktree is reset to the reviewed commit (BUGS.md 2026-11-18). */
const PRESERVED_EDITS_WORDING = " — session and worktree edits preserved for resume";
const SESSION_KEPT_WORDING = " — the session is kept; the next attempt resumes it";

/** A role's trailing-day total of post-merge `review_rejected` events, one entry per role with
 * at least one, sorted by count descending then role id ascending so the churn row's phrase is
 * deterministic. count is how many already-landed commits the role had turned back. */
interface PostMergeRejection {
  role: string;
  count: number;
}

/** The bar a day's post-merge rejections must reach before the doctor's `post-merge churn` row
 * fires: one post-merge rejection is the tiering's ordinary cost,
 * two in a day is a role whose already-landed changes keep being turned back — the
 * reviewer-fix signal for an operator to raise the authoring bar. */

export const POST_MERGE_REJECT_WARN = 2;

/** How far back the post-merge-churn rule looks — one day, the 24 h event-window convention
 * every event-reading doctor row uses. */
export const POST_MERGE_REJECT_WINDOW_MS = DAY_MS;

/** Group the `afterMerge: true` `review_rejected` events of `events` by base role — the same
 * `e.type === "review_rejected" && e.afterMerge === true` test the report fold
 * (src/report/report-fold.ts `postMergeRejectionsByRole`) applies, so the churn row and the
 * report cannot disagree on which rejections are post-merge. The key is the event's base role
 * (`baseRoleOf(eventRole(ev))`), not the raw source: an event's `source` is the runner id
 * (`bugfix-2`), and both the row's remedy and the scoped report are keyed by base role, so
 * one base role's churn must read as one row. A withheld reviewer fix (`withheldFix`,
 * event-read.ts eventWithheldFix) is excluded: its reasons are the pre-check's lint line on
 * REVIEWER-authored bytes and the review stays open (INV-BT8), so counting it blamed the author
 * for the reviewer's own slip and fired the row on withholdings alone (BUGS.md 2026-11-22).
 * Pre-merge rejections and other event types contribute nothing. */
export function postMergeRejectionCounts(events: readonly HarnessEvent[]): PostMergeRejection[] {
  const byRole = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "review_rejected" && ev.afterMerge === true && !eventWithheldFix(ev)) {
      const role = baseRoleOf(eventRole(ev));
      increment(byRole, role);
    }
  }
  return [...byRole.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count || compareCodeUnits(a.role, b.role));
}

/** The one home of the trigger and selection the doctor's `post-merge churn` row
 * (src/doctor/doctor-project-checks.ts) reads: whether
 * the trailing `POST_MERGE_REJECT_WINDOW_MS` holds at least `POST_MERGE_REJECT_WARN` post-merge
 * `review_rejected` events, and, when it does, which roles and how many each. null when the
 * window holds fewer than the bar, or none — so the two surfaces cannot disagree on when churn
 * fires. */
export function postMergeChurn(events: readonly HarnessEvent[]): { count: number; roles: readonly PostMergeRejection[] } | null {
  const roles = postMergeRejectionCounts(events);
  const count = roles.reduce((n, r) => n + r.count, 0);
  return count >= POST_MERGE_REJECT_WARN ? { count, roles } : null;
}

// One stat-cached read of the review queue, keyed by the queue file (merge-queue.ts's readEntry
// caches its single JSON file the same way): the dashboard's /api/status poll asks this every
// second, and the file only changes when a merge settles its review — an unchanged file costs
// one stat per poll instead of a whole-file read plus a JSON.parse on every request. Any write
// (addPostReview/settlePostReview's tmp+rename) lands a fresh inode and mtime/size, so the same
// dev/ino/mtime/size check invalidates it exactly like the other polled files; each caller gets
// a deep-enough copy (the entry objects and their `rejected` arrays) so treating a read result
// as one's own cannot poison a later poll.
/** The queued entries, each re-read parsed by `parsePostReview`: a torn or hand-edited entry
 * (not an object with a string commit, role and summary, or a `rejected` that is not an array —
 * a non-string `lastFailure` is dropped like the other fields) is dropped, and the next write
 * leaves it out. */
const postReviewCache = new Map<string, StatKeyedValue<PostReview[]>>();
/** One saved entry's re-read: null (drop as torn) when the entry is not an object with string
 * `commit`, `role` and `summary`, or its `rejected` is present but not an array; otherwise the
 * `PostReview`, with every optional field (`body`, `failures`, `lastFailure`, `rejected`,
 * `finding`,
 * `fixed`, `enqueuedAt`) copied only when its type and range are valid, in the order the
 * `PostReview` fields list them. */
function parsePostReview(raw: unknown): PostReview | null {
  if (!isJsonObject(raw)) return null;
  const { commit, role, summary, body, failures, lastFailure, rejected, enqueuedAt, fixed, notBeforeMs, consecutiveTransientFailures, resume, finding } = raw;
  if (typeof commit !== "string" || typeof role !== "string" || typeof summary !== "string") return null;
  if (rejected !== undefined && !Array.isArray(rejected)) return null;
  if (finding !== undefined && !Array.isArray(finding)) return null;
  const entry: PostReview = { commit, role, summary };
  if (typeof body === "string") entry.body = body;
  if (typeof failures === "number" && Number.isFinite(failures)) entry.failures = failures;
  if (typeof lastFailure === "string") entry.lastFailure = lastFailure;
  if (Array.isArray(rejected)) entry.rejected = rejected.filter((r): r is string => typeof r === "string");
  if (Array.isArray(finding)) entry.finding = finding.filter((r): r is string => typeof r === "string");
  if (typeof fixed === "string") entry.fixed = fixed;
  if (typeof enqueuedAt === "number" && Number.isFinite(enqueuedAt) && enqueuedAt >= 0) entry.enqueuedAt = enqueuedAt;
  if (typeof notBeforeMs === "number" && Number.isFinite(notBeforeMs) && notBeforeMs >= 0) entry.notBeforeMs = notBeforeMs;
  if (typeof consecutiveTransientFailures === "number" && Number.isInteger(consecutiveTransientFailures) && consecutiveTransientFailures >= 0) entry.consecutiveTransientFailures = consecutiveTransientFailures;
  if (resume === true) entry.resume = true;
  return entry;
}
/** The post-merge review queue as it stands on disk: each pending review, with its attempt counters
 * and any recorded fix, normalized so a stale or hand-edited entry cannot carry an invalid field.
 * Empty when the file is missing or malformed. Cached on the file's stats, so a poll of an
 * unchanged queue re-reads nothing. */
export function readPostReviews(root: string): PostReview[] {
  const file = postReviewPath(root);
  return (
    cachedByStat(
      postReviewCache,
      file,
      file,
      () => {
        const saved = readJsonFile<{ pending?: unknown }>(file);
        if (!Array.isArray(saved?.pending)) return [];
        return (saved.pending as unknown[]).map(parsePostReview).filter((e): e is PostReview => e !== null);
      },
      (entries) =>
        entries.map((e) => ({
          ...e,
          ...(e.rejected !== undefined ? { rejected: [...e.rejected] } : {}),
          ...(e.finding !== undefined ? { finding: [...e.finding] } : {}),
        })),
    ) ?? []
  );
}

function writePostReviews(root: string, pending: PostReview[]): void {
  tryOrWarn(root, TUMWATER_SOURCE, "write post-review.json", () => writeJsonAtomic(postReviewPath(root), { pending }));
}

/** Queue the merged commit for its review. Never throws: a failed write warns and leaves the file
 * as it was, so the commit goes unreviewed. Stamps `enqueuedAt` when the entry carries none —
 * the file's existing stamp on a re-add of a known commit, else `now` (the default clock when the
 * write path drives the drain) — so a re-queued entry keeps its original stamp and tests can pin
 * a fixed instant. */
export function addPostReview(root: string, entry: PostReview, now: number = Date.now()): void {
  const rest = readPostReviews(root);
  const prior = rest.find((e) => e.commit === entry.commit)?.enqueuedAt;
  const stamped: PostReview = { ...entry, enqueuedAt: entry.enqueuedAt ?? prior ?? now };
  writePostReviews(root, [...rest.filter((e) => e.commit !== entry.commit), stamped]);
}

/** Replace the entry for `commit` with `next`, or drop it when `next` is null. Never throws: a
 * failed write warns and leaves the file as it was, so a later poll handles the entry again. */
export function settlePostReview(root: string, commit: string, next: PostReview | null): void {
  const rest = readPostReviews(root).filter((e) => e.commit !== commit);
  writePostReviews(root, next ? [...rest, next] : rest);
}

/** What a post-merge review (`reviewMergedCommit`) found — the verdict the drain settles the
 * entry against, one arm per shape: `approve`/`reject` carry the reviewer's recorded reasons;
 * `fixed` is the reviewer's repair landed as a fix commit (its sha, for the drain to land on
 * main); `exhausted` is a self-fix chain that hit REVISION_BACKSTOP (the surviving findings,
 * the entry cleared); `failed` is a run that ended without a verdict, `infrastructure` when it
 * did so on a transient provider failure. */
export type PostReviewOutcome =
  | { kind: "approve"; reasons: string[] }
  | { kind: "reject"; reasons: string[] }
  | { kind: "fixed"; fix: string; reasons: string[] }
  /** The run ended on a transient provider failure (a 429 or quota wall, a backend/server
   * failure) rather than a content failure: the drain keeps the commit queued, never counts
   * it toward POST_REVIEW_FAILURE_LIMIT, and never files a product bug (BUGS.md: a Codex
   * quota wall converted ~820 merged commits into fake entries). */
  | { kind: "failed"; detail: string; infrastructure?: boolean; retryAfterSeconds?: number; resumable?: boolean }
  /** A self-fix chain reached REVISION_BACKSTOP: the reviewer stops fixing, records the
   * surviving findings and clears the entry (Forward never back 2/6). The answered plan needs
   * no hold — it was archived to PLANS-DONE.md when its implementation landed. */
  | { kind: "exhausted"; reasons: string[] };

/** Cut a review finding's first reason short enough to ride a commit subject (the
 * `tumwater(reviewer): Fix …` subject names it): trimmed of leading/trailing and repeated
 * whitespace, clipped at a word boundary around 100 chars with an ellipsis. */
function clipFixReason(reason: string): string {
  const trimmed = reason.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 100) return trimmed;
  return `${trimmed.slice(0, 97).replace(/\s+\S*$/, "")}…`;
}

/** Commit the review worktree's edited paths as the one `tumwater(reviewer): Fix <short sha> —
 * <first finding>` fix commit, made by the harness's own git call (never pi) — commitAll stages
 * and commits everything, so however the reviewer edited a path, the single commit captures it
 * on top of the reviewed commit C (the detached HEAD the worktree reset to); the caller advances
 * the review-fix ref to the returned sha. The harness stamps the fix's body with the `Revision:`
 * trailer one past the reviewed commit's round, so the next review of the fix reads its own round
 * from the same place a rejection's hand-back reads it (Forward never back 2/6) and the self-fix
 * chain counts toward the shared REVISION_BACKSTOP. Returns the new commit's full sha. */
async function commitReviewerFix(wt: string, commit: string, reasons: string[], nextRound: number): Promise<string> {
  const first = reasons[0] ? clipFixReason(reasons[0]) : "the reviewed change";
  const subject = `tumwater(reviewer): Fix ${shortSha(commit)} — ${first}`;
  const body = reasons.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const withRound = body ? `${body}\nRevision: ${nextRound}` : `Revision: ${nextRound}`;
  return commitAll(wt, `${subject}\n\n${withRound}`);
}

/** The reviewer run's reply, read once: a usable reply is one whose pi run succeeded and was
 * not aborted, and only a usable reply yields a parsed verdict and its FIX line's paths — the
 * single home of the `pi.ok && !pi.aborted` gate, so the verdict and the fix paths cannot drift
 * apart. */
function reviewerReplyOf(
  pi: Awaited<ReturnType<GateRunsPi["runGatePi"]>>,
): { verdict: NonNullable<ReturnType<typeof parseVerdict>> | null; paths: string[] | null } {
  const usable = pi.ok && !pi.aborted;
  return { verdict: usable ? parseVerdict(pi.verdictText ?? "") : null, paths: usable ? fixLine(pi.verdictText ?? "") : null };
}

/** One record for the reviewed commit C whatever way the review ends — reject or approve — so
 * the fix-forward landing does not lose the verdict that motivated it: `review_rejected` with
 * the full reasons on a rejection, `review_verdict` with the first reason otherwise, both
 * stamped `afterMerge: true` with the run's duration. */
function logReviewVerdict(
  root: string,
  role: string,
  commit: string,
  verdict: NonNullable<ReturnType<typeof parseVerdict>>,
  durationMs: number,
): void {
  if (verdict.verdict === "reject") {
    logEventBestEffort(root, { source: role, type: "review_rejected", head: commit, reasons: verdict.reasons, durationMs, afterMerge: true });
  } else {
    logEventBestEffort(root, { source: role, type: "review_verdict", head: commit, reason: verdict.reasons[0], durationMs, afterMerge: true });
  }
}

/** The reviewer's repair, when its reply carries a FIX: line and its worktree holds an edit:
 * the verdict does not decide it — a reviewer that repairs what it found and then judges the
 * repaired change sound approves with a FIX line, and dropping that repair lost real fixes
 * (BUGS-FIXED.md 2026-11-02). Returns the `fixed` outcome when the repair lands as a fix
 * commit on the review ref, and null when the reply names no fix or the worktree is clean;
 * the caller deletes the ref on that path. */
async function applyReviewFix(
  root: string,
  entry: PostReview,
  verdict: NonNullable<ReturnType<typeof parseVerdict>>,
  paths: string[] | null,
  diffWorktree: string,
  fixRef: string,
): Promise<PostReviewOutcome | null> {
  if (!(paths && (await gitTry(diffWorktree, "status", "--porcelain"))?.trim().length)) return null;
  // The self-fix chain's round is one past the reviewed commit's `Revision:` trailer; at
  // REVISION_BACKSTOP the reviewer stops fixing and records the surviving findings — the
  // same terminal stop as a rejection's exhaustion, one shared counter, never a second
  // one (Forward never back 2/6). The answered plan is deliberately NOT held here: it was
  // already archived to PLANS-DONE.md when its implementation landed, so it is no longer
  // under `## Planned` and there is nothing left to hold or re-pick.
  const reviewedMessage = (await gitTry(root, "log", "-1", "--format=%B", entry.commit)) ?? "";
  const nextRound = (revisionRoundOf(reviewedMessage) ?? 0) + 1;
  if (nextRound >= REVISION_BACKSTOP) {
    await deleteRef(root, fixRef); // the chain stops here; nothing to land
    logEventBestEffort(root, {
      source: entry.role,
      type: "revision",
      action: "exhausted",
      round: nextRound,
      sha: entry.commit,
    });
    return { kind: "exhausted", reasons: verdict.reasons };
  }
  const fix = await commitReviewerFix(diffWorktree, entry.commit, verdict.reasons, nextRound);
  // Advance the review-fix ref from C to the new fix commit, so the repair is reachable and
  // the merge-post-review-drain landing (which checks the fix out by this sha) finds it.
  await setRef(root, fixRef, fix);
  return { kind: "fixed", fix, reasons: verdict.reasons };
}

/** Whether the post-merge reviewer's *own* resolved seam is free: the reviewer's model wiring
 * (reviewConfig) judged by seamFree over the real catalog. A missing or torn account file or
 * models.json reads NOT free, the safe direction, so the floor engages only when the seam is
 * genuinely free — the one rule the budget gate, the fallback view, and the status free-ness
 * read all share. The opencode catalog is read from the project root (an empty cache when the
 * file is missing); a null catalog would also read not-free, so the floor never engages from a
 * backend its own free-ness badge would not call free. */
function reviewerSlowFree(root: string, config: TumwaterConfig): boolean {
  const seam = reviewConfig(config);
  const accounts = (backend: string): SubscriptionAccount | null => readAccount(root, backend);
  const catalog: OpencodeCatalogCache = readOpencodeCache(root);
  return seamFree(
    readPiProviders(piModelsPath()),
    { agent: seam.agent, provider: seam.provider, model: seam.model },
    accounts,
    catalog,
  );
}

/** Review the merged commit C: the usual reviewer prompt over `git diff C^ C`, run in a detached
 * checkout of C. Logs `review_start` and `review_verdict` / `review_rejected` with
 * `afterMerge: true`. A diff git fails to produce is a failed review with no reviewer run: read
 * as empty, the reviewer approved a commit it never saw. Throws only when git could not start
 * (gitCouldNotStart), which says nothing about C, so the caller keeps the entry as it was for
 * the next poll instead of counting a failed run toward dropping it. */
export async function reviewMergedCommit(
  root: string,
  config: TumwaterConfig,
  entry: PostReview,
  runGatePi: GateRunsPi["runGatePi"],
  signal: AbortSignal | undefined,
  slowReviewer?: boolean,
): Promise<PostReviewOutcome> {
  const { commit, role } = entry;
  // A reviewer whose own resolved model is a slow free one (typically local) needs the same
  // number of turns as a paid one but runs far slower per turn, so the load stretch alone
  // (900 s x 2 = 1800 s) kills a *progressing* review mid-run and the drain re-queues it,
  // burning dead compute per attempt. seamFree judges the reviewer's resolved seam with the
  // real catalog (offline: a missing models.json reads not-free, the safe direction, so a
  // test config with no model map keeps its pre-floor budget and the existing tests pass
  // unmodified); the `slowReviewer` override forces the verdict for offline tests that must
  // exercise the floor without a real catalog.
  const slow = slowReviewer ?? reviewerSlowFree(root, config);
  try {
    const startedAt = Date.now();
    const fixRef = reviewFixRef(commit);
    // The whole review — the detached checkout, the reviewer run, and (on a repair) the status
    // read, the fix commit and its ref — runs under one hold of the post-review worktree
    // (plans/disk-floor.md part 2/4), so nothing can reset or reuse the shared worktree between
    // the reviewer's edit and the commit that captures it.
    return await useWorktree(root, postReviewWorktreePath(root), async () => {
      // The review-fix ref tracks the reviewed commit C (and later the reviewer's fix commit), so
      // a repair survives as a durable reachable ref the pin housekeeping sees. The ref is reset
      // to C at every review and ensureDetachedWorktree hard-resets the worktree to C, so a
      // leftover ref or edit from an earlier review cannot change what is reviewed. Checking the
      // worktree out at C itself (not the ref) keeps the "git could not start" semantics of the
      // detached checkout it replaces: a review whose git cannot start throws gitCouldNotStart.
      const wt = await ensureDetachedWorktree(root, postReviewWorktreePath(root), commit);
      await setRef(root, fixRef, commit);
      const diff = await git(wt, "diff", `${commit}^`, commit);
      // The reviewer's wall-clock budget tracks the diff it must read: the budget stretches with
      // host load and with the diff's size (reviewRunConfig), so a progressing review of a large
      // diff is not killed at the load-only 2× cap. The bytes are the diff's actual UTF-8 size,
      // measured against REVIEW_DIFF_REFERENCE_BYTES.
      const reviewCfg = reviewRunConfig(
        config,
        sampleHostLoad,
        Buffer.byteLength(diff, "utf8"),
        slow,
      );
      logEventBestEffort(root, { source: role, type: "review_start", head: commit, afterMerge: true });
      const pi = await runGatePi({
        cwd: wt,
        kind: "gate",
        prompt: buildReviewPrompt(diff, entry.summary, entry.body, readPrinciples(root), undefined, `${commit}^`, undefined, undefined, undefined, true),
        config: reviewCfg,
        sessionDir: reviewRunSessionDir(root, role, `post-${shortSha(commit)}`),
        sessionName: `tumwater-review-${role}-post-${shortSha(commit)}`,
        // A review whose last run timed out while still making progress continues that run's
        // session (BUGS.md 2026-11-18); every other run starts a fresh one.
        continueSession: entry.resume === true,
        rawLogFile: piLogPath(root, role),
        nativeLogFile: nativeLogPath(root, role, reviewCfg.agent ?? "pi"),
        label: "review",
        signal,
      });
      const reply = reviewerReplyOf(pi);
      const verdict = reply.verdict;
      if (!verdict) {
        await deleteRef(root, fixRef);
        // A run that ended on a transient provider failure (a 429/quota wall, a backend
        // failure) is a world failure, not a review content failure: the drain keeps the
        // entry queued without counting it toward the drop limit or filing a product bug
        // (BUGS.md: a multi-hour Codex quota wall mass-filed one fake entry per commit).
        const infrastructure =
          pi.transientRateLimit ||
          pi.transientBackend ||
          pi.transientServerTimeout ||
          pi.transientPiCrash;
        // A timeout on a progressing run keeps its session for the next run to continue. The next
        // run's worktree reset discards the edits, so the detail names the session and not the
        // edits (the wording src/agent/agent-settle.ts gives a timed-out run, reworded here).
        const resumable = pi.timedOutProgressing;
        const detail = pi.errorMessage ?? "no parseable VERDICT line in the reviewer's reply";
        return {
          kind: "failed",
          detail: resumable ? detail.replace(PRESERVED_EDITS_WORDING, SESSION_KEPT_WORDING) : detail,
          ...(infrastructure ? { infrastructure: true, retryAfterSeconds: pi.retryAfterSeconds } : {}),
          ...(resumable ? { resumable: true } : {}),
        };
      }
      const durationMs = Date.now() - startedAt;
      logReviewVerdict(root, role, commit, verdict, durationMs);
      // A review whose reply carries a FIX: line and whose worktree holds an edit survives as one
      // fix commit on the review ref, kept for merge-post-review-drain.ts to land on main through
      // the ordinary change path. A clean worktree or a reply with no FIX line keeps the plain
      // approve/reject outcome and deletes the ref.
      const fixed = await applyReviewFix(root, entry, verdict, reply.paths, wt, fixRef);
      if (fixed !== null) return fixed;
      await deleteRef(root, fixRef);
      if (verdict.verdict === "reject") return { kind: "reject", reasons: verdict.reasons };
      return { kind: "approve", reasons: verdict.reasons };
    });
  } catch (err) {
    if (gitCouldNotStart(err)) throw err;
    return { kind: "failed", detail: errorMessage(err) };
  }
}
