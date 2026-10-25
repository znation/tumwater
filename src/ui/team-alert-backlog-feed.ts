/** The backlog-feed team alerts, in emission order: stale open bugs, a failed notify page,
 * waiting bugs, stranded inbox prompts, a stalled merge queue, skipped merge-queue files, and
 * merges refused by an uncommitted primary checkout. One of the per-domain builders split out of
 * src/ui/team-alerts.ts; the shared types and wording helpers live in team-alert-shared.ts. */

import { moreDetail, openBacklogAction, type TeamAlert, type StaleBug, type NotifyFailure, type StaleWaitingBug, type StalePrompt, type StaleMerge, type PrimaryOverwriteBlock } from "./team-alert-shared.js";
import { plural } from "../text/phrases.js";
import { roleLabel } from "../roles/role-labels.js";
import { duration } from "./run-progress-model.js";
import { humanAgo } from "../text/datetime.js";
import { joinWithMore, squash } from "../text/text.js";

interface BacklogFeedAlertsInput {
  staleBugs: readonly StaleBug[];
  notifyFailure: NotifyFailure | null;
  staleWaitingBugs: readonly StaleWaitingBug[];
  stalePrompts: readonly StalePrompt[];
  staleMerges: readonly StaleMerge[];
  skippedMergeFiles: readonly string[];
  primaryOverwrite: PrimaryOverwriteBlock | null;
  now: number;
}

/** The backlog-feed alerts, in emission order: stale open bugs, a failed notify page, waiting
 * bugs, stranded inbox prompts, a stalled merge queue, skipped merge-queue files, and merges
 * refused by an uncommitted primary checkout. Extracted from teamAlerts (part 3/5 of the
 * teamAlerts split) so the shared module stays small; the input names exactly the fields this
 * run reads. The caller pushes the returned alerts at the position this run used to occupy,
 * so the emitted key order is unchanged. */
