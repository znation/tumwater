/** The usage report's shapes: `ReportDay`, `ReportTotals`, `ReportData` (the per-day window) and
 * `SinceReport` (the trailing-window totals). Produced by the collectors in
 * src/report/report-data.ts and read by the Markdown render in src/report/report-render.ts and
 * by the dashboard/TUI report views; kept apart so the render and its consumers depend on the
 * shapes without importing the collection code. */
/** One day of a usage report: the local calendar day key plus what the team did on it.
 * `runsByRole` counts run_end events per role id (role ids — works for custom roles too);
 * tokensOut sums their `tokens`; commits counts `merged` events; costUsd sums `costUsd`.
 * `costByRole` splits that same costUsd per role id — sourced from the same run_end events
 * (never a second pass), so its per-day sum equals the day's costUsd by construction.
 * `notionalCostUsd`/`notionalByRole` carry subscription spend the same way, kept apart
 * because it never charges the cap (plans/agent-backends.md part 6a).
 * Merge usage (`merge_done`/`merge_failed`) is sparse: the merge fields are absent until the
 * day folds a merge event, and a day's tokensOut/costUsd already include the merge's
 * real-money share by the time they are read (the collector folds it in right after the event
 * pass), so the series keeps summing to the totals the budget also reports; a subscription
 * merge's notional share joins notionalCostUsd instead. */
