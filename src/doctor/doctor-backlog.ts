import { roleLabel } from "../roles/role-labels.js";
import fs from "node:fs";
import path from "node:path";
import { errorMessage, truncate } from "../text/text.js";
import { humanSeconds, secondsSince, HOUR_MS, DAY_MS } from "../text/datetime.js";
import type { HarnessEvent } from "../events/events.js";
import { eventsSince } from "../events/event-window.js";
import { finiteNumber } from "../files/json-object.js";
import { lowerMedian } from "../collections.js";
import { plural, shortSpanPhrase } from "../text/phrases.js";
import { queuedMerges, unreadableMergeQueueFiles } from "../merge/merge-queue.js";
import { mergeChanges, readMergeMarker } from "../merge/merge-slot.js";
import { listWideScope, queuedListRows, type QueuedListRow } from "../inbox/inbox.js";
import { deliverableAt } from "../inbox/prompt-not-before.js";
import { currentBranch, targetBranch } from "../git/git.js";
import { gitTry } from "../git/git-run.js";
import { briefFile } from "../brief/brief.js";
import { BACKLOG_FILES } from "../backlog/backlog-md.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./outcome.js";

/** The doctor's backlog modules' shared scaffolding and the check groups that do not read a
 * single backlog document: the merge-queue and queued-prompt checks (checkStaleQueuedMerges,
 * checkMergeQueueFiles, checkStalePrompts and the mergeWaitPhrase helper) and the uncommitted-
 * edits-in-the-primary-checkout check. This module also hosts the helpers and constants the
 * per-document checks import — readDoc and its checked wrapper readDocChecked, andMore, and the
 * age/heading-trim bounds — so the per-document reads cannot drift. The per-document
 * checks live in doctor-backlog-plans.ts (the plan-document structure and fix-claim checks) and
 * doctor-backlog-bugs.ts (open bugs, questions and holds). All of them warn instead of failing:
 * damaged documentation is operator signal, not a broken environment. doctor.ts composes them
 * beside the environment checks; the shared CheckOutcome shape is imported from outcome.ts. */

/** How many Fixed records the two newest-first Fixed-record checks (fix claims and validation
 * gaps) verify: the newest, since the section is newest-first by template convention. Older
 * records drift as the code evolves — a symbol legitimately fixed long ago gets renamed later,
 * and pre-convention Fixed entries predate the validation-gap line — so a whole-section scan
 * would warn forever on records nobody should rewrite. */
export const FIX_CLAIMS_CHECKED = 10;

/** A second or later suspect record's heading is trimmed to this many characters in the warn —
 * the first is named in full, the rest only enough to find them in BUGS.md. */
export const FIX_CLAIM_HEADING_MAX = 60;

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

/** The whole days a bug may stay held by a Waiting for the next failure note before the
 * waiting-bugs check warns that its flake has not come back. A note parks a bug until it fails
 * again, but the failure may never come, so a hold has to lapse or the entry parks indefinitely;
 * one week without a recurrence is long enough that a recurring flake would almost surely have
 * shown up, and short enough that a bug which never returns stops squatting in the backlog as
 * an ok. An opinionated default with no knob, like STALE_BUG_DAYS. */
export const STALE_WAIT_DAYS = 7;

/** The `(and N more …)` suffix three one-line doctor details append after naming their first
 * suspect (fix claims, stranded plans, duplicated headings): the rest stay visible but
 * shortened, since a doctor check renders one line. `render` makes each extra item's short
 * form — the fix-claim and stranded-plan sites quote a heading trimmed to
 * FIX_CLAIM_HEADING_MAX, the duplicate-headings site passes its items through as built;
 * `noun` names what the extras are ("record(s)" for fix claims, empty for the other two).
 * Empty string when there are no extras. */
export function andMore<T>(rest: readonly T[], render: (item: T) => string, noun = ""): string {
  return rest.length > 0
    ? ` (and ${rest.length} more${noun ? ` ${noun}` : ""}: ${rest.map(render).join(", ")})`
    : "";
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

/** The single-file check's read prologue, shared by checkFixClaims and checkStrandedPlans:
 * an absent file is that check's own "nothing to verify" ok outcome, an unreadable one a warn
 * naming the file. Returns the document, or the outcome the caller should return as-is. */
export function readDocChecked(p: string, file: string, missingDetail: string): string | CheckOutcome {
  if (!fs.existsSync(p)) return okOutcome(missingDetail);
  const read = readDoc(p);
  if ("error" in read) return warnOutcome(`cannot read ${file} — ${read.error}`);
  return read.doc;
}

/** How long a queued merge may wait without its change starting before the stale-queued-merge check
 * warns: 6 hours, fixed. A verify plus a merge completes in minutes (plans/merge-queue.md), so a
 * full six-hour silence while the team is healthy — not on a hold, which doctor already reports
 * separately — is never a merely busy pipeline: it reads as a drain that has stalled. The one
 * opinionated default, like STALE_QUESTION_DAYS, so no knob. The always-on `stale-merges` team
 * alert (src/ui/status-payload.ts staleMerges) reuses this same window through
 * staleQueuedMergeRows, so the doctor's row and the alert cannot drift on the threshold (the
 * STALE_PROMPT_MS/STALE_BUG_DAYS precedent). */
export const MERGE_QUEUE_STALE_MS = 6 * HOUR_MS;
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
 * checkStaleQuestions/checkStalledPlans precedent: a queued wait is legitimate while the team is
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
  const more = andMore(rest, (e) => `${e.role} — "${truncate(e.summary, FIX_CLAIM_HEADING_MAX)}"`);
  return withWait(warnOutcome(`merge-queue entry of ${roleLabel(first.role)} — "${truncate(first.summary, FIX_CLAIM_HEADING_MAX)}" — has waited ` +
      `${first.age} to start${more}; a queued change the pipeline neither approves nor flags reads as healthy, so the merge queue has stopped moving`));
}

