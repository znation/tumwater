// vocabulary: plain
import { answeredQuestionSummaries } from "../backlog/question-answer.js";
import { completionDate, donePlanEntries, DONE_DATE_RE, FIXED_DATE_RE, fixedBugEntries, openBugs, openQuestions, plannedPlans, type BacklogEntry } from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress, backlogMarks, refusedEntryTitles } from "../backlog/backlog-eligibility.js";
import { finishedTitle, groupBlockedSeries, partsLabel } from "../backlog/backlog-structure.js";
import { readEvents } from "../events/event-read.js";
import { eventFeedItem, formatEvent } from "../events/event-format.js";
import { projectName } from "../project-name.js";
import { dailyCost } from "../budget/budget.js";
import { queueEntryMergeLabel } from "../merge/merge-queue-render.js";
import { snapshot } from "../status/status-data.js";
import { bootstrapBadge, buildBadge, budgetBadge, diskBadge, mergeBadge, mainCheckBadge, mainCountsFragment, permitsBadge, quietBadge, runWindowBadge } from "./badges.js";
import { isActivePhase, roleRowCells, onErrorStreak } from "./status-model.js";
import { yieldMultiplierFor } from "../scheduling/backoff.js";
import { teamAlerts } from "./team-alerts.js";

/** How many recent events the payload carries — enough for the dashboard's activity feed to
 * still show a screenful of notable events (merges, failures, questions) after it filters
 * out the routine ones (tick starts, wakes, passing checks). */
const RECENT_EVENTS = 80;
/** How many answered questions the dashboard lists under the open ones (a default, not a knob). */
export const DASHBOARD_ANSWERED_QUESTIONS = 5;

/** How many done plans / fixed bugs the dashboard lists under the open ones (a default). */
export const DASHBOARD_RECENT_FINISHED = 5;

/** The newest finished entries (sections are newest first), titles cleaned of their stamp. */
export function recentFinished(entries: BacklogEntry[], dateRe: RegExp): { title: string; completedOn: string | null }[] {
  return entries.slice(0, DASHBOARD_RECENT_FINISHED).map((e) => ({ title: finishedTitle(e.title, dateRe), completedOn: completionDate(e.title, dateRe) }));
}

/** The one team-state document both observer surfaces carry: `GET /api/status` (gui/gui-server.ts)
 * spreads it and adds the serving process's own `serverBuildSha` (the page's cue to notice a
 * newer build and reload), while `tumwater status --json` (cli.ts) prints it verbatim — every
 * other field is shared, so the dashboard and the CLI can never drift apart. Assembled here —
 * not in gui/gui-server.ts — because it is shared data collection for observers, not part of
 * serving HTTP: snapshot() supplies the core state, and the per-role phase/metrics fields come
 * from the same status-model helpers the TUI table uses.
 *
 * `now` pins the poll's clock for the time-derived fields (see snapshot's seam of the same
 * name) — spend stamp-check, burn-rate projection, disk badge, and the pause countdown — so a
 * test's expected value cannot race the payload's own Date.now(). */
