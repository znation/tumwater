import { openBugs, openQuestions } from "../backlog/backlog.js";
import { baseRoleOf, roleInScope, runnerIds, runnerPaused } from "../roles/runner-ids.js";
import { piModelsPath } from "../pi/pi-models.js";
import {
  type configForStatus,
  configStateForStatus,
  queueInFlight,
  maintenanceQuotaForPoll,
  ciParityForPoll,
  remoteCiForPoll,
  qaCoverageForPoll,
  slotsForPoll,
} from "./status-polls.js";
import {
  orchestratorAlive,
  readOrchestratorInfo,
} from "../team/team-orchestrator-info.js";
import { buildCheckForPoll } from "../build/build-check-poll.js";
import { quietHoursStatus, roleQuietHeldRoles } from "../scheduling/quiet-hours.js";
import { scheduledStopAt, scheduledWakes, standingRolePause, standingTeamPause } from "../team/team-state.js";
import { bootstrapHoldsRole, bootstrapStatus } from "../gates/bootstrap-gates.js";
import { readMergeQueue } from "../merge/merge-queue.js";
import { mainCheckForPoll } from "./status-main-check.js";
import { collectRoleRows } from "./status-roles.js";
import { collectInboxes } from "./status-inbox.js";
import { collectRoleNotesOverCap, type RoleNoteOverCap } from "./status-role-notes.js";
import { collectSalvagePatches } from "./status-salvage.js";
import { collectBudget } from "./status-budget.js";
import { collectRootInstallDrift } from "./status-install.js";
import { briefStatus } from "../brief/brief.js";
import { principlesBlockOverCap } from "../prompt/principles.js";
import type { MaintenanceMarker } from "../orchestrator/retention.js";
import { githubCloseForStatus } from "../github/github-issues-state.js";
import { heartbeatPath, maintenancePath } from "../paths.js";
import { githubIssuesSummary, githubScanStalled, readGithubIssuesForPoll } from "../github/github-issues-state.js";
import { readJsonFile } from "../files/json-files.js";
import type { StatusSnapshot } from "./status-types.js";

/** Status data collection: one fresh snapshot of the team for observers (`tumwater
 * status`, GUI). The snapshot's shape lives in status-types.ts; rendering lives in
 * status-render.ts; the per-poll cached readers snapshot() reads through live in
 * status/status-polls.ts and status/status-main-check.ts — the main-check scan, the
 * last-known-good config, the runner-state stat cache, the pooled slots, the ci and remote-CI
 * ledgers, the merge-in-flight marker and the maintenance allowance; the declared check is read
 * through build/build-check-poll.ts. snapshot() composes the per-domain collectors in
 * status-roles.ts, status-inbox.ts and status-budget.ts and keeps the one-off fields here. */

