import { roleLabel } from "../roles/role-labels.js";
import fs from "node:fs";
import path from "node:path";
import { errorMessage, truncate } from "../text/text.js";
import { shortSha } from "../text/format.js";
import { readPostReviews, POST_REVIEW_FAILURE_LIMIT } from "../review/post-merge-review.js";
import { humanSeconds, secondsSince, HOUR_MS, DAY_MS } from "../text/datetime.js";
import type { HarnessEvent } from "../events/events.js";
import { eventsSince } from "../events/event-window.js";
import { finiteNumber } from "../files/json-object.js";
import { lowerMedian } from "../collections.js";
import { agree, plural, shortSpanPhrase } from "../text/phrases.js";
import { queuedMerges, unreadableMergeQueueFiles } from "../merge/merge-queue.js";
import { mergeChanges, readMergeMarker } from "../merge/merge-slot.js";
import { listWideScope, queuedListRows, type QueuedListRow } from "../inbox/inbox.js";
import { deliverableAt } from "../inbox/prompt-not-before.js";
import { currentBranch, targetBranch } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { stampedSubject } from "../git/commit-message.js";
import { commitOperatorBacklogEdit } from "../backlog/backlog-commit.js";
import { briefFile } from "../brief/brief.js";
import { BACKLOG_FILES } from "../backlog/backlog-md.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./doctor-outcome.js";

/** The doctor's backlog modules' shared scaffolding and the check groups that do not read a
 * single backlog document: the merge-queue, post-merge-review and queued-prompt checks
 * (checkStaleQueuedMerges, checkMergeQueueFiles, checkPostReviews, checkStalePrompts and the
 * mergeWaitPhrase helper) and the uncommitted-
 * edits-in-the-primary-checkout check. This module also hosts the helpers and constants the
 * per-document checks import — readDoc and its checked wrapper readDocChecked, andMore, and the
 * age/heading-trim bounds — so the per-document reads cannot drift. The per-document
 * checks live in doctor-backlog-plans.ts (the plan-document structure and fix-claim checks) and
 * doctor-backlog-bugs.ts (open bugs, questions and holds). All of them warn instead of failing:
 * damaged documentation is operator signal, not a broken environment. doctor.ts composes them
 * beside the environment checks; the shared CheckOutcome shape is imported from
 * doctor-outcome.ts. */

/** How many Fixed records the two newest-first Fixed-record checks (fix claims and validation
 * gaps) verify: the newest, since the section is newest-first by template convention. Older
 * records drift as the code evolves — a symbol legitimately fixed long ago gets renamed later,
 * and pre-convention Fixed entries predate the validation-gap line — so a whole-section scan
 * would warn forever on records nobody should rewrite. */
export const FIX_CLAIMS_CHECKED = 10;

/** A cited record's heading is trimmed to this many characters in a doctor warn — enough to
 * find it back in its file; quoteHeading applies it to every citation. */
const FIX_CLAIM_HEADING_MAX = 60;

/** A refused entry's note is trimmed to this many characters in the refusals warn. */
export const REFUSAL_NOTE_MAX = 120;

/** The whole days an open question may wait before the stale-questions check warns about it:
 * an opinionated default, matching the 7-day window the `--list` age is meant to surface.
 * A question awaiting a human answer is operator signal, so the value needs no knob. */
export const STALE_QUESTION_DAYS = 7;

/** The whole days an open bug may wait before the stale-bugs check warns about it: an
 * opinionated default with no knob, like STALE_QUESTION_DAYS. Three days is long enough that a
 * bug filed late one evening and fixed the next day never warns. */
export const STALE_BUG_DAYS = 3;

/** The `(and N more …)` suffix three one-line doctor details append after naming their first
 * suspect (fix claims, stranded plans, duplicated headings): the rest stay visible but
 * shortened, since a doctor check renders one line. `render` makes each extra item's short
 * form — the fix-claim and stranded-plan sites quote a heading trimmed to
 * FIX_CLAIM_HEADING_MAX, the duplicate-headings site passes its items through as built;
 * `noun` names what the extras are and must already agree with `rest.length` — callers pass
 * `agree(rest.length, "record", "records")`, or empty where no noun is named.
 * Empty string when there are no extras. */