export function statusPayload(root: string, now = Date.now()): object {
  const snap = snapshot(root, undefined, now);
  // One event read feeds both feed shapes below, so `events[i]` and `eventItems[i]` always
  // describe the same event.
  const recent = readEvents(root, RECENT_EVENTS);
  const questions = openQuestions(root);
  // Why each plan/bug is held (src/backlog/backlog-eligibility.ts): the same hold decision
  // the prompt's backlog index and `tumwater backlog` render, projected to the mark each
  // surface appends. Read once here, consumed as the parallel planHolds/bugHolds arrays below.
  const marks = backlogMarks(root);
  const holds = backlogHolds(root);
  const plans = plannedPlans(root);
  // Which blocked plans fold into a series row: the grouping `plan --list` and the prompt's
  // backlog index use, as a slot per plan (null for a plan that stays an ordinary row).
  const working = backlogInProgress(root);
  const planSeries: ({ name: string; label: string } | null)[] = plans.map(() => null);
  for (const g of groupBlockedSeries(holds.plans.map((hold, i) => ({ i, title: plans[i]!, hold, claimer: working.plans[i] ?? undefined })))) {
    if (g.kind !== "series") continue;
    const slot = { name: g.series, label: `${g.series}, ${g.rows.length} blocked parts (${partsLabel(g.rows)})` };
    for (const r of g.rows) planSeries[r.i] = slot;
  }
  const roles = snap.loops.map((s) => {
    // roleRowCells single-homes the per-role tail read + metrics + phase derivation the
    // TUI table (status-render.ts's renderStatus) repeats, so the two dashboards cannot
    // drift apart.
    const { live, generated, peakCtx, phase } = roleRowCells(snap, root, s);
    return {
      role: s.role,
      // The role's own failure-streak tell (onErrorStreak, status-model.ts): the red
      // "failing tick after tick" alert keys on this rather than the rendered phase, so it
      // stays up while the role's next tick runs (phase reads "working") and clears only
      // when the streak resets (BUGS.md 2026-10-14).
      errorStreak: onErrorStreak(s),
      // User-defined-role marker (computed in snapshot — see StatusSnapshot.loops): the GUI
      // renders it as an asterisk beside the role name.
      custom: s.custom,
      // The role's resolved selector, present whenever a model resolves (a single string
      // `model` or a tier map); the seam tier tag (part 7a, model-tiers.md
      // "Observability") rides only under a tier map. The GUI renders a tier tag beside
      // the role name and the selector in the sub line.
      ...(s.modelTier ? { modelTier: s.modelTier } : {}),
      ...(s.model ? { model: s.model } : {}),
      // pi's own saved default (see StatusSnapshot.loops.modelFromPi): ships beside `model` so
      // the dashboard can mark a row whose model tumwater.json did not name. Same conditional
      // spread as `model`, present on exactly the rows that carry the flag.
      ...(s.modelFromPi ? { modelFromPi: true } : {}),
      // Model failure fallback (PLANS.md "Model failure fallback, part 2/2"): present only
      // while the role's ticks run off-model, so the common row shape is unchanged.
      ...(s.fallback ? { fallback: s.fallback } : {}),
      ...(s.slot ? { slot: s.slot, slotPinned: s.slotPinned === true } : {}),
      // Parallel work instances (plans/parallel-work-instances.md "Observability", part
      // 6/7): the backlog entry this instance claimed, shown by the dashboards while it is
      // idle or merge, and the base role it belongs to (`feature-2` → `feature`). `claim`
      // is the claimed heading text, not the persisted record; both are absent on a bare,
      // unclaimed row so the common payload shape is unchanged.
      ...(s.claim ? { claim: s.claim.title } : {}),
      ...(s.instanceOf ? { instanceOf: s.instanceOf } : {}),
      // The role's image-input surface (plans/image-input.md "Surfaces", part 5/5), always
      // present: whether its own model reads images and where a blind prompt reroutes — the
      // GUI's images alert and composer notice read them (the JSON field is `imageReroute`, the
      // display label, not the persisted handoff state).
      ...(s.imageInput !== undefined ? { imageInput: s.imageInput } : {}),
      ...(s.imageRerouteLabel !== undefined ? { imageReroute: s.imageRerouteLabel } : {}),
      phase,
      // In-flight flag derived from the same rendered phase (isActivePhase's
      // permit-holder prefixes: working/reviewing/merge). The running director is excluded
      // (it holds no maxConcurrent permit), so this is the cap count, not the abort set — the
      // GUI's row actions derive their own live flag from the phase instead (BUGS.md
      // 2026-10-06).
      inFlight: isActivePhase(phase),
      // The stuck alert's silence span (ms since the last pi log write, capped to the tick by
      // progressOfTick) — the dashboards render it as "for <duration>" on a tool-call stall.
      // Present only while the role holds a live tail, so the common payload shape is unchanged.
      ...(live?.quietMs !== undefined ? { stuckMs: live.quietMs } : {}),
      // What a working role is doing right now (first assistant text of the in-flight run).
      // Null when idle — never show a stale item from a finished tick.
      currentWork: live?.currentWork ?? null,
      runs: s.runs,
      commits: s.commits,
      generated,
      peakCtx,
      costUsd: s.totalCostUsd,
      // The role's spend for the local day (the daily budget window): 0 while its stamp
      // is stale or missing — same helper and semantics as the TUI's `today` column.
      todayUsd: dailyCost(s),
      lastResult: s.lastResult ?? null,
      lastSummary: s.lastSummary ?? null,
      // The last failure's text (a tick error, a failed merge's reason); the dashboard shows it
      // beside a problem result that carries no summary of its own.
      lastError: s.lastError ?? null,
      lastRunEndedAt: s.lastRunEndedAt ?? null,
      // When the role last actually merged a change on main (epoch ms; null until it ever
      // does) — the direct answer to "how long has the dry spell been", the productivity
      // complement to lastError/lastRunEndedAt.
      lastMergedAt: s.lastMergedAt ?? null,
      // The scheduling facts behind the `next run` column: raw epoch ms and seconds, formatted
      // client-side like lastRunEndedAt/costUsd — the GUI's fmtNextRun twin applies the same
      // rules nextRunCell does (see status-render.ts).
      nextRunAt: s.nextRunAt,
      backoffSeconds: s.backoffSeconds,
      // The yield multiplier behind the next-run cell's `×N` suffix (yield-scaled
      // clocks, PLANS.md): the payload carries the computed number, not the ring, so the
      // GUI's JS twin applies the same display rule without re-deriving the role sets.
      yieldMultiplier: yieldMultiplierFor(s),
      // The consecutive no-change streak (tick-apply.ts applyTickOutcome's noChangeStreak, an
      // observational counter): how many completed ticks in a row returned nothing to do. The
      // TUI reads it off the rendered label; the GUI's phaseDetailBase re-derives the ` · no
      // change ×N` suffix from this number (its row and drawer share noChangeStreak) so its
      // JS twin applies the same display rule without re-parsing the phase text.
      noChangeStreak: s.noChangeStreak ?? 0,
    };
  });
  return {
    // The project's display name (project-name.ts) — the dashboards' title.
    project: projectName(root),
    running: snap.running,
    pid: snap.pid,
    // The running harness's build stamp and staleness (src/build/build-info.ts); null when no
    // harness runs or its dist carries no stamp — machine-readable for `status --json`.
    build: snap.build,
    // The header's build badge pre-formatted through badges.ts's buildBadge — the same
    // string the TUI/status table renders. Sent display-ready (like phase and events) because
    // the page is browser JS that cannot import TypeScript, and this multi-branch text must
    // not be re-derived client-side where it could drift from the TUI header.
    buildBadge: buildBadge(snap.build),
    // The header's daily-cost-budget badge preformatted through badges.ts's budgetBadge —
    // the same string the TUI/status table renders (n/a for an all-free team; `· no cap`
    // when disabled). Sent display-ready like buildBadge so the page cannot re-derive it.
    budgetBadge: budgetBadge(snap.budget, snap.claudeWindow, now, snap.chain),
    // The disk floor (plans/disk-floor.md, part 4/4): the raw block is machine-readable for
    // `status --json`, and the header badge is preformatted through badges.ts's diskBadge —
    // the same string the TUI/status header renders. Omitted (not null) when no orchestrator
    // has published one — the same omit-undefined idiom as pausedUntil.
    ...(snap.disk ? { disk: snap.disk } : {}),
    diskBadge: diskBadge(snap.disk),
    // The permit pool (plans/provider-concurrency.md §8): raw block machine-readable for
    // `status --json`, plus the display-ready header badge — the same `slots 5/8 · omlx 3/3`
    // string the TUI/status header renders. Omitted when no orchestrator has published one.
    ...(snap.permits ? { permits: snap.permits } : {}),
    permitsBadge: permitsBadge(snap.permits),
    // The `run --for` deadline: raw epoch ms (only when windowed) plus the display-ready badge.
    ...(snap.runStopsAt !== undefined ? { runStopsAt: snap.runStopsAt } : {}),
    ...(snap.scheduledStopAt !== undefined ? { scheduledStopAt: snap.scheduledStopAt } : {}),
    runWindowBadge: runWindowBadge(snap.runStopsAt, now),
    // The merge queue (plans/merge-queue.md 4/5): depth always (machine-readable for
    // `status --json`; 0 when idle) plus the in-flight merge's identity only while one is
    // actually running. Raw data here, like budget — and the display-ready header badge
    // preformatted through badges.ts's mergeBadge, so the page cannot re-derive it.
    mergeQueue: snap.mergeQueue,
    mergeBadge: mergeBadge(snap.mergeQueue),
    // One bracketed merge label per merge queue entry (queueEntryMergeLabel, "" for none),
    // parallel to mergeQueue.entries — display-ready like mergeBadge, since browser JS cannot
    // import the TypeScript stage labels.
    mergeQueueLabels: (snap.mergeQueue.entries ?? []).map((e) => queueEntryMergeLabel(e.sha, snap.mergeQueue.inFlight, now)),
    // Main's newest merge-scope check: the
    // raw block is machine-readable for `status --json`, and the header badge is
    // preformatted through badges.ts's mainCheckBadge — the same string the TUI/status
    // header renders — so the page cannot re-derive the verdict client-side. Omitted (not
    // null) before any merge-scope check has run — the same omit-undefined idiom as
    // pausedUntil.
    ...(snap.mainCheck ? { mainCheck: snap.mainCheck } : {}),
    mainCheckBadge: mainCheckBadge(snap.mainCheck),
    // The check's counts fragment, preformatted through badges.ts's mainCountsFragment so
    // the page renders the pass/skip/fail breakdown verbatim and cannot re-derive (and
    // drift from) it — the sidebar's "Main green · …" row reads this field, not the raw
    // counts. Empty when no check has run or the check carries no counts.
    mainCounts: mainCountsFragment(snap.mainCheck?.counts),
    inbox: snap.inbox,
    // Previews of the queued director prompts in execution order (truncated server-side —
    // see StatusSnapshot.inboxPrompts); the page lists them in its project status panel.
    inboxPrompts: snap.inboxPrompts,
    // Queue-file addresses beside the previews (same order — see StatusSnapshot.inboxFiles):
    // the queued-prompts section's per-row cancel affordance POSTs one to /api/prompt-cancel.
    // Raw data, like inbox/inboxPrompts.
    inboxFiles: snap.inboxFiles,
    // Enqueue stamps beside the previews (same order — see StatusSnapshot.inboxQueuedAt):
    // the Queued tab shows each prompt's age from it. Raw data, like inboxFiles.
    inboxQueuedAt: snap.inboxQueuedAt,
    // Not-before stamps beside the previews (same order — see StatusSnapshot.inboxNotBefore):
    // the Queued tab shows each deferred prompt's delivery countdown from it. Raw data, like
    // inboxQueuedAt.
    inboxNotBefore: snap.inboxNotBefore,
    // Per-role queued-prompt counts: the role table's
    // `p:N` state marker and the queued-prompts section's per-role lines render from it.
    // Raw data, like inbox/inboxPrompts.
    roleInbox: snap.roleInbox,
    // Per-role queued prompts with their queue-file addresses (see
    // StatusSnapshot.roleInboxPrompts): the queued-prompts section renders each as its own
    // row with a cancel link, replacing the bare "r: N queued" count line. Raw data, like
    // inboxFiles.
    roleInboxPrompts: snap.roleInboxPrompts,
    // The raw daily-cost-budget data, unconditionally (capUsd 0 = disabled; spend still
    // reported) — machine-readable for `status --json`; the display-ready header badge is
    // the preformatted `budgetBadge`.
    budget: snap.budget,
    // The subscription usage-window block (part 6d/7), absent on a pi-only or API-claude
    // team — the same raw shape `status --json` carries, which the GUI's spend card reads
    // to render the window (the preformatted budgetBadge above already folds it into the
    // header for the TUI/status). Raw data, like budget.
    ...(snap.claudeWindow ? { claudeWindow: snap.claudeWindow } : {}),
    // Each tier's fallback step (fallback chain part 7c/7), raw for the GUI side card.
    ...(snap.chain ? { chain: snap.chain } : {}),
    // Operator pause (`tumwater pause` marker present): every idle role's phase reads
    // `paused` ahead of budget/main-red — one flag covers both dashboards through rolePhase.
    paused: snap.paused,
    pausedRoles: snap.pausedRoles,
    // The role ids the scheduler treats as paused by the marker; the dashboards read this.
    pausedLoops: snap.pausedLoops,
    // The per-role cap's held roles (part 2/2): an idle
    // role in this set reads `cap paused` — the rolePhase ladder names it, and `status
    // --json` carries the raw set beside pausedRoles so scripts read the same verdict.
    capPaused: snap.capPaused,
    // The maintenance allowance's held roles and figures (plans/work-ratio.md, part 1b/4):
    // machine-readable for `status --json` beside capPaused; the role cell's own
    // `held: maintenance quota <used>/<allowance>` label is built from `held` plus the figures
    // through rolePhase.
    maintenanceQuota: snap.maintenanceQuota,
    // The new-project bootstrap (plans/work-ratio.md, part 2/2): the raw progress and held set
    // are machine-readable for `status --json` beside capPaused, and the preformatted badge
    // drives the TUI/status header and the GUI sidebar — the badges.ts one-home rule.
    ...(snap.bootstrap ? { bootstrap: snap.bootstrap } : {}),
    bootstrapHeld: snap.bootstrapHeld,
    bootstrapBadge: bootstrapBadge(snap.bootstrap),
    // The per-role quiet windows' held roles (PLANS.md quietHoursPerRole): keyed role →
    // window, machine-readable for `status --json` beside capPaused; the dashboards render
    // the role's own `quiet until <end>` from it through rolePhase.
    roleQuietPaused: snap.roleQuietPaused,
    // The team marker's standing timed-pause deadline (ms epoch), absent when the team is
    // not timed-paused (undefined drops from the JSON). Raw data, like paused/pausedRoles —
    // machine-readable for `status --json`; the planned GUI pause-badge countdown reads it
    // client-side.
    pausedUntil: snap.pausedUntil,
    // The paused-roles marker's shared `until` while a timed per-role pause stands (omitted
    // otherwise).
    pausedRolesUntil: snap.pausedRolesUntil,
    // A pending scheduled wake ({ roles, atMs }); omitted when none stands.
    scheduledWake: snap.scheduledWake,
    // Every pending scheduled wake, earliest first (omitted when none stands).
    scheduledWakes: snap.scheduledWakes,
    // The standing pause's operator reason (`pause --reason <text>`), absent when none
    // stands — same omit-undefined idiom as pausedUntil beside which it ships.
    pauseReason: snap.pauseReason,
    // The configured quiet-hours window ("Quiet hours … part 2/2"): the raw string and
    // in-window flag are machine-readable for `status --json` and drive the GUI sidebar's
    // chip; absent (undefined drops from the JSON) when no window is configured or the
    // value is malformed, matching the snapshot's omit-when-not-held rule. The header badge
    // is preformatted through badges.ts's quietBadge — the same string the TUI/status
    // header renders — so the page cannot re-derive it.
    ...(snap.quietHours ? { quietHours: snap.quietHours } : {}),
    inQuietHours: snap.inQuietHours,
    quietBadge: quietBadge(snap.quietHours, snap.inQuietHours),
    roles,
    // The recent event feed as the one-line text `tumwater logs` prints…
    events: recent.map((e) => formatEvent(e)),
    // …and the same events as data for the dashboard's activity feed: when, which role, what
    // kind (the event type plus its result or check status, which decide the row's tone), and
    // the message without formatEvent's time/role columns — the page renders those itself.
    eventItems: recent.map(eventFeedItem),
    // Project status (planned features + open bugs + open questions), fresh per poll like
    // events — roles edit these files constantly, so there is no cache to go stale. The page
    // derives the header badge count from this list's length.
    plans,
    bugs: openBugs(root),
    // The holds and working-on-it marks beside those titles, index-for-index parallel
    // (backlogMarks and plannedPlans/openBugs walk the same sectionEntries file order): an
    // eligible entry nobody is working on is the empty string, so a client can append the
    // mark without a separate eligibility check.
    planHolds: marks.plans,
    bugHolds: marks.bugs,
    // Whether each entry carries any eligibility hold (parallel to plans/bugs): the dashboard
    // lists unblocked rows first and gathers the rest under a Blocked divider.
    planBlocked: holds.plans.map((h) => h !== null),
    bugBlocked: holds.bugs.map((h) => h !== null),
    // The series each blocked plan folds into (parallel to plans): the Plans tab shows one
    // expandable row per series instead of every waiting part; null for an ordinary row.
    planSeries,
    questions,
    // The newest answered questions, newest first, read fresh each poll like the other backlog
    // lists. Alerts and badges keep counting open questions only.
    answeredQuestions: answeredQuestionSummaries(root, DASHBOARD_ANSWERED_QUESTIONS),
    // The newest done plans and fixed bugs, newest first: cleaned titles only, no bodies, read
    // fresh each poll. Badges and alerts keep counting open entries only.
    donePlans: recentFinished(donePlanEntries(root), DONE_DATE_RE),
    fixedBugs: recentFinished(fixedBugEntries(root), FIXED_DATE_RE),
    // What needs the operator (team-alerts.ts's teamAlerts): the dashboard's alert banners and
    // the TUI's attention lines, phrased once.
    alerts: teamAlerts(snap, questions, roles, now, refusedEntryTitles(root)),
  };
}