export interface ReportDay {
  date: string; // "YYYY-MM-DD" local day key
  tokensOut: number;
  runsByRole: Record<string, number>;
  /** Output tokens per role id, so the day report can break the day's token spend down by
   * role the way Runs/Cost do; absent only on hand-built fixtures (the collector always
   * sets it — zero uses leave it an empty map). */
  tokensByRole?: Record<string, number>;
  /** Prompt tokens per role id — the input side of the bill the output-only `tokensByRole`
   * hides, so the same report that says who burned output tokens also says whose prompts a
   * backend served; absent when no run that day reported one (zero means absent). */
  promptTokensByRole?: Record<string, number>;
  /** The per-role share of `promptTokensByRole` served from cache (`run_end.cacheReadTokens`
   * subset run-finalize rides); absent when no run reported one (zero means absent, so a
   * prompt-free window keeps today's JSON shape). */
  cacheReadTokensByRole?: Record<string, number>;
  costByRole: Record<string, number>;
  /** review_rejected events per role id; absent when the day has none (zero means absent). */
  rejectionsByRole?: Record<string, number>;
  /** The `review_rejected` events whose `afterMerge` is true, per role id — the subset of
   * this day's `rejectionsByRole` whose rejection reached an already-merged commit; absent
   * when the day has none (zero means absent). */
  postMergeRejectionsByRole?: Record<string, number>;
  /** revision events per role id; absent when the day has none (zero means absent). */
  revisionsByRole?: Record<string, number>;
  /** run_end events per role id (its result is `refused` — a run that deliberately declined
   * its entry); absent when the day has none (zero means absent). */
  refusalsByRole?: Record<string, number>;
  /** Lower median of the day's passing full-suite check durations (ms); absent when the day
   * has none. */
  checkMedianMs?: number;
  /** Failed full-suite build_check events that day (isRedFullCheck); absent when the day has
   * none (zero means absent). */
  checkFailures?: number;
  /** Main's red wall-clock that day — how long main had no passing full check (G1's
   * `main_check`/`main_red_hold` rule), in ms. Main's own red time, not any role's, so
   * team-only like the other per-day medians; absent when the day has none. */
  mainRedMs?: number;
  /** Lower median of the day's merge waits (enqueue to merged on main, ms); absent when the
   * day has no merge that carried queuedMs. */
  mergeWaitMedianMs?: number;
  /** Lower median of the day's merge_done.durationMs (verification start to outcome, ms) — how
   * long the merge slot itself held each change it landed; team-only like the other per-day
   * medians, absent when the day has none. */
  mergeSlotMedianMs?: number;
  /** Lower median of the day's run durations (`run_end.durationMs`, ms); team-only like the
   * other per-day medians, absent when the day has none. */
  runMedianMs?: number;
  /** Lower median of the day's provider-slot waits (a role run's semaphore admission wait,
   * ms); absent when the day has no provider_wait that carried a positive waitedMs. */
  providerWaitMedianMs?: number;
  /** Lower median of the day's workspace-slot waits (a pooled workspace lease wait, ms);
   * absent when the day has no slot_wait that carried a positive waitedMs. */
  slotWaitMedianMs?: number;
  /** Lower median of the day's check-slot waits (a scoped check's wait for a maxConcurrentChecks
   * permit, ms); absent when the day has no check_wait that carried a positive waitedMs. */
  checkWaitMedianMs?: number;
  /** Lower median of the day's reviewer-run durations (`review_verdict` approvals and
   * `review_rejected` rejections that carried a positive `durationMs` — how long the review
   * gate took, ms); team-only like the other per-day medians, absent when the day has none. */
  reviewMedianMs?: number;
  /** error-class run_end events per role id; absent when the day has none (zero means
   * absent, so a failure-free day keeps its exact pre-feature shape). */
  failedRunsByRole?: Record<string, number>;
  /** image_reroute events per role id; absent when the day has none (zero means absent). */
  imageReroutesByRole?: Record<string, number>;
  commits: number;
  commitsByRole?: Record<string, number>; // merged commits by base role (Work ratio 4/4)
  workCommits?: number; // of those, feature/bugfix/director
  maintenanceCommits?: number; // of those, code-maintenance + readme
  costUsd: number;
  featuresDone: number;
  bugsFixed: number;
  plansAdded?: number; // PLANS.md `## Planned`+`## Done` filing stamps this day (absent when none)
  bugsFiled?: number; // BUGS.md `## Open`+`## Fixed` filing stamps this day (absent when none)
  mergeRuns?: number; // merge_done/merge_failed events this day folded (absent when none)
  mergeTokens?: number; // their output tokens, also included in tokensOut above
  mergeCostUsd?: number; // their cost, also included in costUsd above
  mergeFailed?: number; // of those runs, the merge_failed events (absent when none)
  /** merged outcomes by base role; absent when the day has none (zero means absent). */
  mergedByRole?: Record<string, number>;
  /** merge_failed outcomes by base role; absent when the day has none (zero means absent). */
  mergeFailedByRole?: Record<string, number>;
  /** merge_failed outcomes by their event's `result` code; absent when the day has none
   * (zero means absent). A result code is not a role, so only the team series carries it. */
  mergeFailedByReason?: Record<string, number>;
  notionalCostUsd?: number; // subscription spend, on its own notional line, never in costUsd
  /** Subscription spend by role id, never in costByRole; absent when the day has none. */
  notionalByRole?: Record<string, number>;
  /** Per-provider real spend, parallel to costByRole but keyed by provider; absent when the
   * day had no provider spend (zero means absent, so a provider-free day keeps its exact
   * pre-feature shape). */
  costByProvider?: Record<string, number>;
  /** Per-provider notional spend, parallel to notionalByRole; absent when the day had none. */
  notionalByProvider?: Record<string, number>;
  /** Per-backend notional spend, keyed by the backend whose runs spent it; absent when the day
   * had none (zero means absent). A backend is not a role, so only the team series carries it. */
  notionalByBackend?: Record<string, number>;
  /** run_start events per model selector, parallel to costByProvider's team-only rule: a
   * model is not a role, so only the team series carries it (absent when the day had no
   * modelled start, zero means absent). */
  runsByModel?: Record<string, number>;
  /** run_deferred events per reason code (a maintenance run that stood down, bucketed by
   * why — "backlog", "no-work" or "plans-full"); team-only like runsByModel, because a
   * reason is not a role. Absent when the day had no deferral (zero means absent). */
  deferredByReason?: Record<string, number>;
  /** fixed bugs' `Validation gap` tags recorded this day, from BUGS.md's ## Fixed entries;
   * team-only like its window tally, because a tag has no role (absent when the day has
   * none, zero means absent). */
  validationGapsByTag?: Record<string, number>;
  /** Lower median of the whole-day filing-to-done spans of the entries completed that day (a
   * finished plan or bug's span from its filing stamp to its done/fixed stamp, in whole
   * calendar days); team-only like the other day-granular backlog tallies, absent when the
   * day has no entry that carries both stamps. */
  backlogLagMedianDays?: number;
  /** The failing tests main's own red `main_check` / `main_red_hold` events named that day
   * (G1's rule, isRedMain), per test; team-only like mainRedMs (main's failing tests are
   * main's own, not any role's), absent when the day's red events named no test (zero means
   * absent). */
  mainRedByTest?: Record<string, number>;
  /** The landed merges main's own `main_culprit` events blamed that day (the live `mainred`
   * alert's event, src/status/status-polls.ts's `MainCheckStatus.red.culprit`), per
   * `<role> <shortSha>` label; team-only like mainRedByTest (main's own blame, not any
   * role's), absent when the day's red events blamed no merge (zero means absent). */
  mainRedByCulprit?: Record<string, number>;
}

