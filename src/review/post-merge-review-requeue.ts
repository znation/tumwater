/** `tumwater reviews --requeue-dropped --since <day>` (BUGS.md): put back in the post-merge review
 * queue the commits the event log records as dropped from it — a `review_dropped` event (full
 * commit sha, `source` role, `summary`) and the legacy "dropping the post-merge review of <short
 * sha> …" warning (its `source` is the role; the short sha resolves to one commit, and the
 * summary is that commit's subject). Only a commit on main is queued, and a commit already in the
 * queue is left alone, so a second run queues nothing new. Reads the event log from `since` on
 * (rotated files included) and writes the queue only through addPostReview. */

import { readWindowEvents } from "../events/event-window.js";
import { gitTry } from "../git/git-run.js";
import { isMergedInto, subjectOfCommit } from "../git/git.js";
import { addPostReview, readPostReviews } from "./post-merge-review.js";

/** The legacy drop warning's prefix and its short sha (the text `warnEventBestEffort` wrote). */
const LEGACY_DROP = /^dropping the post-merge review of ([0-9a-f]{4,40}) /;

const FULL_SHA = /^[0-9a-f]{40}$/;

interface RequeueDroppedResult {
  since: string;
  queued: number;
  skipped: { alreadyQueued: number; notOnMain: number; unresolved: number };
}

/** One dropped commit the log names. `summary` is undefined for a legacy warning, whose summary
 * is the commit's subject, read when the commit is queued. */
interface DroppedCommit {
  commit: string;
  role: string;
  summary?: string;
}

/** The drops the log holds from `since` on, oldest first, plus the count of legacy warnings whose
 * short sha resolves to no single commit (unknown, or ambiguous). A `review_dropped` event whose
 * commit is not a full sha is counted the same way, so it never reaches git. */
async function droppedCommits(root: string, since: string): Promise<{ drops: DroppedCommit[]; unresolved: number }> {
  const drops: DroppedCommit[] = [];
  let unresolved = 0;
  for (const event of readWindowEvents(root, since).events) {
    // A string-typed read of `type`: the drop path writes `review_dropped`, and the reader
    // narrows every payload field it uses, so an older or torn line is counted unresolved.
    const type: string = event.type;
    if (type === "review_dropped") {
      if (typeof event.commit === "string" && FULL_SHA.test(event.commit) && typeof event.source === "string") {
        drops.push({ commit: event.commit, role: event.source, summary: typeof event.summary === "string" ? event.summary : "" });
      } else {
        unresolved++;
      }
      continue;
    }
    const match = type === "warning" && typeof event.message === "string" ? LEGACY_DROP.exec(event.message) : null;
    if (match === null || typeof event.source !== "string") continue;
    const full = await gitTry(root, "rev-parse", "--verify", "--quiet", `${match[1]!}^{commit}`);
    if (full === null) {
      unresolved++;
      continue;
    }
    drops.push({ commit: full.trim(), role: event.source });
  }
  return { drops, unresolved };
}

/** Queue each dropped commit on main that the queue does not already hold; the result counts what
 * was queued and what was skipped, and why. A commit named twice is judged once, at its first
 * mention. */
export async function requeueDroppedReviews(root: string, since: string, mainBranch: string): Promise<RequeueDroppedResult> {
  const { drops, unresolved } = await droppedCommits(root, since);
  const result: RequeueDroppedResult = { since, queued: 0, skipped: { alreadyQueued: 0, notOnMain: 0, unresolved } };
  const queued = new Set(readPostReviews(root).map((e) => e.commit));
  const judged = new Set<string>();
  for (const drop of drops) {
    if (judged.has(drop.commit)) continue;
    judged.add(drop.commit);
    if (queued.has(drop.commit)) {
      result.skipped.alreadyQueued++;
      continue;
    }
    if (!(await isMergedInto(root, drop.commit, mainBranch))) {
      result.skipped.notOnMain++;
      continue;
    }
    const summary = drop.summary ?? (await subjectOfCommit(root, drop.commit));
    addPostReview(root, { commit: drop.commit, role: drop.role, summary });
    queued.add(drop.commit);
    result.queued++;
  }
  return result;
}