/** The earlier of the two optional stop deadlines (`run --for`'s and a scheduled stop's). */
function earliestStop(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/** The snapshot keeping only the listed roles' rows: a base id also keeps its instances
 * (`feature` keeps `feature-2`). Every other field stays team-wide. */
export function scopeSnapshotToRoles(snap: StatusSnapshot, roles: readonly string[]): StatusSnapshot {
  return { ...snap, roles: snap.roles.filter((s) => roleInScope(s.role, roles)) };
}

/** The run-state header fields (running/pid/build) of the snapshot. */
function snapshotRunFields(
  running: boolean,
  info: ReturnType<typeof readOrchestratorInfo>,
): Partial<StatusSnapshot> {
  return {
    running,
    pid: info?.pid,
    build: running && info?.build ? info.build : null,
  };
}

/** The director and per-role inbox fields and the open question count of the snapshot. The
 * `collectInboxes` read stays in `snapshot`; the
 * builder recomposes the destructured values and reads the open question count from `root`. */
function snapshotInboxFields(
  root: string,
  inboxes: ReturnType<typeof collectInboxes>,
): Partial<StatusSnapshot> {
  return {
    inbox: inboxes.inbox,
    inboxPrompts: inboxes.inboxPrompts,
    inboxFiles: inboxes.inboxFiles,
    inboxQueuedAt: inboxes.inboxQueuedAt,
    inboxNotBefore: inboxes.inboxNotBefore,
    roleInbox: inboxes.roleInbox,
    roleInboxPrompts: inboxes.roleInboxPrompts,
    questions: openQuestions(root).length,
  };
}

/** The running team's model checks that are not verified, as a snapshot fragment: empty when
 * the team is stopped or every pair answered. */
function unverifiedModelChecks(
  running: boolean,
  info: ReturnType<typeof readOrchestratorInfo>,
): Pick<StatusSnapshot, "modelChecks"> {
  const open = running ? (info?.modelChecks ?? []).filter((c) => c.status !== "verified") : [];
  return open.length > 0 ? { modelChecks: open } : {};
}

/** The spend/billing fields of the snapshot: the budget, the per-backend subscription windows
 * and the running-only chain/provider holds. */
function snapshotBudgetFields(
  budget: ReturnType<typeof collectBudget>["budget"],
  subscriptionWindows: ReturnType<typeof collectBudget>["subscriptionWindows"],
  subscriptionOnly: ReturnType<typeof collectBudget>["subscriptionOnly"],
  running: boolean,
  info: ReturnType<typeof readOrchestratorInfo>,
): Partial<StatusSnapshot> {
  return {
    // Unconditional (never null): a disabled team still shows its spend and the badge is
    // the affordance for SETTING a cap. models.json itself is stat-cached inside pi-models.ts,
    // so an unchanged catalog costs one stat per poll, not a re-read plus parse.
    budget,
    // One window block per subscription backend in use, raw for `status --json` and the
    // window displays; omitted when no subscription backend reported a window.
    ...(subscriptionWindows.length > 0 ? { subscriptionWindows } : {}),
    subscriptionOnly,
    ...(running && info?.chain && Object.keys(info.chain).length > 0 ? { chain: info.chain } : {}),
    // Only while running: a stale info file beside a dead pid must not speak for a stopped
    // team, and only while a hold stands (an empty list is the same as none).
    ...(running && info?.providerHolds && info.providerHolds.length > 0 ? { providerHolds: info.providerHolds } : {}),
    // Only the pairs that hold roles: an all-verified team reads exactly as before the check.
    ...unverifiedModelChecks(running, info),
  };
}

/** The pause/quiet-hours fields of the snapshot: the paused flags and their deadlines, the
 * maintenance quota and bootstrap holds, and the per-role quiet windows. */
function snapshotPauseFields(
  teamPause: ReturnType<typeof standingTeamPause>,
  markerRoles: ReturnType<typeof standingRolePause>["roles"],
  markerRolesUntil: number | undefined,
  roles: ReturnType<typeof runnerIds>,
  markerSet: Set<string>,
  capPaused: ReturnType<typeof collectBudget>["capPaused"],
  maintenanceQuota: ReturnType<typeof maintenanceQuotaForPoll>,
  bootstrapNow: ReturnType<typeof bootstrapStatus>,
  roleRows: ReturnType<typeof collectRoleRows>,
  budgetPausedRoles: ReturnType<typeof collectBudget>["budgetPausedRoles"],
  cfg: ReturnType<typeof configForStatus>,
  root: string,
  wakes: ReturnType<typeof scheduledWakes>,
  quiet: ReturnType<typeof quietHoursStatus>,
  now: number,
): Partial<StatusSnapshot> {
  return {
    paused: teamPause !== null,
    pausedRoles: markerRoles,
    pausedRunners: roles.filter((id) => runnerPaused(markerSet, id)),
    capPaused,
    maintenanceQuota,
    // The new-project bootstrap hold (plans/work-ratio.md, part 2/2): the same read-only
    // verdict the gate computes (bootstrapStatus), so the dashboards and the scheduler agree.
    // The held set is computed with the gate's own predicate over the same role list.
    bootstrap:
      bootstrapNow?.active
        ? { plansDone: bootstrapNow.plansDone, untilPlansDone: bootstrapNow.untilPlansDone }
        : undefined,
    bootstrapHeld:
      bootstrapNow?.active
        ? roleRows.filter((l) => bootstrapHoldsRole(l.role, openBugs(root).length > 0)).map((l) => l.role)
        : [],
    budgetPausedRoles,
    // The per-role quiet windows' held roles (PLANS.md quietHoursPerRole): keyed role →
    // window, so the dashboards can render the same `quiet until <end>` wording the team
    // badge uses, scoped to the role's own schedule. The window string comes back out of
    // the same config the hold was decided from, so the label cannot name a window that is
    // not holding (roleQuietHold true implies a parseable, non-empty string there). The held
    // set is the shared roleQuietHeldRoles pass (the same one the scheduler's gate runs), so
    // the surfaces cannot disagree about who the per-role windows hold.
    roleQuietPaused: Object.fromEntries(
      roleQuietHeldRoles(cfg.quietHoursPerRole, roleRows.map((l) => l.role), new Date(now))
        .map((l) => [l, cfg.quietHoursPerRole?.[baseRoleOf(l)] ?? ""]),
    ),
    pausedUntil: teamPause?.until,
    pausedRolesUntil: markerRolesUntil,
    scheduledWake: wakes[0],
    scheduledWakes: wakes.length > 0 ? wakes : undefined,
    pauseReason: teamPause?.reason,
    quietHours: quiet.window ?? undefined,
    inQuietHours: quiet.inWindow,
  };
}

/** The merge-queue and doctor health fields of the snapshot (main-check, ci-parity and the
 * build-check/brief/principles flags, plus the role notes over cap). `now` is the poll's clock,
 * passed through so the GitHub mirror's stall is decided where its ledger is already open. */
function snapshotHealthFields(
  root: string,
  cfg: ReturnType<typeof configForStatus>,
  mergeQueue: StatusSnapshot["mergeQueue"],
  roleNotesOverCap: RoleNoteOverCap[],
  configProblem: string | undefined,
  now: number,
): Partial<StatusSnapshot> {
  // The brief's two degraded flags from ONE scan/read (brief.briefStatus): the always-on
  // `no-brief` and `brief-truncated` amber alerts, read once per poll rather than twice
  // re-reading the whole brief file.
  const brief = briefStatus(root);
  // Every operator-kept workspace patch (status-salvage.ts): the standing twin of the doctor
  // `salvage patches` row, raised as the amber `salvage-patches` alert. Read here once per poll
  // so the raw array is the same walk the doctor row runs.
  const salvagePatches = collectSalvagePatches(root);
  return {
    mergeQueue,
    mainCheck: mainCheckForPoll(root, cfg),
    ciParity: ciParityForPoll(root, cfg),
    remoteCi: remoteCiForPoll(root),
    qaCoverage: qaCoverageForPoll(root, now),
    noDeclaredCheck: buildCheckForPoll(root, cfg) === null ? true : undefined,
    ...(configProblem ? { configProblem } : {}),
    noBrief: brief.missing ? true : undefined,
    briefTruncated: brief.overCap ? true : undefined,
    ...(roleNotesOverCap.length > 0 ? { roleNotesOverCap } : {}),
    ...(salvagePatches.length > 0 ? { salvagePatches } : {}),
    principlesTruncated: principlesBlockOverCap(root) ? true : undefined,
    ...githubIssuesForPoll(root, cfg, now),
  };
}

/** The GitHub issues ledger as the snapshot's `githubIssues` field (part 3/5): read from the
 * scan's ledger through its stat-keyed per-poll cache (github-issues-state.ts's
 * readGithubIssuesForPoll), never from `gh`, and absent when the feature is off, no ledger exists,
 * or the ledger's shape is foreign. The same read decides the `githubScanStall` field — the mirror
 * stopped scanning past `GITHUB_ISSUES_STALE_MS` — so the stall is settled where the ledger is
 * already open, not at render time, and both dashboards raise the standing banner from it. Absent
 * for a fresh scan, a ledger with no readable `checkedAt`, and every case above. */
function githubIssuesForPoll(
  root: string,
  cfg: ReturnType<typeof configForStatus>,
  now: number,
): Pick<StatusSnapshot, "githubIssues" | "githubScanStall"> {
  if (cfg.githubIssues?.enabled === false) return {};
  const ledger = readGithubIssuesForPoll(root);
  if (ledger === null) return {};
  return {
    githubIssues: githubIssuesSummary(ledger, cfg.githubIssues?.mirrorLabel ?? "tumwater"),
    ...(githubScanStalled(ledger, now)
      ? { githubScanStall: { repo: ledger.repo, checkedAt: ledger.checkedAt } }
      : {}),
  };
}

/** The value of one running-only orchestrator-info field: present only while a live team
 * publishes it — a stale info file beside a dead pid must not speak for a stopped team, so the
 * field is absent (not a stale block) whenever the team is not running or the field itself is.
 * `snapshotResourceFields`'s running-only info fields share this guard instead of spelling
 * `running && info?.x ? info.x : undefined` per field, so the liveness rule lives in one place
 * (the test `status-data-team.test.ts` "snapshot carries the running orchestrator's published
 * disk state" pins the stale-block arm). */
function liveInfoField<T>(running: boolean, field: T | undefined): T | undefined {
  return running && field !== undefined ? field : undefined;
}

/** The session-prune marker the live orchestrator (pid `livePid`) is writing, read fresh per poll
 * (no cache, like the paused markers). A marker naming another pid — a SIGKILLed orchestrator
 * never removed its own — or no live orchestrator at all reads as absent. `etaMs` is the linear
 * estimate `(updatedAt − halfStartedAt) / done × (total − done)` — this half's elapsed time, as
 * `done`/`total` reset each half — withheld until ten deletes so the first noisy samples give no
 * silly figure. */
export function maintenanceForPoll(root: string, livePid: number | undefined): StatusSnapshot["maintenance"] {
  if (livePid === undefined) return undefined;
  const marker = readJsonFile<MaintenanceMarker>(maintenancePath(root));
  if (marker?.pid !== livePid || !Number.isFinite(marker.done)) return undefined;
  const { done, halfStartedAt, updatedAt } = marker;
  const etaMs = done >= 10 ? ((updatedAt - halfStartedAt) / done) * (marker.total - done) : undefined;
  return { ...marker, ...(etaMs === undefined || !Number.isFinite(etaMs) ? {} : { etaMs }) };
}

/** How long the poll heartbeat may go unstamped before observers call the poll loop stalled.
 * Not measured on a live team. Chosen above every synchronous step the poll runs without a
 * marker: the poll's git reads are short spawnSync calls, the merge check runs as a child
 * process the poll does not wait on, and the session prune — the one known long pass — writes
 * its own marker (maintenance.json) and is excluded by pollStallForPoll. A stall past this
 * with no marker is a step nothing has named yet, which is what the alert is for. */
export const POLL_STALL_MS = 3 * 60_000;

/** The poll heartbeat's reader (src/orchestrator/orchestrator-poll.ts stampHeartbeat), read fresh
 * per poll. Stalled means: the live orchestrator (pid `livePid`) wrote the heartbeat, its last
 * stamp is more than POLL_STALL_MS old, and no maintenance marker stands for the pass that would
 * explain it (`maintenanceStands`). No live orchestrator, a heartbeat another pid wrote (a dead
 * predecessor's), or no heartbeat file at all (a team started by an older build) reads as absent:
 * a dead pid is the stopped-team alert's case, not this one. */
export function pollStallForPoll(
  root: string,
  livePid: number | undefined,
  maintenanceStands: boolean,
  now: number,
): StatusSnapshot["pollStalled"] {
  if (livePid === undefined || maintenanceStands) return undefined;
  const beat = readJsonFile<{ pid: number; lastPollAt: number }>(heartbeatPath(root));
  if (beat?.pid !== livePid || !Number.isFinite(beat.lastPollAt)) return undefined;
  return now - beat.lastPollAt > POLL_STALL_MS ? { lastPollAt: beat.lastPollAt } : undefined;
}

/** The running-only resource fields of the snapshot (disk floor, install drift, permits and
 * the run stop deadlines). */
function snapshotResourceFields(
  root: string,
  running: boolean,
  info: ReturnType<typeof readOrchestratorInfo>,
  rootDrift: ReturnType<typeof collectRootInstallDrift>,
): Partial<StatusSnapshot> {
  // One read of the scheduled-stop marker per poll serves both the runStopsAt deadline and
  // the raw scheduledStopAt field — the two fields each used to re-read the same stat-cached
  // marker file (a second stat per poll), like the paused markers above. Only while running:
  // a stopped team's marker must not speak for it (each field was already `running`-gated).
  const stopAt = running ? scheduledStopAt(root) : undefined;
  const livePid = running ? info?.pid : undefined;
  const maintenance = maintenanceForPoll(root, livePid);
  return {
    // The disk floor's published state (plans/disk-floor.md, part 4/4): only while the
    // orchestrator runs and only when the last poll could measure the volume (liveInfoField).
    // Absent otherwise, so the surfaces render exactly as before.
    disk: liveInfoField(running, info?.disk),
    // Independent of the team running: a stopped team's worktrees still borrow the root install.
    rootInstallDrift: rootDrift.length ? rootDrift : undefined,
    // Only while a live team publishes each (liveInfoField: a stale info file beside a dead pid
    // must not speak for a stopped team).
    permits: liveInfoField(running, info?.permits),
    slotPool: liveInfoField(running, info?.slotPool),
    checkPermits: liveInfoField(running, info?.checkPermits),
    // Only while running: a stale info file beside a dead pid must not speak for a stopped team.
    runStopsAt: running ? earliestStop(info?.stopsAt, stopAt) : undefined,
    scheduledStopAt: running ? stopAt : undefined,
    // The live orchestrator's pid, so a marker a dead orchestrator left behind reads as absent.
    maintenance,
    // The heartbeat's stall check: a standing maintenance marker explains a quiet poll, so the
    // stall reads as absent and the blue maintenance banner is the only one shown.
    pollStalled: pollStallForPoll(root, livePid, maintenance !== undefined, Date.now()),
    // The GitHub issues awaiting a close or a push (part 5/5); absent when none does.
    githubClose: githubCloseForStatus(root),
  };
}

/** One fresh team snapshot for observers. `modelsPath` overrides pi's model definitions
 * location (default ~/.pi/agent/models.json) — a test seam, like doctor's pathEnv. `now` pins
 * the poll's clock for the budget figures (the persisted day-stamp check and the burn-rate
 * projection) — one instant for the whole block, and the seam that keeps a test's expected
 * projection from racing the snapshot's own `Date.now()`; production callers take the default
 * and read the live clock, as always. The three per-domain collectors (status-roles, status-
 * inbox, status-budget) each take the shared reads and the pinned `now` as parameters, so
 * every poll still reads a shared resource exactly once and the one `now` pins the whole
 * snapshot — the consistency property the per-collector comments call out. */
export function snapshotForStatus(root: string, modelsPath = piModelsPath(), now = Date.now()): StatusSnapshot {
  // The config and its live-load problem from ONE read, so the role rows and the standing
  // `config-problem` alert cannot drift on which poll each happened to read.
  const { config: cfg, problem } = configStateForStatus(root);
  const rootDrift = collectRootInstallDrift(root, now);
  // The gate's read-only bootstrap verdict (plans/work-ratio.md, part 2/2), computed over the
  // same last-known-good config the caps read, so the dashboards show the hold the scheduler
  // enforces. Null when no bootstrap is configured.
  const bootstrapNow = bootstrapStatus(root, cfg);
  // One row per role id (part 5b/7): an instance role shows `feature` and `feature-2`.
  const roles = runnerIds(cfg);
  // One read of the paused-roles marker per poll serves both the set and its shared deadline
  // (`pause --role --for` wrote it): standingRolePause returns both from the same parse, so a
  // snapshot never reads the same marker file twice (pausedRoles + pausedRolesUntil each did).
  const { roles: markerRoles, until: markerRolesUntil } = standingRolePause(root);
  const markerSet = new Set(markerRoles);
  // One read of the orchestrator info file per poll: it serves both the displayed pid and the
  // liveness check (passing it to orchestratorAlive skips its own re-read).
  const info = readOrchestratorInfo(root);
  // One slots.json read per poll serves every row: the pooled slot a role leases (a running
  // run or verification) or is pinned to — threaded into the roles collector so `running`,
  // `disk` and the rows agree. Stat-cached by file, so unchanged slots cost one stat per poll.
  const slots = slotsForPoll(root);
  // One merge-queue pass per poll (merge-queue.ts's stat cache keeps an unchanged queue at one
  // stat per file) serves three consumers — the `mergeQueue` field below, the busy runner rows'
  // surplus-eligibility check (collectRoleRows' `queued`), and the in-maintenance in-flight
  // count (maintenanceQuotaForPoll) — so a snapshot never lists or re-reads the same queue
  // twice, and the rows, the depth and the quota cannot straddle a concurrent enqueue/drop.
  const queue = readMergeQueue(root);
  const merges = queue.entries;
  const queuedRoles = new Set(merges.map((e) => e.role));
  const roleRows = collectRoleRows(root, cfg, slots, modelsPath, markerSet, queuedRoles);
  // Every role whose notes file runs past the read bound (status-role-notes.ts): the standing
  // twin of the doctor `role notes` row, raised as the amber role-notes-truncated alert.
  const roleNotesOverCap = collectRoleNotesOverCap(root);
  // One inbox pass per poll (status-inbox.ts) serves all four director fields and the per-role
  // counts/entries from the same queuedRolePromptEntries reads.
  const { inbox, inboxPrompts, inboxFiles, inboxQueuedAt, inboxNotBefore, roleInbox, roleInboxPrompts } =
    collectInboxes(root, roles, now);
  const running = orchestratorAlive(root, info);
  // One team-pause-marker read per poll serves both the paused flag and its deadline:
  // isTeamPaused + pausedUntil would each re-read the same marker file every second.
  const teamPause = standingTeamPause(root);
  // One read of the pending scheduled wakes feeds both the earliest and the full list, so they
  // cannot disagree.
  const wakes = scheduledWakes(root, now);
  // The merge queue read is hoisted above the rows collector (one pass serves the depth, the
  // rows' surplus check, and the quota below); inFlight is the 4/5 marker only when a live
  // orchestrator still has a queue entry for what the marker names (per change, for a batch) —
  // the cross-check makes every crash ordering self-healing (a stale marker alone never displays,
  // and needs no cleanup pass).
  const mergeQueue: StatusSnapshot["mergeQueue"] = {
    depth: merges.length + queue.unreadable,
  };
  if (merges.length > 0) {
    mergeQueue.entries = merges.map((e) => ({
      role: e.role,
      sha: e.sha,
      run: e.run,
      summary: e.summary,
      enqueuedAt: e.enqueuedAt,
      ...(e.revisionRound !== undefined ? { revisionRound: e.revisionRound } : {}),
      ...(Array.isArray(e.priorReview?.reasons) && e.priorReview.reasons.length > 0 ? { priorObjections: e.priorReview.reasons.length } : {}),
      ...(typeof e.retry === "string" ? { retry: e.retry } : {}),
      ...(typeof e.notBefore === "number" ? { notBefore: e.notBefore } : {}),
      ...(e.highFriction === true ? { highFriction: true as const } : {}),
      ...(typeof e.retryCount === "number" ? { retryCount: e.retryCount } : {}),
    }));
  }
  const inFlight = queueInFlight(root, merges, running);
  if (inFlight) mergeQueue.inFlight = inFlight;
  // Quiet hours 2/2 — one parse and one clock read per poll serve both the window string the
  // header badge renders and the in-window boolean the active reading turns on; the value is
  // read fresh from the same cached config load the budget block uses, so a live edit shows
  // on the next poll exactly when the gate applies it.
  const quiet = quietHoursStatus(cfg.quietHours, new Date());
  // The spend/billing block (status-budget.ts): the budget object, the per-backend
  // subscription windows and the team-global free-ness answer, and the two per-role pause
  // verdicts, all from one readPiProviders and one readAccount per backend in use per poll.
  const { budget, subscriptionWindows, subscriptionOnly, budgetPausedRoles, capPaused } = collectBudget(
    root,
    cfg,
    roleRows,
    roles,
    running,
    info,
    modelsPath,
    now,
  );
  // The maintenance allowance (plans/work-ratio.md, part 1b/4): the same pure verdict the
  // gate folds, over the same event log, so the dashboards show the hold the scheduler
  // enforces.
  const maintenanceQuota = maintenanceQuotaForPoll(
    root,
    cfg.maintenancePerWorkMerge,
    roleRows,
    now,
  );
  return {
    ...snapshotRunFields(running, info),
    ...snapshotInboxFields(
      root,
      { inbox, inboxPrompts, inboxFiles, inboxQueuedAt, inboxNotBefore, roleInbox, roleInboxPrompts },
    ),
    roles: roleRows,
    ...snapshotBudgetFields(budget, subscriptionWindows, subscriptionOnly, running, info),
    ...snapshotPauseFields(
      teamPause,
      markerRoles,
      markerRolesUntil,
      roles,
      markerSet,
      capPaused,
      maintenanceQuota,
      bootstrapNow,
      roleRows,
      budgetPausedRoles,
      cfg,
      root,
      wakes,
      quiet,
      now,
    ),
    ...snapshotHealthFields(root, cfg, mergeQueue, roleNotesOverCap, problem, now),
    ...snapshotResourceFields(root, running, info, rootDrift),
  } as StatusSnapshot;
}

/** The async form callers await: `snapshot` resolves to the same `StatusSnapshot` that
 * {@link snapshotForStatus} returns. This part's body is still fully synchronous (the
 * pin-sourced `mergeQueue` read that makes it genuinely async lands in the next part, where
 * it becomes `await readMergePins(...)`), so the `async` here is the signature the surfaces
 * convert to — the GUI's `/api/status` and the CLI `await` it. `tumwater status -f` reads
 * `snapshotForStatus` synchronously: its first paint must land in the tick that scheduled it.
 * When the read becomes genuinely async, that follow loop moves to this form.
 */
export async function snapshot(root: string, modelsPath = piModelsPath(), now = Date.now()): Promise<StatusSnapshot> {
  return snapshotForStatus(root, modelsPath, now);
}