/** The window totals both reports surface — output tokens (the merge share included), the
 * run and commit counts, cost (the merge share included), and the merge share named for
 * itself. SinceReport carries it directly; ReportData adds the day-granular backlog tallies
 * on top. The single home of this shape, so report-render.ts's totalsLine/mergeShareLine
 * read exactly the fields the collectors produce. */
export interface ReportTotals {
  tokensOut: number; // includes merge spend — the same events the daily budget charges
  runs: number;
  commits: number;
  costUsd: number; // includes merge spend, so the report and the budget agree
  /** Subscription spend, API-equivalent: never in costUsd, shown on its own line
   * (plans/agent-backends.md part 6a). Optional so pre-feature test literals still typecheck. */
  notionalCostUsd?: number;
  /** Per-backend subscription spend, keyed by the backend whose runs spent it; absent when
   * empty (a claude-only or old-log window keeps today's single generic line). */
  notionalByBackend?: Record<string, number>;
  mergeRuns: number; // the merge share of the above, named for itself
  mergeTokens: number;
  mergeCostUsd: number;
  mergeFailed?: number; // of those runs, the merge_failed events (absent when none)
  plansAdded?: number; // window filing-stamp count (absent when zero)
  bugsFiled?: number; // window filing-stamp count (absent when zero)
}

/** Team usage over a window of exactly `days` local calendar days ending today. */
export interface ReportData {
  days: number;
  from: string; // day key of the oldest day in the series
  to: string; // day key of today
  role?: string; // the scoped base roles, comma-joined; set by the role-scoped collector; absent on the team report
  series: ReportDay[]; // oldest → newest, zero-filled
  totals: ReportTotals & {
    featuresDone: number;
    bugsFixed: number;
    commitsByRole?: Record<string, number>;
    workCommits?: number;
    maintenanceCommits?: number;
    /** Fixed bugs' `Validation gap` tags over the window, by tag; team-only day-granular
     * backlog metadata, absent when zero like its siblings (a tag has no role, so a
     * role-scoped report never carries it). */
    validationGapsByTag?: Record<string, number>;
  };
  /** True when the report provably reflects every event the window could have contained:
   * the day-keyed read proved the log reaches back before the window's first day, or the
   * retained log holds no events at all — nothing ever existed that could have rotated away.
   * False means events were aggregated from a log whose oldest event lies inside the window
   * with no proof that older data was not rotated away (two or more 16 MB rotations inside a
   * long window outrun the one kept archive generation) — the renders say so, exactly as the
   * --since report and the failure digest already do. */
  coversFullWindow: boolean;
}

/** Team usage over a trailing window of `sinceMs` ending now: the same run_end/merged
 * aggregation as `collectReport` but keyed to a cutoff instant rather than whole local days.
 * Backlog tallies (features done / bugs fixed / plans added / bugs filed) are deliberately
 * absent: they are counted from PLANS.md/BUGS.md `planned`/`reported`/`found by` filing and
 * `done`/`fixed` completion dates, which are day-granular file metadata that cannot subdivide
 * a sub-day window — the render says so instead of showing a day-rounded number. */