/** The one traversal shared by the doctor's `stale merge-queue entries` row
 * (checkStaleQueuedMerges) and the always-on `stale-merges` team alert
 * (src/ui/status-payload.ts staleMerges): every queued merge whose role is not in the in-flight
 * marker and whose wait strictly exceeds MERGE_QUEUE_STALE_MS (6 h), in queue-file order (oldest
 * first). The in-flight set comes from readMergeMarker via mergeChanges (an absent or
 * never-throwing unreadable marker contributes the empty set) — a slow review is not a stalled
 * drain. Each row carries { role, summary, waitedMs }; the doctor's row adds its age phrase and
 * the alert names the wait, so the rule and its threshold live in one place and cannot drift. */
export function staleQueuedMergeRows(root: string, now: number): Array<{ role: string; summary: string; waitedMs: number }> {
  const marker = readMergeMarker(root);
  const inFlight = new Set(marker ? mergeChanges(marker).map((c) => c.role) : []);
  return queuedMerges(root)
    .filter((e) => !inFlight.has(e.role) && now - e.enqueuedAt > MERGE_QUEUE_STALE_MS)
    .map((e) => ({ role: e.role, summary: e.summary, waitedMs: now - e.enqueuedAt }));
}

/** The merge-queue files `readMergeQueue` skips — torn, foreign, or vanished mid-listing — as
 * checkout-relative paths. One traversal shared by the doctor's `checkMergeQueueFiles` row and
 * the always-on `skipped-merges` team alert (src/ui/status-payload.ts skippedMergeFiles), so
 * the two surfaces select the same files and name the same paths and cannot drift. */
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
  const more = andMore(rest, (f) => f, "file(s)");
  return warnOutcome(`the merge queue holds ${plural(files.length, "file")} the reader skips — ${first!}${more}; ` +
    `a torn or foreign file is never cleared, so nothing ages it or surfaces its merge — remove it (a crashed enqueue's merge ref still recovers on the next run)`);
}

/** How long a queued prompt may wait for its role to dequeue it before the stale-prompt check
 * warns: a day, fixed. An opinionated default with no knob, like MERGE_QUEUE_STALE_MS: a day is
 * long enough that a healthy role's next run would have dequeued the prompt, and short enough
 * that a paused or disabled role's stranded prompt shows up. The always-on stale-prompt team
 * alert (src/ui/status-payload.ts stalePrompts) reuses this same threshold, so it cannot drift
 * from the doctor's check — the STALE_BUG_DAYS precedent. */
export const STALE_PROMPT_MS = DAY_MS;

/** The queued inbox prompts the doctor's stale-prompt rule calls stale — deliverable now (a
 * `--at` prompt still counting down is never stale) and queued more than STALE_PROMPT_MS,
 * oldest-first, `queuedAtMs` narrowed to a number. One traversal shared by the doctor's
 * `checkStalePrompts` check and the always-on `stalePrompts` team alert (src/ui/status-payload.ts),
 * so the two surfaces read the same rule at the same threshold and cannot drift. */
export function staleQueuedPromptRows(root: string, now: number): Array<QueuedListRow & { queuedAtMs: number }> {
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
 * traversal the always-on stale-prompts alert uses (no new reader in src/inbox/), keeping only
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

/** Names the backlog files (and the brief file) with uncommitted edits in the primary checkout. An
 * operator write is meant to be committed on the base branch by commitOperatorBacklogEdit; when
 * that commit does not happen the edit is invisible to every role worktree (they branch from main)
 * and a merge that touches the file cannot fast-forward the checkout (merge_blocked). A primary off
 * the base branch is skipped: the ref-push merge arm leaves its working tree alone. Untracked files
 * are not edits of a tracked file and are ignored. */
export async function checkUncommittedBacklog(root: string, config: TumwaterConfig | undefined): Promise<CheckOutcome> {
  const primary = await currentBranch(root);
  const base = targetBranch(config?.baseBranch, primary);
  if (primary === null || primary !== base) {
    return okOutcome(`your checkout is not on ${base}; backlog writes from you are not committed from it`);
  }
  const brief = briefFile(root);
  const files = [...new Set([...BACKLOG_FILES, ...(brief ? [brief] : [])])];
  const out = await gitTry(root, "status", "--porcelain", "--", ...files);
  if (out === null) return okOutcome("could not read git status; skipped");
  const dirty = new Set(out.split("\n")
    .filter((line) => line.length > 3 && !line.startsWith("??"))
    .map((line) => line.slice(3)));
  const named = files.filter((f) => dirty.has(f));
  if (named.length === 0) {
    const list = files.slice(0, -1).join(", ");
    return okOutcome(`${list} and ${files[files.length - 1]} are committed`);
  }
  const list = named.join(", ");
  return warnOutcome(`${list} ${named.length > 1 ? "have" : "has"} uncommitted changes in your checkout — ` +
    `roles branch from main and do not see them, and a merge that touches one cannot fast-forward the checkout ` +
    `(merge_blocked); review them with \`git diff -- ${list}\` and commit them on ${base}`);
}
