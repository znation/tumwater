/** The status snapshot's shapes: `StatusSnapshot` — everything `tumwater status`,
 * `status --json`, the dashboard payload and the team-alert readers consume — with its `roles`
 * array typed by status-roles.ts's `StatusRoleRow`. Split out of status-data.ts the way
 * src/report/report-types.ts sits beside src/report/report-data.ts: the collectors in
 * src/status/status-*.ts fill these shapes and src/ui/, src/cli/ and src/inbox/ read them, so
 * the presentation layer depends on the contract without importing the collection code. Pure
 * types: no logic, no module-level state (the per-poll caches stay in status-polls.ts and
 * status-main-check.ts). */
import type { BuildStatus } from "../build/build-info.js";
import type {
  CheckPermitSnapshot,
  DiskStatus,
  OrchestratorInfo,
  PermitSnapshot,
  SlotPoolSnapshot,
} from "../team/team-orchestrator-info-types.js";
import type { SubscriptionWindowBlock } from "../agent/subscription-account.js";
import type { MergeInFlight } from "../merge/merge-slot.js";
import type { MainCheckStatus } from "./status-main-check.js";
import type { CiParityStatus, RemoteCiStatus } from "./status-polls.js";
import type { StatusRoleRow } from "./status-roles.js";
import type { RoleNoteOverCap } from "./status-role-notes.js";
import type { SalvagePatch } from "./status-salvage.js";
import type { MaintenanceMarker } from "../orchestrator/retention.js";
import type { GithubIssuesSummary } from "../github/github-issues-state.js";

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  /** Previews of those queued prompts in execution order, each via promptPreview (the shared
   * one-line preview width also used by the event previews) — full text would bloat the GUI
   * payload, and dashboards clip display width themselves. Fresh per poll like `questions`. */
  inboxPrompts: string[];
  /** The director queue's file basenames, same order as inboxPrompts — the address the
   * dashboard's per-row cancel affordance sends (/api/prompt-cancel cancels by queue file,
   * not by list position, so a 1 s-stale poll can never cancel the wrong entry). Same single
   * inbox pass as inboxPrompts (queuedRolePromptEntries), so the two arrays cannot drift. */
  inboxFiles: string[];
  /** The director queue's enqueue stamps (epoch ms parsed from each queue filename by
   * queueFileStamp — null for a hand-placed name), same order as inboxPrompts — the
   * established pairing pattern; the dashboard's Queued tab shows each prompt's age from it.
   * Same single inbox pass as inboxPrompts (queuedRolePromptEntries), so the arrays cannot
   * drift. */
  inboxQueuedAt: Array<number | null>;
  /** The director queue's not-before times (epoch ms parsed from each queue file's
   * `tumwater:not-before` marker line by notBeforeMs — null when absent or malformed), same
   * order as inboxPrompts — the established pairing pattern; the dashboard's Queued tab shows
   * each deferred prompt's delivery countdown from it. Same single inbox pass as inboxPrompts
   * (queuedRolePromptEntries), so the arrays cannot drift. */
  inboxNotBefore: Array<number | null>;
  /** Open questions awaiting a human answer (QUESTIONS.md's ## Open) — the header badge. */
  questions: number;
  /** One row per enabled role (`custom` marks user-defined roles for the dashboards'
   * asterisk): the persisted RunnerState plus the display-only fields the roles collector
   * computes at the source. Its shape is StatusRoleRow, the row type status-roles.ts
   * builds — declared here so `status --json` and the dashboards read the snapshot's own
   * contract. */
  roles: StatusRoleRow[];
  /** The daily cost budget, unconditionally (cap 0 = disabled — the display decides what to
   * show): today's team spend vs the cap, for the header badge on both dashboards (`· budget:
   * $X/$Y today` while enabled, `· no cap` when disabled) and the editable affordance that
   * needs a badge even on a disabled team. While the orchestrator runs, `spentUsd` is the
   * scheduler's OWN published figure (the gate's poll, over the runners' live in-memory
   * states — BUGS.md 2026-09-30): what an operator sees is what the scheduler enforces. Not
   * running, it is the persisted runner states' sum — a stopped team's files are final. The
   * per-role rows always read their persisted copies, so while runs are in flight the
   * per-role cells can sit under the header/total figure: that difference is exactly the
   * charge the scheduler has already counted. `free` is true when every model the team could
   * use resolves to an unpriced or zero-cost entry in pi's models.json (src/pi/pi-models.ts):
   * spend can never accumulate against a cap that cannot be reached, so both dashboards read
   * `· budget: n/a` instead of a dollar figure. `fallback` is the cost-free model roles
   * switch to once the cap is reached (plans/fallback-model.md) — non-null ONLY when one is
   * configured AND pi's definitions price it at zero, i.e. exactly when the gate would engage
   * it rather than pausing, so the dashboards' three-valued gate matches the scheduler's. */
  budget: {
    spentUsd: number;
    capUsd: number;
    /** When today's linear burn will reach the cap (epoch ms, the badge's `~cap at HH:MM`
     * forecast), or null when no forecast may be stated — no cap, no spend yet, the cap
     * already reached (the gate's own states supersede a forecast), or a burn that misses
     * midnight (budget.ts's projectCapHit, the one home of the rule). Computed once per poll
     * from the same materialized spend `spentUsd` renders, so every observer shows one
     * computed fact rather than three derivations. `status --json` and `/api/status` carry it
     * to scripts through the snapshot's own serialization. */
    capHitAt: number | null;
    free: boolean;
    fallback: { backend?: string; provider?: string; model?: string } | null;
    /** The per-tier fallback labels (part 7b/8): tier → `provider/model[ (from <tier>)]` —
     * non-null ONLY while the cap is reached and the tiers resolve to two or more distinct
     * pairs, the badge's tier-list state; a single fallback (the other tiers borrowing its
     * pair) leaves it undefined so the badge keeps today's single-pair text byte-identical.
     * Optional so literal budget blocks in the tests stand. The labels come from the same
     * resolution (resolveTierFallbacks over the published demotions) the per-role pause set
     * above reads, so the badge and the role rows cannot disagree about which pair a tier
     * runs on. */
    tiers?: Partial<Record<string, string>> | null;
  };
  /** Each tier the budget gate has off its primary and the fallback step it runs on, from the
   * live orchestrator's info file (fallback chain part 7c/7); absent when none moved or the
   * orchestrator is not alive. */
  chain?: OrchestratorInfo["chain"];
  /** One subscription-window block per subscription backend in use (plans/codex-backend.md
   * "Groundwork: the subscription account is per backend" item 3, part 3a/9), each carrying the
   * backend's own windows most-constrained-first — the claude 5h/7d and codex 5h/7d usage
   * readings the header badge, the GUI spend card and `status --json` show. Present only when at
   * least one subscription backend in use reported a window; `subscriptionOnly` is true when
   * every paying seam is free (the windows replace the daily-spend badge rather than just
   * joining it). Display only: no window holds or moves a seam (Subtract part 5u/6). */
  subscriptionWindows?: SubscriptionWindowBlock[];
  /** True when every paying seam is free (see `subscriptionWindows`). */
  subscriptionOnly: boolean;
  /** True while the operator has paused the team (`tumwater pause` marker present): every
   * idle role runner's state cell reads `paused`. Fresh per poll like `questions` — no cache,
   * because a 2-second-stale pause flag would mislead an operator mid-resume. */
  paused: boolean;
  /** The roles the operator has individually paused (`tumwater pause --role <id>` marker
   * set): an idle role in this set also reads `paused`, the same cell as under the team
   * pause. Fresh per poll like `paused` — no cache, for the same mid-resume reason. */
  pausedRoles: string[];
  /** The role ids the scheduler treats as paused by the per-role marker (`runnerPaused`): a role
   * whose own id, base role, or — for instance 1 — `<role>-1` key is in `pausedRoles`. The display
   * surfaces read this, while `pausedRoles` stays the raw marker `resume --role` takes. */
  pausedRunners: string[];
  /** The role ids the per-role daily cost cap holds (`maxDailyCostUsdPerRole`): an idle role
   * in this set reads `cap paused`, its own spend state — more specific than the team's
   * `budget paused`. Computed with the gate's own grouped verdict (roleCapVerdicts): instance
   * role ids share their base role's cap and its SUMMED spend, and the director is exempt,
   * exactly as the scheduler's gate groups and exempts them (role-cap-gates.ts). Uses the caps
   * of the same last-known-good config that produced the role list (a transiently broken
   * tumwater.json degrades with the whole config, like `quietHours`), so the verdict an
   * operator sees is the scheduler's. Always present, empty when none — the `pausedRoles`
   * shape. Fresh per poll, like `pausedRoles`: a live `config set` edit shows on the next
   * poll, and local midnight lifts the hold by itself. */
  capPaused: string[];
  /** The maintenance allowance (plans/work-ratio.md, part 1b/4): the rolling-24 h window's
   * `allowance` and `used` (maintenance merges plus maintenance roles in flight), and the
   * enabled maintenance role ids the scheduler holds while `used >= allowance`. Computed by the
   * brings the same pure verdict the gate folds (maintenance-quota-gates.ts) against this
   * process's own memo of the event log, so an observer shows the hold the scheduler enforces.
   * Always present, empty `held` while the gate is open — the `capPaused` shape with the
   * figures the role cell's
   * `held: maintenance quota <used>/<allowance>` label renders. Fresh per poll, like capPaused. */
  maintenanceQuota: { allowance: number; used: number; held: string[] };
  /** The new-project bootstrap (plans/work-ratio.md, part 2/2) while it is active: its progress
   * against `bootstrap.untilPlansDone`. Absent once the latch is written or the config entry
   * removed, so the surfaces render exactly as before in a normal project. */
  bootstrap?: { plansDone: number; untilPlansDone: number };
  /** The roles the bootstrap gate holds (see `bootstrap`): every role but plan, feature and
   * director — and bugfix while BUGS.md `## Open` is empty. An idle role in this set reads
   * `held: bootstrap`. Always present, empty when bootstrap is inactive — the `capPaused`
   * shape. Recomputed per poll from the gate's own predicate (bootstrap-gates.ts), so the hold
   * an operator sees is the hold the scheduler enforces. */
  bootstrapHeld: string[];
  /** The roles whose budget tier resolved to pause while the cap is reached (part 5c/8): a
   * role whose `model` tier (roleSeamTier) has no usable free pair — none configured, one
   * priced above zero, or its fallback breaker demoted — reads `budget paused`, the same cell
   * the team gate's old team-wide verdict filled. Computed with resolveTierFallbacks over
   * the SAME usable predicate the scheduler's gate folds (price at zero, and not among the
   * running orchestrator's published demotions), against the same last-known-good config as
   * `capPaused`, so the verdict an operator sees is the scheduler's — the per-tier pause set
   * (gate-polls.ts's budgetPausedRoles). The director is exempt, exactly as the gate exempts
   * it. Always present, empty when none — the `capPaused` shape. Fresh per poll, like
   * `capPaused`. */
  budgetPausedRoles: string[];
  /** The roles the per-role quiet-hours window holds (`quietHoursPerRole`): keyed by ROLE
   * id (`feature-2`, so rolePhase's `[s.role]` lookup finds the row) to that role's window
   * string as written (trimmed by quietHoursStatus's parser rule — the schedule as written,
   * not a reformat). The window is looked up by BASE role, exactly as the scheduler's own
   * gate does (gate-polls.ts's roleQuietHeld): config keys are base role ids, so an
   * instance role reads its base's window. An idle role in this map reads the team gate's
   * own quiet wording, scoped to its window — `quiet until <end>`. Computed with
   * roleQuietHold against the same last-known-good config as `capPaused` (a transiently
   * broken tumwater.json degrades with the whole config), the director exempt exactly as
   * the scheduler's gate exempts it. Empty when no per-role window holds anyone — the
   * `capPaused` shape's keyed sibling. Fresh per poll, like `capPaused`: a live `config
   * set quietHoursPerRole` edit shows on the next poll. */
  roleQuietPaused: Record<string, string>;
  /** The team marker's standing deadline (ms epoch) while a timed pause
   * (`tumwater pause --for <duration>`) holds — undefined for an indefinite team pause, a
   * role-only pause, or an expired `until` (team-state's read side already treats expiry as
   * unpaused, so the field cannot outlive the pause it describes). Team-scoped: only the
   * team marker's deadline may be claimed by a header badge, since only it covers the whole
   * team. JSON.stringify drops the undefined field, so `status --json` carries it only while
   * a timed team pause stands. Fresh per poll, like `paused`. */
  pausedUntil?: number;
  /** The paused-roles marker's one shared `until` (ms epoch) — the field `pause --role <id>
   * --for` writes — while a timed per-role pause stands; absent for a standing role pause, a
   * team-only pause, or after expiry. Read with `pausedRoles` from one marker parse, so it is
   * present only while that set is non-empty. */
  pausedRolesUntil?: number;
  /** A pending scheduled wake (`tumwater wake --in`): the roles it targets and the deadline
   * (ms epoch); absent for no marker, an immediate or expired one, or a corrupt one. */
  scheduledWake?: { roles: string[]; atMs: number };
  /** Every pending scheduled wake, earliest first (`scheduledWake` is its head); absent when
   * none is pending. */
  scheduledWakes?: { roles: string[]; atMs: number }[];
  /** The standing team pause's operator reason (`tumwater pause --reason <text>`), absent
   * for a reasonless pause, a role-only pause, or no pause at all — read from the same
   * standing marker read as `paused`/`pausedUntil`, so a reason is never advertised after
   * the pause it describes has lifted or been replaced (last write wins). JSON.stringify
   * drops the undefined field. Fresh per poll, like `paused`. */
  pauseReason?: string;
  /** The configured quiet-hours window as written (trimmed — "Quiet hours … part 2/2,
   * observability"), present only while the config's `quietHours` parses to a real window:
   * absent when unset or empty (off), because a schedule the gate is not holding must never
   * be advertised as one it is. A malformed value degrades with the whole config
   * (configForStatus's last-known-good hold, or the defaults when none exists) — the badge
   * never flashes off on one broken write. Standing information — the header badge shows it
   * in every configured state, like the budget badge's cap figure. Fresh per poll like
   * `paused`: a live `config set quietHours` edit shows on the next poll, the same
   * fresh-read rule the gate itself follows. */
  quietHours?: string;
  /** True while the LOCAL wall clock sits inside that window: idle roles start no new
   * runs (the director keeps steering). Decided by quiet-hours.ts's inQuietHours — the
   * scheduler's own predicate — so the dashboards and the hold cannot disagree. Fresh per
   * poll, like `quietHours`. */
  inQuietHours: boolean;
  /** The running harness's build (src/build/build-info.ts) as the orchestrator published it: the
   * stamp plus whether main's build inputs have moved past it. Null when no harness is running or
   * its dist carries no stamp. Both dashboards render it in the header — a stale build is the one
   * fact about the team that nothing inside the team can otherwise see. */
  build: BuildStatus | null;
  /** Prompts queued per role (`tumwater prompt --role <id>`),
   * keyed by role id for every enabled role except the director — the director's queue IS the
   * shared `inbox` above, so counting it here too would double-report the same prompts. Every
   * enabled role appears (0 included) so `status --json` consumers see one stable shape, like
   * `mergeQueue`; the dashboards render a `p:N` marker and the GUI's per-row prompt affordance
   * from it. Counts only — full previews stay in each queue file, readable via
   * `tumwater prompt --list --role <id>`. Fresh per poll (a directory listing per role, no
   * content reads — the stat-keyed prompt cache), like `inbox`/`inboxPrompts`. */
  roleInbox: Record<string, number>;
  /** Each non-director role's queued prompts with the queue-file basename that addresses
   * them (the /api/prompt-cancel target), execution order — the dashboard renders one cancel
   * row per prompt instead of a bare count. Roles with an empty queue are absent (unlike
   * roleInbox, which lists every role with 0): there is no row to render. Same read pass as
   * the previews (queuedRolePromptEntries, stat-keyed like the director's — each entry also
   * carries its enqueue stamp, queuedAtMs, for the Queued tab's age); filled only when
   * the count above is nonzero, so the common empty case costs one listing per role. */
  roleInboxPrompts: Record<string, Array<{ file: string; preview: string; queuedAtMs: number | null; notBeforeMs: number | null }>>;
  /** The durable merge queue (plans/merge-queue.md 4/5), unconditionally (depth 0 when
   * empty) so `status --json` consumers see one stable shape: the number of committed-but-
   * unmerged changes in the merge pipeline, and — only while a merge is actually
   * running — which ones. `inFlight` requires three things to agree: the 4/5 marker
   * exists, a queue entry with its sha still exists (entries are dropped only AFTER an
   * outcome — 3/5 — so in-flight always implies depth ≥ 1), and the orchestrator is alive.
   * The cross-check makes every crash ordering self-healing: a stale marker without a
   * matching entry never displays. The check is liveMergeMarker's: an older-generation
   * single-change marker displays only while its sha is queued; one with per-change records
   * keeps just the records whose entry is still queued and displays while one is not yet
   * `done`. */
  mergeQueue: {
    depth: number;
    /** Each queued change in execution order (oldest first) for `status --json` readers —
     * position, role, summary, sha, age. Filled from the same
     * `readMergeQueue` pass the depth already costs (shallow per-entry copies without the
     * optional `body`), only when at least one readable entry is queued — the
     * same filling discipline `roleInboxPrompts` follows: there is nothing to render, so the
     * common empty case carries no field. (`depth` can be positive with `entries` absent: it
     * also counts the unreadable files the reader skips.) */
    entries?: Array<{ role: string; sha: string; run: number; summary: string; enqueuedAt: number; revisionRound?: number; priorObjections?: number; retry?: string; notBefore?: number; highFriction?: true; retryCount?: number }>;
    inFlight?: MergeInFlight;
  };
  /** Main's newest merge-scope build check:
   * the latest `build_check` event at the `merge`/`batch`/`baseline` scope, read from the
   * event tail — the live replacement for the committed README stamp the readme role used to
   * maintain. `sha` is the main commit the check verified: a `merged` event after the check
   * names it via its `commit` field (a historical merge/batch check ran pre-merge; the merge's own
   * `merged` commit is the head it produced), while a baseline check names the newest merge
   * at or before its run's spawn (the head it ran on), never a later merge that landed after
   * it; otherwise main's current tip. Unresolvable from either source — no merge yet and no
   * readable ref — drops the field. Absent entirely
   * before any merge-scope check has run (and in tests that assemble snapshots by hand).
   * The verdict also carries how old it is (`checkedAt`) and, for a green, when the next full
   * check is due (`nextDueAt` — Hourly full check part 4/4); a red is rechecked on the next
   * head, not on the interval. While a red's one confirming full run is still settling after
   * a cleared red, `cleared` names the clearing head so the surfaces say "full check running"
   * instead of a verdict. */
  mainCheck?: MainCheckStatus;
  /** The disk floor's measured state (plans/disk-floor.md, part 4/4), read from the running
   * orchestrator's published info file: free space (one decimal), the configured floor and
   * reclaim threshold, whether the hold is on, and the last reclaim pass. Absent when no
   * orchestrator runs, its build predates the field, or statfs could not measure the volume —
   * every surface then renders exactly as before. */
  disk?: DiskStatus;
  /** The session-prune pass blocking the poll loop right now (`.tumwater/state/maintenance.json`,
   * retention.ts's marker), with `etaMs` — the linear estimate of the time left, absent until ten
   * deletes so the first samples give no silly figure. Absent unless the live orchestrator wrote
   * the marker (maintenanceForPoll): a SIGKILLed orchestrator never removes its marker, so a
   * marker naming a dead pid must not hold the banner up. Fresh per poll, like `paused`. */
  maintenance?: MaintenanceMarker & { etaMs?: number };
  /** The live orchestrator's poll loop has not stamped its heartbeat for over POLL_STALL_MS, and
   * no maintenance marker stands to explain it (pollStallForPoll). `lastPollAt` is the last stamp.
   * Absent for a stopped team, a team whose build predates the heartbeat, and any stall a
   * maintenance pass explains. Fresh per poll, like `maintenance`. */
  pollStalled?: { lastPollAt: number };
  /** The GitHub issues the team fixed but has not closed yet (github-issues-state.ts
   * githubCloseForStatus): fixes waiting for a push to `repo`, and open issues whose every entry
   * was retired. Absent when neither holds. Fresh per poll. */
  githubClose?: { repo: string; waitingPush: number; retiredOnly: number };
  /** The mirror's scan has gone quiet: the ledger's `checkedAt` sits past `GITHUB_ISSUES_STALE_MS`
   * (github-issues-state.ts's `githubScanStalled`), so the team has stopped mirroring the
   * operator's issue tracker even though `gh` may read fine. The doctor's `GitHub issues` warn row
   * and the dashboards' amber `github-scan-stalled` banner both raise it from this field's own
   * predicate and the one shared sentence. Absent for a fresh scan, no ledger, an unreadable
   * ledger, a ledger with no `checkedAt`, or `githubIssues.enabled: false`. Fresh per poll. */
  githubScanStall?: { repo: string; checkedAt: number };
  /** The standing per-provider failure holds (src/team/team-hold.ts `standingHolds`), read
   * from the running orchestrator's info file: a provider storm's hold, so the dashboards and
   * `tumwater status` name why a provider's roles sit idle. Absent while none stands or the
   * orchestrator is not alive. */
  providerHolds?: OrchestratorInfo["providerHolds"];
  /** The model check's pairs that are not verified (src/model-check/model-check-gate.ts), read
   * from the running orchestrator's info file: a pair still being checked, or one that failed
   * its probe and holds the roles on it, with the reply it gave. Absent while every pair answers,
   * the check is off, or the orchestrator is not alive. */
  modelChecks?: OrchestratorInfo["modelChecks"];
  /** Direct dependencies the root checkout's `node_modules` does not hold at `package-lock.json`'s
   * pin (the doctor's `root install` row); absent when none drift. */
  rootInstallDrift?: string[];
  /** The permit pool's live state (plans/provider-concurrency.md §8) as the orchestrator
   * published it: team in-use/cap plus each referenced provider key's state. Only while the
   * orchestrator runs; absent otherwise, so the surfaces render exactly as before, and the
   * provider part of the team line appears only while any key carries a cap. */
  permits?: PermitSnapshot;
  /** The ci observer's parity ledger's glance verdict (src/observer/ci-parity.ts, read through
   * status-polls.ts's ciParityForPoll): whether the last full-suite run has covered main's
   * current tip with the current lock — the badge's answer to "has the expensive verification
   * behind a green main actually run on this tip?". Absent when no parity record exists (a
   * repo the ci role has never run), so the surfaces render exactly as before the badge
   * existed. */
  ciParity?: CiParityStatus;
  /** The ci observer's remote-CI ledger's glance verdict (src/observer/remote-ci.ts, read
   * through status-polls.ts's remoteCiForPoll): the verdict GitHub's CI last reported on the
   * newest pushed commit of the base branch, recorded by the ci role on its `REMOTE:` line —
   * the badge's answer to "is hosted CI green on what was pushed?". Absent when no remote-CI
   * record exists (a repo whose ci role has never recorded one). An `unavailable` record is
   * carried but renders no badge (badges.ts's remoteCiBadge returns "" for it) — the
   * surfaces stay byte-identical and the doctor `remote CI` row is the exact surface for
   * that state. */
  remoteCi?: RemoteCiStatus;
  /** True when no deterministic build check is declared — `detectBuildCheck(root, config)`
   * returned null (no `check.command` and no qualifying npm `package.json` on the walked-up
   * root) — the doctor `check` row's undeclared state (src/doctor/doctor-project-checks.ts's
   * checkBuildCheck). Present only in that state, so the always-on blue `no-check` info alert
   * surfaces the state on `tumwater status` and the dashboard; absent
   * otherwise, so the surfaces render exactly as before. */
  noDeclaredCheck?: boolean;
  /** The reason the live tumwater.json did not load (a validation or parse error's text, or
   * the missing-file sentence) while the snapshot serves the last-known-good config — the
   * raw string the always-on amber `config-problem` alert renders, so `tumwater status
   * --json` scripts read what the surfaces show. Absent when the live config loads, so the
   * surfaces render exactly as before. */
  configProblem?: string;
  /** True when a brief candidate file exists but none resolves to a usable prompt block —
   * the marker-less file, the unreadable candidate, or a marked block with no text
   * (src/brief/brief.ts's briefStatus.missing) — the doctor `brief` row's marker-less,
   * unreadable and empty-block warning state. Present only in that state, so the always-on
   * amber `no-brief` alert surfaces the silent state on `tumwater status` and the dashboard; absent
   * otherwise (including the bare pre-init repo), so the surfaces render
   * exactly as before. */
  noBrief?: boolean;
  /** True when the resolved brief block exceeds the read cap (src/brief/brief.ts's
   * briefStatus.overCap) — the doctor `brief` row's over-cap warning state, the warning tune
   * extractPrompt truncates every run's prompt with. Present only in that state (the
   * always-on amber `brief-truncated` alert surfaces it on `tumwater status` and the dashboard);
   * absent otherwise (at-cap, under-cap, empty and marker-less-keep-
   * `no-brief`'s), so the surfaces render exactly as before. */
  briefTruncated?: boolean;
  /** Every role whose notes file runs past the read bound — the doctor `role notes` row's
   * over-bound warning state (src/doctor/doctor-role-notes.ts's checkRoleNotes), raised as a
   * standing amber alert on `tumwater status` and the dashboard. Each entry is the
   * role's id and its note's length in characters, sorted newest-char-count first; present
   * only when non-empty, so the surfaces render exactly as before. */
  roleNotesOverCap?: RoleNoteOverCap[];
  /** The GitHub issues ledger folded to its counts (github-issues-state.ts's githubIssuesSummary),
   * read fresh per poll: the amber `github-gh` alert when gh cannot read the repo, the gray
   * `github-error` alert when the last scan failed, and the blue `github-mirror` alert when
   * issues wait to be mirrored. Absent when no scan has written a ledger or the config sets
   * `githubIssues.enabled: false`, so the surfaces render exactly as before. */
  githubIssues?: GithubIssuesSummary;
  /** Every operator-kept workspace patch under `.tumwater/salvage/` (src/status/status-salvage.ts's
   * collectSalvagePatches), the doctor `salvage patches` row's warning state raised as a standing
   * amber alert on `tumwater status` and the dashboard — so a run's kept leftovers are
   * not silently pruned by session retention. Each entry is the patch's position in the
   * oldest-first list (the number the doctor row and `tumwater salvage` print, which
   * `salvage --show <n>` / `--drop <n>` address), its file name, save time and byte size;
   * present only when non-empty, so the surfaces render exactly as before. */
  salvagePatches?: SalvagePatch[];
  /** True when PRINCIPLES.md's trimmed text exceeds the prompt cap, so every role's
   * <principles> block carries only its head plus a truncation marker (src/prompt/
   * principles.ts's principlesBlockOverCap) — the diagnostic over-cap state the doctor
   * `principles` row reports and the orchestrator's automatic consolidation request
   * (src/prompt/principles-consolidation.ts) acts on, with no standing alert consumer.
   * Present only in that state; absent otherwise (including no PRINCIPLES.md), so the
   * `--json` key and surfaces read exactly as before. */
  principlesTruncated?: boolean;
  /** The check-permit pool's live state as the orchestrator published it; only while it runs. */
  checkPermits?: CheckPermitSnapshot;
  /** The workspace pool's live state as the running orchestrator published it; absent
   * otherwise, so a stopped team never shows a stale pool. */
  slotPool?: SlotPoolSnapshot;
  /** The earlier of the `run --for` deadline (the running orchestrator's info file) and a
   * `tumwater stop --in` marker (epoch ms); absent when neither is set or the team is stopped. */
  runStopsAt?: number;
  /** A `tumwater stop --in` marker's deadline (epoch ms) alone, so a surface can tell it from
   * `run --for`'s; absent when none is set or the team is stopped. */
  scheduledStopAt?: number;
}