export interface SinceReport {
  sinceMs: number; // the requested window length
  fromIso: string; // ISO string of the cutoff instant (window start)
  untilMs?: number; // the --until bound; absent when the window ends now
  toIso?: string; // ISO string of the window end; set only with untilMs
  role?: string; // the scoped base roles, comma-joined; set by the role-scoped collector; absent on the team report
  totals: ReportTotals;
  runsByRole: Record<string, number>;
  costByRole: Record<string, number>; // zero-cost roles leave no key, as in collectReport
  /** review_rejected events per role id; empty when the window has none. */
  rejectionsByRole: Record<string, number>;
  /** The `review_rejected` events whose `afterMerge` is true, per role id — the subset of
   * this window's `rejectionsByRole` whose rejection reached an already-merged commit;
   * always present (empty map when none), like the other per-day role maps. */
  postMergeRejectionsByRole: Record<string, number>;
  /** revision events per role id; empty when the window has none. */
  revisionsByRole: Record<string, number>;
  /** run_end events per role id whose result is `refused` (a run that deliberately declined
   * its entry); empty when the window has none. */
  refusalsByRole: Record<string, number>;
  /** error-class run_end events per role id; empty when the window has none. */
  failedRunsByRole: Record<string, number>;
  /** image_reroute events per role id; empty when the window has none. */
  imageReroutesByRole: Record<string, number>;
  /** Output tokens per role id, so the --since render can break the window's token spend
   * down by role the way the day report does. */
  tokensByRole: Record<string, number>;
  /** Prompt tokens per role id, the input side `tokensByRole` hides; absent when the window
   * has none (a prompt-free/old-log window keeps today's JSON shape). */
  promptTokensByRole?: Record<string, number>;
  /** The per-role share of `promptTokensByRole` served from cache; absent when the window
   * reported none. */
  cacheReadTokensByRole?: Record<string, number>;
  /** Merged commits per base role, so the --since render can print the day report's
   * `Commits by role` line; always present (the collector's accumulator is pre-filled by
   * zeroCommitCounts, so a commit-free window carries an empty map — the `-` render). */
  commitsByRole: Record<string, number>;
  /** merged outcomes by base role; always present (the collector pre-fills the empty map, so
   * a merge-free window renders `-` like the other lines). */
  mergedByRole: Record<string, number>;
  /** merge_failed outcomes by base role; always present (empty map when none), so the render
   * can gate its new failure line on the window's own merge_failed events. */
  mergeFailedByRole: Record<string, number>;
  /** merge_failed outcomes by their event's `result` code; always present (empty map when
   * none), so the render can gate its reason line on the window's own merge_failed events.
   * A result code is not a role, so a role-scoped window carries an empty map. */
  mergeFailedByReason: Record<string, number>;
  /** Main's red wall-clock over the window (G1's `main_check`/`main_red_hold` rule), in ms.
   * Main's own red time, not any role's, so a role-scoped window carries 0; always present
   * (0 when none). */
  mainRedMs: number;
  /** Main's red failing tests over the window (`main_check` / `main_red_hold` events G1
   * accepts as red, isRedMain), per test. Main's own failing tests, not any role's, so a
   * role-scoped window omits it; absent when the window's red events named no test (via
   * nonemptyObj), so a red-test-free --since JSON is byte-identical to today. */
  mainRedByTest?: Record<string, number>;
  /** The landed merges main's own `main_culprit` events blamed over the window (the live
   * `mainred` alert's event), per `<role> <shortSha>` label — the historical twin of the
   * alert's `red.culprit`. Main's own blame, not any role's, so a role-scoped window omits
   * it; absent when the window's red events blamed no merge (via nonemptyObj), so a
   * culprit-free --since JSON is byte-identical to today. */
  mainRedByCulprit?: Record<string, number>;
  /** Subscription spend per role id, never in costByRole; absent when the window has none —
   * the same conditional the day collector applies to ReportDay.notionalByRole, so a
   * --since JSON carries it only when nonzero. */
  notionalByRole?: Record<string, number>;
  /** Per-provider real spend from the window's providerCost maps; always present (empty map
   * when none, like failedRunsByRole and the other always-present maps), so the --since
   * render can gate its `Cost by provider` line on the window's own events. */
  costByProvider: Record<string, number>;
  /** Per-provider notional spend; always present (empty map when none). */
  notionalByProvider: Record<string, number>;
  /** Per-backend notional spend; absent when the window had none (a backend is not a role, so
   * a scoped window never carries it — the same absent-when-empty rule the day collector
   * applies). */
  notionalByBackend?: Record<string, number>;
  /** run_start events per model selector; always present (empty map when none, like
   * costByProvider), so the --since render can gate its `Runs by model` line on the
   * window's own events. A model is not a role, so a scoped report carries an empty map. */
  runsByModel: Record<string, number>;
  /** run_deferred events per reason code (a maintenance run that stood down, bucketed by
   * why — "backlog", "no-work" or "plans-full"); absent when the window has none — the
   * same conditional the day collector applies to ReportDay.deferredByReason, so a --since
   * JSON carries it only when nonzero. A reason is not a role, so a scoped window omits it. */
  deferredByReason?: Record<string, number>;
  /** True when the report provably reflects every event the window could have contained:
   * the day-keyed read proved the log reaches back before the cutoff's day, the log's oldest
   * retained event predates the cutoff instant (the same-day case a day key cannot decide),
   * or the retained log holds no events at all — nothing ever existed that could have rotated
   * away, so an empty or missing log must not read as a truncated history. False means events
   * were aggregated from a log whose oldest event lies inside the window with no proof that
   * older data was not rotated away — the render adds a note so a sparse window is never
   * mistaken for an idle team. */
  coversFullWindow: boolean;
}