export function andMore<T>(rest: readonly T[], render: (item: T) => string, noun = ""): string {
  return rest.length > 0
    ? ` (and ${rest.length} more${noun ? ` ${noun}` : ""}: ${rest.map(render).join(", ")})`
    : "";
}

/** Quote a heading/summary in a doctor sentence, truncated to FIX_CLAIM_HEADING_MAX so a check
 * stays one line: `"…"`. The doctor's citations all quote-then-truncate the same way; this is
 * the one home for that shape. */
export function quoteHeading(title: string): string {
  return `"${truncate(title, FIX_CLAIM_HEADING_MAX)}"`;
}

/** Read one backlog file for a check, or the failure message explaining why it could not be
 * read (text.ts's errorMessage). Callers shape the failure themselves — a returned warn for a
 * single-file check, an "(unreadable)" list entry for the multi-file heading sweep. */
export function readDoc(p: string): { doc: string } | { error: string } {
  try {
    return { doc: fs.readFileSync(p, "utf8") };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** The single-file check's read prologue: an absent file is that check's own "nothing to
 * verify" ok outcome, an unreadable one a warn naming the file. Returns the document, or the
 * outcome the caller should return as-is. The per-file doctor checks go through readBacklogChecked.
 * */
export function readDocChecked(p: string, file: string, missingDetail: string): string | CheckOutcome {
  if (!fs.existsSync(p)) return okOutcome(missingDetail);
  const read = readDoc(p);
  if ("error" in read) return warnOutcome(`cannot read ${file} — ${read.error}`);
  return read.doc;
}

/** The standard single-file check's read prologue for a backlog document at `root`: the
 * readDocChecked call every per-file doctor check (checkFixClaims, checkValidationGaps,
 * checkStrandedPlans, checkStaleQuestions, and the stale bug checks) repeats, with the
 * `no <file> — nothing to verify` missing-detail derived from the file name so the file triple
 * (path, display name, message) and the message template cannot drift across the seven call
 * sites. Returns the document, or the outcome the caller should return as-is. */
export function readBacklogChecked(root: string, file: string): string | CheckOutcome {
  return readDocChecked(path.join(root, file), file, `no ${file} — nothing to verify`);
}

/** How long a queued merge may wait without its change starting before the stale-queued-merge check
 * warns: 6 hours, fixed. A verify plus a merge completes in minutes (plans/merge-queue.md), so a
 * full six-hour silence while the team is healthy — not on a hold, which doctor already reports
 * separately — is never a merely busy pipeline: it reads as a drain that has stalled. The one
 * opinionated default, like STALE_QUESTION_DAYS, so no knob (the dead-alert feed is gone; the
 * STALE_PROMPT_MS/STALE_BUG_DAYS precedent). */
const MERGE_QUEUE_STALE_MS = 6 * HOUR_MS;
/** The window of the merge-wait phrase on the stale merge-queue row. */
const MERGE_WAIT_WINDOW_MS = DAY_MS;

/** Stale queued merges — a change that has sat in the durable merge queue too long without starting
 * (plans/merge-queue.md). Every queued-change health fact is otherwise a hook into its own role or
 * stage: a verify under way reads in the team row, a team hold gets its own banner, and
 * team-alerts' STALL_RE catches a RUNNING stage frozen. But a change (or a batch behind the single
 * merge slot) that quietly never starts — neither verified nor flagged — reads as healthy: the
 * header's `merge queue: N` badge counts it and `tumwater queue` ages it, yet nothing calls it out
 * on its own. This names the single oldest queued merge that is NOT currently in-flight and has
 * waited past MERGE_QUEUE_STALE_MS, so an operator sees a stalled drain instead of only a growing
 * depth. The in-flight marker (readMergeMarker via mergeChanges) contributes the set of roles
 * holding a change being verified or merged right now — a slow review is not a stalled drain, and
 * an absent or never-throwing unreadable marker contributes the empty set. Reads the tree at `root`
 * with the already-exported readers, changing nothing in src/merge/. A warn, never a fail — the
 * checkStaleQuestions/checkStalledEntries precedent: a queued wait is legitimate while the team is
 * genuinely held, and those holds already warn separately. */
export function checkStaleQueuedMerges(root: string, now: number): CheckOutcome {
  const withWait = (out: CheckOutcome): CheckOutcome => {
    let phrase: string | undefined;
    try {
      phrase = mergeWaitPhrase(eventsSince(root, MERGE_WAIT_WINDOW_MS, now));
    } catch {
      return out; // an unreadable event log never changes this row's level
    }
    return phrase ? { ...out, detail: `${out.detail} · ${phrase}` } : out;
  };
  const stale = staleQueuedMergeRows(root, now).map((e) => ({ ...e, age: humanSeconds(secondsSince(now - e.waitedMs, now)) }));
  const [first, ...rest] = stale;
  if (!first)
    return withWait(okOutcome(`no merge-queue entry has waited more than ${humanSeconds(MERGE_QUEUE_STALE_MS / 1000)} to start`));
  const more = andMore(rest, (e) => `${e.role} — ${quoteHeading(e.summary)}`);
  return withWait(warnOutcome(`merge-queue entry of ${roleLabel(first.role)} — ${quoteHeading(first.summary)} — has waited ` +
      `${first.age} to start${more}; a queued change the pipeline neither approves nor flags reads as healthy, so the merge queue has stopped moving`));
}

/** The one traversal for the doctor's `stale merge-queue entries` row
 * (checkStaleQueuedMerges): every queued merge whose role is not in the in-flight
 * marker and whose wait strictly exceeds MERGE_QUEUE_STALE_MS (6 h), in queue-file order (oldest
 * first). The in-flight set comes from readMergeMarker via mergeChanges (an absent or
 * never-throwing unreadable marker contributes the empty set) — a slow review is not a stalled
 * drain. Each row carries { role, summary, waitedMs }, which the row renders with its age
 * phrase, so the rule and its threshold live in one place and cannot drift. */
function staleQueuedMergeRows(root: string, now: number): Array<{ role: string; summary: string; waitedMs: number }> {
  const marker = readMergeMarker(root);
  const inFlight = new Set(marker ? mergeChanges(marker).map((c) => c.role) : []);
  return queuedMerges(root)
    .filter((e) => !inFlight.has(e.role) && now - e.enqueuedAt > MERGE_QUEUE_STALE_MS)
    .map((e) => ({ role: e.role, summary: e.summary, waitedMs: now - e.enqueuedAt }));
}

/** The merge-queue files `readMergeQueue` skips — torn, foreign, or vanished mid-listing — as
 * checkout-relative paths. The one traversal behind the doctor's `checkMergeQueueFiles` row, so
 * the row names the same paths the reader actually skips and cannot drift. */
export function skippedMergeQueueFiles(root: string): string[] {
  return unreadableMergeQueueFiles(root).map((f) => path.relative(root, f));
}

/** The merge-queue files `readMergeQueue` skips — torn, foreign, or vanished mid-listing —
 * named so a stranded queue entry is a health signal instead of only a number on `tumwater
 * queue`'s output. It exists because `tumwater queue` counts the skips but does not name them,
 * and the drain drops only an unreadable head, so a non-head skip is otherwise silent: it sits
 * in `.tumwater/merge-queue/` forever, never drained, and neither the queue reader nor the
 * stale-queued-merges doctor row (which reads only readable entries) surfaces it. Warn, never
 * fail, like the module's other document checks: a foreign file is operator signal, not a
 * broken environment. */
export function checkMergeQueueFiles(root: string): CheckOutcome {
  const files = skippedMergeQueueFiles(root);
  if (files.length === 0) return okOutcome("the queue reader skips no merge-queue file");
  const [first, ...rest] = files;
  const more = andMore(rest, (f) => f, agree(rest.length, "file", "files"));
  return warnOutcome(`the merge queue holds ${plural(files.length, "file")} the reader skips — ${first!}${more}; ` +
    `a torn or foreign file is never cleared, so nothing ages it or surfaces its merge — remove it (a crashed enqueue's merge ref still recovers on the next run)`);
}

/** A post-merge review (src/review/post-merge-review.ts, POST_REVIEW_FAILURE_LIMIT) whose
 * `failures` is at or above POST_REVIEW_AT_RISK_FAILURES — the entry the next failed run drops.
 * `commit` is the reviewed commit's full sha, `role` the reviewing role, `summary` its one-line
 * change, `failures` how many runs have ended without a verdict. */
interface AtRiskPostReview {
  commit: string;
  role: string;
  summary: string;
  failures: number;
}

/** The failures count at which a post-merge review is one failed run from being dropped: one
 * below POST_REVIEW_FAILURE_LIMIT, so the drain's drop limit and this at-risk bar cannot drift
 * (the STALE_BUG_DAYS precedent). A review at this bar has as many unreviewed failures as the
 * drain allows before it drops the commit from the queue forever. */
export const POST_REVIEW_AT_RISK_FAILURES = POST_REVIEW_FAILURE_LIMIT - 1;

/** The post-merge reviews one failed run from being dropped, in file (FIFO) order: every entry
 * whose `failures` is at least POST_REVIEW_AT_RISK_FAILURES, each with `commit`, `role`,
 * `summary` and `failures` carried out (a missing failures reads as 0, so it is never at risk).
 * A review that has already been rejected is left out: the drain settles a rejection as
 * `{ ...entry, rejected }` (it preserves `failures`) and never re-runs it, so a rejected commit
 * is not waiting on a verdict and must not read as one failed run from being dropped.
 * A review that has already landed its fix (`fixed` set) is left out too — it is a settled
 * record naming both shas, not a verdict-less entry the next run could drop.
 * One traversal used by the doctor's `post-merge reviews` row (checkPostReviews), so the row's
 * selection lives in one place. Reads .tumwater/state/post-review.json
 * through readPostReviews, which degrades a missing or torn file to the well-formed subset or
 * `[]` and never throws. */
export function atRiskPostReviews(root: string): AtRiskPostReview[] {
  return readPostReviews(root)
    .filter((e) => e.rejected === undefined && e.fixed === undefined && (e.failures ?? 0) >= POST_REVIEW_AT_RISK_FAILURES)
    .map((e) => ({ commit: e.commit, role: e.role, summary: e.summary, failures: e.failures ?? 0 }));
}

/** The doctor's one sentence naming the post-merge reviews one failed run from being dropped
 * (the checkStaleQueuedMerges phrase precedent): the first in full — role, short commit, summary
 * and the failures count — the rest folded through andMore, the one sentence the row shows, so
 * the wording lives in one place. null for an empty list. */
export function atRiskPostReviewsPhrase(rows: readonly AtRiskPostReview[]): string | null {
  const [first, ...rest] = rows;
  if (!first) return null;
  const more = andMore(rest, (r) => `${roleLabel(r.role)} ${shortSha(r.commit)}`);
  return `the post-merge review of ${roleLabel(first.role)} ${shortSha(first.commit)} — ${quoteHeading(first.summary)} — has ended without a verdict ${first.failures} times${more}; ` +
    `one more failed run drops it and the commit stays on main unreviewed — fix the reviewer backend or accept the commit unreviewed deliberately`;
}

/** A post-merge review one failed run from being dropped (src/review/post-merge-review.ts, the
 * drain drops an entry at POST_REVIEW_FAILURE_LIMIT failed runs) — the last moment an operator
 * can fix the reviewer backend or deliberately accept the commit unreviewed before the drain
 * drops it from the queue and it stays on main unreviewed. Reads .tumwater/state/post-review.json
 * through the shared atRiskPostReviews traversal, so the selection and wording live in one
 * place. A warn,
 * never a fail — the checkStaleQueuedMerges precedent: a failing reviewer is operator signal,
 * not a broken environment; readPostReviews never throws (a missing or torn file degrades to the
 * well-formed subset or `[]`), so the check needs no read-error arm. */
export function checkPostReviews(root: string): CheckOutcome {
  const rows = atRiskPostReviews(root);
  const phrase = atRiskPostReviewsPhrase(rows);
  return phrase === null ? okOutcome("no post-merge review is one failed run from being dropped") : warnOutcome(phrase);
}

/** How long a queued prompt may wait for its role to dequeue it before the stale-prompt check
 * warns: a day, fixed. An opinionated default with no knob, like MERGE_QUEUE_STALE_MS: a day is
 * long enough that a healthy role's next run would have dequeued the prompt, and short enough
 * that a paused or disabled role's stranded prompt shows up. The stale-prompt check reads this
 * same threshold, so it cannot drift — the STALE_BUG_DAYS precedent. */
const STALE_PROMPT_MS = DAY_MS;

/** The queued inbox prompts the doctor's stale-prompt rule calls stale — deliverable now (a
 * `--at` prompt still counting down is never stale) and queued more than STALE_PROMPT_MS,
 * oldest-first, `queuedAtMs` narrowed to a number. One traversal shared by the doctor's
 * `checkStalePrompts` check, so the rule lives in one place at one threshold. */
function staleQueuedPromptRows(root: string, now: number): Array<QueuedListRow & { queuedAtMs: number }> {
  return queuedListRows(root, null, listWideScope(root))
    .filter((p) => p.queuedAtMs !== null && deliverableAt(p.notBeforeMs, now) && now - p.queuedAtMs > STALE_PROMPT_MS)
    .sort((a, b) => (a.queuedAtMs as number) - (b.queuedAtMs as number))
    .map((p) => ({ ...p, queuedAtMs: p.queuedAtMs as number }));
}

/** Stale queued prompts — a prompt queued for a role (`tumwater prompt --role <id>`, the
 * dashboard composer, the TUI, a `--at` delay whose time has now passed) that has waited more
 * than a day for that role to dequeue it. A role that is paused, disabled, or failing never
 * reaches the run that would dequeue the prompt, so it waits indefinitely and only the Inbox
 * views (`tumwater prompt --list`, the dashboard Inbox tab, the TUI Inbox pane) show its age —
 * and only when the operator looks. This names the oldest due-but-undelivered prompt, its role,
 * and the deliver-or-drop commands. Reads the queue through the shared `staleQueuedPromptRows`
 * traversal (no new reader in src/inbox/), keeping only
 * rows that are deliverable now — a `--at 7d` prompt still counting down is never stale — and
 * stamped more than STALE_PROMPT_MS ago. A warn, never a fail — the checkStaleQueuedMerges
 * precedent: a stranded prompt is operator signal, not a broken environment. */
export function checkStalePrompts(root: string, now: number): CheckOutcome {
  const stale = staleQueuedPromptRows(root, now);
  const [first, ...rest] = stale;
  if (!first) return okOutcome("no queued prompt has waited more than 1 day for a role to dequeue it");
  const more = andMore(rest, (p) => `${p.role} #${p.position}`);
  return warnOutcome(`inbox prompt for ${roleLabel(first.role)} #${first.position} has waited ${humanSeconds(secondsSince(first.queuedAtMs, now))} — ` +
    "the role is not dequeuing it (paused, disabled, or failing); resume or enable it, or drop the prompt with " +
    `\`tumwater prompt --cancel ${first.position} --role ${first.role}\`${more}`);
}

/** How long merges that reached main waited: the lower median and the longest `queuedMs` of the
 * `merge_done` events given, undefined when none qualifies. The wait runs from the entry's last
 * enqueue to its outcome, so it includes the merge check. A merge logged before `queuedMs` existed
 * (missing or 0) is skipped, and a `merge_failed` is not a wait that ended on main. */
export function mergeWaitPhrase(events: readonly HarnessEvent[]): string | undefined {
  const waits = events
    .filter((e) => e.type === "merge_done")
    .map((e) => finiteNumber(e.queuedMs, 0))
    .filter((ms) => ms > 0);
  if (waits.length === 0) return undefined;
  const median = lowerMedian(waits);
  const longest = Math.max(...waits);
  return `merges in the last 24h waited ${shortSpanPhrase(median)} median, ${shortSpanPhrase(longest)} longest (${plural(waits.length, "merge")})`;
}

/** The dirty tracked backlog/brief files in the primary checkout, factored out of
 * checkUncommittedBacklog so the `doctor --commit-backlog` recovery acts on exactly the set the
 * check warns about. `base` is the target base branch, `primary` the checkout's current branch
 * (null when it cannot be read), `watched` the tracked backlog/brief files, and `dirty` the
 * non-untracked names among them (null when the `git status` read fails). */
export interface DirtyBacklogFiles {
  base: string;
  primary: string | null;
  watched: string[];
  dirty: string[] | null;
}

/** Discover the tracked backlog/brief files with uncommitted edits in the primary checkout (the
 * shared discovery behind checkUncommittedBacklog and commitUncommittedBacklog). A primary off
 * the base branch is skipped by its callers: the ref-push merge arm leaves its working tree
 * alone. Untracked files are not edits of a tracked file and are ignored. */
export async function dirtyBacklogFiles(root: string, config: TumwaterConfig | undefined): Promise<DirtyBacklogFiles> {
  const primary = await currentBranch(root);
  const base = targetBranch(config?.baseBranch, primary);
  // A primary off the base branch is skipped by every caller before it reads `watched`/`dirty`, so
  // the brief is not touched here either: an unreadable brief must not turn that skip into a throw
  // (the ref-push merge arm leaves an off-base working tree alone).
  if (primary === null || primary !== base) return { base, primary, watched: [], dirty: [] };
  let brief: string | null = null;
  try {
    brief = briefFile(root);
  } catch {
    // An unreadable brief is a doctor finding of its own; it must not abort the uncommitted-backlog
    // check or `--commit-backlog`, so the tracked backlog set is watched without it.
  }
  const watched = [...new Set([...BACKLOG_FILES, ...(brief ? [brief] : [])])];
  const out = await gitTry(root, "status", "--porcelain", "--", ...watched);
  if (out === null) return { base, primary, watched, dirty: null };
  const dirtySet = new Set(out.split("\n")
    .filter((line) => line.length > 3 && !line.startsWith("??"))
    .map((line) => line.slice(3)));
  return { base, primary, watched, dirty: watched.filter((f) => dirtySet.has(f)) };
}

/** Names the backlog files (and the brief file) with uncommitted edits in the primary checkout. An
 * operator write is meant to be committed on the base branch by commitOperatorBacklogEdit; when
 * that commit does not happen the edit is invisible to every role worktree (they branch from main)
 * and a merge that touches the file cannot fast-forward the checkout (merge_blocked). A primary off
 * the base branch is skipped: the ref-push merge arm leaves its working tree alone. Untracked files
 * are not edits of a tracked file and are ignored. */
export async function checkUncommittedBacklog(root: string, config: TumwaterConfig | undefined): Promise<CheckOutcome> {
  const { base, primary, watched, dirty } = await dirtyBacklogFiles(root, config);
  if (primary === null || primary !== base) {
    return okOutcome(`your checkout is not on ${base}; backlog writes from you are not committed from it`);
  }
  if (dirty === null) return okOutcome("could not read git status; skipped");
  if (dirty.length === 0) {
    const list = watched.slice(0, -1).join(", ");
    return okOutcome(`${list} and ${watched[watched.length - 1]} are committed`);
  }
  const list = dirty.join(", ");
  return warnOutcome(`${list} ${dirty.length > 1 ? "have" : "has"} uncommitted changes in your checkout — ` +
    `roles branch from main and do not see them, and a merge that touches one cannot fast-forward the checkout ` +
    `(merge_blocked); review them with \`git diff -- ${list}\` and commit them on ${base} ` +
    `(or run \`tumwater doctor --commit-backlog\`, or the Health card's Commit backlog, or the TUI Health tab's Ctrl+A)`);
}

/** What `doctor --commit-backlog` did: the base branch it committed on, the files it committed,
 * the ones whose commit failed (still dirty — already staged, already committed by a concurrent
 * write, or a git error), and a skip sentence when the primary is off the base branch or the git
 * status could not be read. */
export interface BacklogCommitReport {
  base: string;
  committed: string[];
  failed: string[];
  skipped: string | null;
}

/** Commit every dirty tracked backlog or brief file in the primary checkout on the base branch,
 * through the same commitOperatorBacklogEdit core every operator backlog write uses, running
 * under the primary-worktree lock it takes. The dirtyBacklogFiles discovery and branch precedence
 * are checkUncommittedBacklog's own, so a `tumwater doctor --commit-backlog` unblocks exactly the
 * merges the `uncommitted backlog` row warns would be blocked. When the primary is off the base
 * branch or the status cannot be read it commits nothing and reports a skip sentence; a file whose
 * commit fails stays dirty and lands in `failed` while the other listed files are still attempted.
 * Never throws. */
export async function commitUncommittedBacklog(root: string, config: TumwaterConfig | undefined): Promise<BacklogCommitReport> {
  const d = await dirtyBacklogFiles(root, config);
  if (d.primary === null || d.primary !== d.base)
    return { base: d.base, committed: [], failed: [], skipped: `your checkout is not on ${d.base}; nothing committed` };
  if (d.dirty === null)
    return { base: d.base, committed: [], failed: [], skipped: "could not read git status; nothing committed" };
  const committed: string[] = [];
  const failed: string[] = [];
  for (const name of d.dirty) {
    const ok = await commitOperatorBacklogEdit(root, name, stampedSubject("operator", `Commit uncommitted ${name}`)); // vocabulary-ok: the tumwater(operator): commit prefix is a machine string
    (ok ? committed : failed).push(name);
  }
  return { base: d.base, committed, failed, skipped: null };
}

/** The committed/failed/skip wording the CLI, the dashboard handler and the TUI flash all share
 * for a BacklogCommitReport, so the three surfaces cannot drift: one `committed <file> on
 * <base>` line per committed file, one `could not commit <file> — commit it by hand` line per
 * failed file, then the skipped sentence when set. `[]` when the report committed nothing,
 * failed nothing, and carried no skip sentence. `tumwater doctor --commit-backlog` (src/cli.ts),
 * the dashboard Health card's Commit backlog (handleCommitBacklog) and the TUI Health tab's
 * Ctrl+A all render from this one source. */
export function backlogCommitLines(report: BacklogCommitReport): string[] {
  const lines = [
    ...report.committed.map((file) => `committed ${file} on ${report.base}`),
    ...report.failed.map((file) => `could not commit ${file} — commit it by hand`),
  ];
  if (report.skipped !== null) lines.push(report.skipped);
  return lines;
}

/** The single-line message a surface flashes or answers for a BacklogCommitReport: the shared
 * backlogCommitLines joined with "; ", or the nothing-to-commit sentence when the report
 * committed nothing, failed nothing and carried no skip sentence. Lives here beside
 * backlogCommitLines so the dashboard Health card's Commit backlog handler and the TUI Health
 * tab's Ctrl+A flash cannot drift from each other. */
export function backlogCommitMessage(report: BacklogCommitReport): string {
  const lines = backlogCommitLines(report);
  return lines.length ? lines.join("; ") : "nothing to commit — every watched backlog or brief file is committed";
}