export function buildBacklogFeedAlerts(input: BacklogFeedAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const {
    staleBugs,
    notifyFailure,
    staleWaitingBugs,
    stalePrompts,
    staleMerges,
    skippedMergeFiles,
    primaryOverwrite,
    now,
  } = input;
  // A stale bug (doctor's STALE_BUG_DAYS rule, src/doctor/doctor-backlog-bugs.ts) sits when no
  // role fixes it — the bugfix role is disabled or failing — so it asks (amber) the way the
  // refused alert does, naming the oldest, its age, and the doctor's retract advice. Its
  // callers pass it oldest-first (alert-feeds.ts staleOpenBugs sorts most-days-waited first),
  // so the first element is the most-stale bug and is named with its position and age; the rest
  // are folded through entryListDetail like the questions and refused alerts, so the wording and
  // counts cannot drift.
  if (staleBugs.length) {
    const first = staleBugs[0]!;
    const rest = staleBugs.slice(1);
    out.push({
      key: "stale-bugs",
      tone: "amber",
      title: `${plural(staleBugs.length, "open bug waited", "open bugs waited")} 3+ days for a fix`,
      detail:
        `#${first.position} "${first.title}" has waited ${first.days}d for a fix` +
        moreDetail(rest.map((r) => r.title)) +
        ` · check that the bugfix role is enabled and not failing, or retract it with \`tumwater bug --cancel ${first.position}\``,
      // The action lands the operator on the first stale bug.
      actions: openBacklogAction({ file: "bugs", index: first.index }),
    });
  }
  // A failed notify page (doctor's NOTIFY_CHECK_WINDOW_MS rule, src/doctor/doctor-notify.ts
  // checkNotify) leaves the team unsupervised — a dead webhook must not page the operator when
  // something else goes wrong — so a page that failed within the last day asks (amber) the way
  // the stale-bug alert does, naming the count, the age of the latest, its squashed message,
  // and the `tumwater notify --test` fix. Its callers feed it the latest failure's message via
  // alert-feeds.ts's notifyFailures (the same isNotifyFailure filter and window), so the
  // alert and the doctor cannot drift.
  if (notifyFailure) {
    out.push({
      key: "notify",
      tone: "amber",
      title: `${plural(notifyFailure.count, "failed notify page", "failed notify pages")} in the last day`,
      detail:
        `the notify hook could not reach you ${humanAgo(notifyFailure.latestTs, now)}: ${squash(notifyFailure.message, 160)} — check it with \`tumwater notify --test\``,
      actions: [],
    });
  }
  // A waiting bug (doctor's STALE_WAIT_DAYS rule, src/doctor/doctor-backlog-bugs.ts
  // checkWaitingBugs) whose flake has not come back parks indefinitely, so a hold that has
  // outlived a week asks (amber) the way the stale-bug alert does, naming the oldest hold, its
  // age, and the release-or-keep advice. Its callers pass it most-days-first (alert-feeds.ts
  // staleWaitingBugs sorts by days descending, ties in file order), so the first element is the
  // longest-held bug and is named with its position and days; the rest are folded through
  // entryListDetail like the questions and refused alerts, so the wording and counts cannot
  // drift.
  if (staleWaitingBugs.length) {
    const first = staleWaitingBugs[0]!;
    const rest = staleWaitingBugs.slice(1);
    out.push({
      key: "waiting-bugs", // vocabulary-ok: the waiting-bugs amber alert's key
      tone: "amber",
      title: `${plural(staleWaitingBugs.length, "waiting bug held", "waiting bugs held")} 7+ days`,
      detail:
        `#${first.position} "${first.title}" has waited ${first.days}d for its next failure` +
        moreDetail(rest.map((r) => `#${r.position} "${r.title}"`)) +
        ` · the hold has outlived a week and this surface omits the doctor's recurrence scan — \`tumwater doctor\` reports whether the flake came back; release it with \`tumwater bug --release ${first.position}\`, or keep the hold if the failure is still expected`,
      // The action lands the operator on the first stale waiting bug.
      actions: openBacklogAction({ file: "bugs", index: first.index }),
    });
  }
  // A stranded inbox prompt (doctor's STALE_PROMPT_MS rule, src/doctor/doctor-backlog.ts) sits
  // when a role is paused, disabled, or failing and never reaches the run that would dequeue the
  // prompt, so it asks (amber) the way the stale-bug alert does, naming the oldest prompt, its
  // wait, and the deliver-or-drop advice. Its callers feed it oldest-first (alert-feeds.ts
  // stalePrompts sorts by queuedAtMs ascending), so the first element is the most-stale prompt
  // and is named with its role, position and wait; the rest are folded through entryListDetail
  // like the questions and refused alerts, so the wording and counts cannot drift.
  if (stalePrompts.length) {
    const first = stalePrompts[0]!;
    const rest = stalePrompts.slice(1);
    out.push({
      key: "stale-prompts",
      tone: "amber",
      title: `${plural(stalePrompts.length, "queued prompt waited", "queued prompts waited")} 1+ day for its role`,
      detail:
        `inbox prompt for ${roleLabel(first.role)} #${first.position} has waited ${duration(first.waitedMs)} — the role is not dequeuing it (paused, disabled, or failing); resume or enable it, or drop the prompt with \`tumwater prompt --cancel ${first.position} --role ${first.role}\`` +
        moreDetail(rest.map((p) => `${roleLabel(p.role)} #${p.position}`)),
      // The action lands the operator on the Inbox tab (the dashboard's backlog arm reads `act:
      // "queued"` as the Inbox view), where the stranded prompt is cancellable.
      actions: [{ label: "Open inbox", act: "queued" }],
    });
  }
  // A stalled merge queue (the doctor's MERGE_QUEUE_STALE_MS rule,
  // src/doctor/doctor-backlog.ts, set by the stale-merges alert) sits when a queued change
  // never starts — neither verified nor flagged — so a drain that has stopped reads healthy
  // except for this row. Its callers feed it oldest-first (alert-feeds.ts staleMerges reads
  // queuedMerges in queue-file order), so the first element is the longest-waiting merge and is
  // named with its role, summary and wait; the rest are folded through joinWithMore like the
  // actions and no-image alerts, so the wording and counts cannot drift.
  if (staleMerges.length) {
    const first = staleMerges[0]!;
    const rest = staleMerges.slice(1);
    out.push({
      key: "stale-merges",
      tone: "amber",
      title: `${plural(staleMerges.length, "queued merge waited", "queued merges waited")} 6+ hours to start`,
      detail:
        `${roleLabel(first.role)} — "${first.summary}" — has waited ${duration(first.waitedMs)} to start` +
        moreDetail(rest.map((m) => roleLabel(m.role)), (labels) => joinWithMore(labels, 3)) +
        ` — the merge queue has stopped moving; run \`tumwater queue\` to see it, or drop the entry with \`tumwater queue --cancel <n>\``,
      // The header's `merge queue: N` badge and the Pending view already carry the drill-in.
      actions: [],
    });
  }
  // A merge-queue file `readMergeQueue` skips (torn, foreign, or vanished mid-listing) is the
  // always-on twin of the doctor's `merge-queue files` row (doctor-backlog.ts
  // skippedMergeQueueFiles, feeding this from alert-feeds.ts's skippedMergeFiles): it sits
  // in .tumwater/merge-queue/ forever because the drain drops only an unreadable head, so a
  // skipped file after a healthy entry strands its merge until someone removes it. The stale-
  // merges alert above reads only readable entries, so it can never cover one. The doctor's row
  // and this alert share the one relative-path list, so they name the same files; the count and
  // the first skipped file are shown, the rest folded through joinWithMore.
  if (skippedMergeFiles.length) {
    const [first, ...rest] = skippedMergeFiles;
    out.push({
      key: "skipped-merges",
      tone: "amber",
      title: `${plural(skippedMergeFiles.length, "merge-queue file is", "merge-queue files are")} unreadable`,
      detail:
        `the queue reader skips ${first} — a torn or foreign file never clears itself, so its merge is stranded; remove it (a crashed enqueue's merge ref still recovers on the next run)` +
        moreDetail(rest, (labels) => joinWithMore(labels, 3)),
      actions: [],
    });
  }
  // A merge the primary checkout blocked (merge-git.ts primaryCheckoutBlockers, the
  // overwriteBlockedReason `warning` the merge path writes) — the always-on twin of the doctor's
  // `uncommitted backlog` row, but read off events so it reaches the status poll (the doctor's
  // git read is async and never gets there). A team stuck retrying one dirty file is a single
  // amber banner until the file is committed and the refusals age out; alert-feeds.ts's
  // primaryOverwriteBlocks feeds it the last day's refusals, counting them and naming the
  // latest's age, squashed message, and the commit fix.
  if (primaryOverwrite) {
    out.push({
      key: "primary-overwrite",
      tone: "amber",
      title: `${plural(primaryOverwrite.count, "merge was", "merges were")} refused by files uncommitted in your primary checkout`,
      detail:
        `most recently ${humanAgo(primaryOverwrite.latestTs, now)}: ${squash(primaryOverwrite.message, 160)} — roles cannot commit your checkout; commit the file(s) on main with \`tumwater doctor --commit-backlog\` (or by hand) so merges can proceed`,
      actions: [],
    });
  }
  return out;
}

