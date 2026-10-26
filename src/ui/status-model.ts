import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import type { RunnerState } from "../runner/runner-state.js";
import type { PermitSnapshot } from "../team/orchestrator-info.js";
import type { StatusSnapshot } from "../status/status-data.js";
import { heldByMainRed } from "../status/status-polls.js";
import { errorStreakAtWarn, QUIET_KILL_RESUME_LIMIT } from "../run/run-apply.js";
import { readLiveProgress, type LiveProgress } from "./progress-data.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { yieldMultiplierFor } from "../scheduling/backoff.js";
import { humanSeconds, humanUntil, secondsUntil } from "../text/datetime.js";
import {
  duration,
  inFlightDetail,
  inFlightLabel,
  progressKind,
  runProgress,
  workingDetail,
} from "./run-progress-model.js";
import { mergeChanges, MERGE_STAGE_LABELS, type MergeChange } from "../merge/merge-slot.js";

/** The status DISPLAY MODEL: the role's cycle position (the phase ladder), its merge cell,
 * and its per-role row derivation (the header badges live next door in badges.ts, the
 * in-flight run's live progress detail in run-progress-model.ts) — derived from the status
 * data (status/status-data.ts) and shared by BOTH observer surfaces: the terminal table
 * (status-render.ts's renderStatus/stateCell) and the JSON/GUI payload (status-payload.ts).
 * Kept apart from status-render.ts so the GUI payload depends on the shared model, not on the
 * TUI table module — "what to show" (here) is separate from "how a terminal lays it out"
 * (status-render.ts). Depends on status/status-data.ts one way: deriving reads the snapshot
 * and never collects team state itself (live run detail is display-only). */

type MergeCell = Pick<MergeChange, "status" | "startedAt" | "stage" | "stageSince">;

/** The snapshot's in-flight merge record (merge queue 4/5) filtered to one role: this
 * role's change record while the pipeline holds it — verifying or merging it (`merge`), or
 * keeping it for the merge slot (`approved`) — and null otherwise, including once the merge is
 * `done` with it (a change that reached its outcome must not keep a live label while the rest of
 * its stack merges — BUGS.md 2026-09-23). An older generation's one-change marker reads as one
 * `merge` record (mergeChanges). The single home of the "is this role merge" filter —
 * every phase call site derives its `merge` argument through this so the filtering cannot
 * drift between them. */
export function mergeForRole(mergeQueue: StatusSnapshot["mergeQueue"], role: string): MergeCell | null {
  if (!mergeQueue.inFlight) return null;
  const change = mergeChanges(mergeQueue.inFlight).find((c) => c.role === role);
  return change && change.status !== "done"
    ? { status: change.status, startedAt: change.startedAt, stage: change.stage, stageSince: change.stageSince }
    : null;
}

/** The work text a row shows in place of live progress while it is idle or merge
 * (plans/parallel-work-instances.md "Observability", part 6/7): the claim's heading when the
 * instance holds one. Returns null otherwise, so the state cell keeps its plain phase — an
 * idle instance's phase label (`idle: no unclaimed plans`) carries its own reason. */
export function idleClaimText(s: { claim?: RunnerState["claim"]; role: string }, _phase: string): string | null {
  return s.claim ? s.claim.title : null;
}

/** The role's state label — the one precedence ladder shared by the status table and both
 * dashboards (renderStatus, statusPayload). First match wins: a stopped harness; an in-flight
 * merge (the role's run already ended "queued" while its change merges, so the marker
 * supplies the label); an in-flight run ("working", or "reviewing" while the review gate holds
 * it — in-flight work finishes through both team gates); the director's "waiting for
 * prompts" (exempt from those gates); user pause; budget pause; a red main ("main red"); an
 * error or quiet-kill streak at its threshold ("failing"); sleep; then the scheduling
 * poll's recorded skip (`idle: …` / `deferred (…)`, from RunnerState.skipReason), else
 * "queued".
 * Pass `root` so an in-flight run expands into live detail (elapsed · turn · ctx · tool);
 * without it a working role shows plain "working". `live`, when given, is the frame's
 * precomputed tail (see workingDetail) — it skips the log read; without it an in-flight run
 * reads on its own. `budgetPaused` marks the team's daily cost budget as reached: idle
 * roles show `budget paused` instead of their sleep/queue state — that is why they are not
 * running. `userPaused` marks an operator pause (`tumwater pause` marker present): idle
 * roles show `paused`, checked before the budget gate because user intent is more specific
 * than spend state — while both hold, "paused" tells the operator what to do (`resume`).
 * `merge`, when given for this role, is its change's record in the snapshot's in-flight
 * merge — build it with mergeForRole so the marker's role filter lives in one place. A
 * change the pipeline holds but is not working on reads `approved, awaiting merge`, with no
 * elapsed since nothing of its own is running: its verification approved it and it waits for the
 * merge slot. (A queued change whose verification is still parked for a permit has no record:
 * it reads
 * plainly queued.)
 * `mainCheck`, when given (roleRowCells passes the snapshot's), lets the main-red label
 * retire itself between runs: main's newest merge-scope check passing AFTER this role's red
 * run ended means main is green now — the role's `main_red` verdict is stale until its next
 * run, which sleep, a full slot pool, a pause, or a spent budget can defer for hours
 * (BUGS.md 2026-09-30), so the label falls through to the ordinary idle state and the
 * teamAlerts banner follows. A check that is newer but failed keeps the label (main is
 * genuinely red); so does one older than the red run or with no known pass at all — the
 * blockage stands until the role's own next run re-verdicts it.
 * Otherwise its elapsed is the CHANGE's own merge (its record's startedAt — from its verification's
 * start, never another change's), never the authoring run's,
 * and its stage scopes the cell to the phase the merge is actually in: `reviewing` carries
 * the reviewer run's live detail exactly as a reviewing run does (`merge 3m · reviewing ·
 * turn 2 · ctx 18.0k · bash npm test`), and `resolving` the conflict resolver's the same way;
 * `build-check`, `resolve-wait` and `merging` render just the stage (`merge 1m · build
 * check`) and never read the log — no reviewer or resolver is running then, and the log's
 * newest run is typically a finished one (the author's, a previous review) whose turns are
 * stale and whose silence would read as a false stall; a record with no stage (an older
 * writer mid-upgrade) keeps the bare elapsed label. */
export function onErrorStreak(s: Pick<RunnerState, "consecutiveErrors" | "lastResult" | "quietKillStreak">): boolean {
  // An error streak at or past the warning threshold (run-apply.ts's ERROR_STREAK_WARN), or
  // a quiet-kill streak at the give-up threshold (BUGS.md 2026-09-18): the exact condition
  // that makes rolePhase read "failing", split out so the team alert (team-alert-status.ts) can
  // key its red "failing run after run" banner on the streak rather than on the rendered
  // phase — an in-flight run hides the streak behind a `working`/`merge` label (rolePhase
  // ranks running work above failing), but the alert must stay up while the role's next
  // run is in flight and clear only when the streak resets (BUGS.md 2026-10-14).
  return (
    errorStreakAtWarn(s) ||
    (s.lastResult === "quiet_killed" && (s.quietKillStreak ?? 0) >= QUIET_KILL_RESUME_LIMIT)
  );
}

export function rolePhase(
  s: RunnerState,
  orchestratorRunning: boolean,
  root?: string,
  budgetPaused = false,
  live?: LiveProgress | null,
  userPaused = false,
  merge?: MergeCell | null,
  mainCheck?: StatusSnapshot["mainCheck"],
  capPaused = false,
  quietHold?: string,
  diskHeld = false,
  bootstrapHeld = false,
  maintenanceQuotaHold?: string,
  permits?: PermitSnapshot,
  pausedUntilMs?: number,
): string {
  if (!orchestratorRunning) return "stopped";
  // Merge queue 4/5 — the marker-driven merge label: only a role whose change record was
  // passed gets it (callers derive it via mergeForRole), and a stopped harness never
  // shows it — a dead team's marker is stale by definition.
  if (merge) {
    if (merge.status === "approved") return "approved, waiting to merge";
    const head = merge.startedAt === undefined ? "merging" : `merging ${duration(Date.now() - merge.startedAt)}`;
    if (!merge.stage) return head;
    const base = `${head} · ${MERGE_STAGE_LABELS[merge.stage]}`;
    const staged = merge.stageSince === undefined ? base : `${base} ${duration(Date.now() - merge.stageSince)}`;
    if (merge.stage !== "reviewing" && merge.stage !== "resolving") return staged;
    // The reviewer writes the role's own log from its leased pooled slot, and the conflict
    // resolver from the merge worktree, both as gate runs (runner-pi.ts): the GATE accumulator,
    // read here rather than taken from `live` — the merge role's run has ended, so the
    // frame's per-running-role tail is not this run's (callers pass null for it). Each run's
    // `tumwater_run` marker resets that accumulator, so neither shows the other's counts.
    return inFlightDetail(staged, root ? readLiveProgress(root, s.role, "gate") : null);
  }
  if (s.running) {
    // A parked waiter is reserved against double-scheduling but holds no maxConcurrent permit
    // and runs no pi yet: render its true state and keep it OUT of the active set (isActivePhase)
    // so the operator can count active rows against the cap — a merge visibly counts, a
    // parked waiter visibly does not (BUGS.md 2026-09-24).
    if (s.parkedSince) {
      const parkedTime = duration(Date.now() - s.parkedSince);
      // The parked waiter's provider key, named only while that key is the binding limit in
      // the published permit snapshot (plans/provider-concurrency.md §8): the key is at its
      // cap, so THIS waiter is queued on its provider, not on the team total — `awaiting
      // omlx slot` tells the operator exactly which cap is full. A role parked on the total
      // (no key, or an uncapped one) reads today's `awaiting slot` as before.
      if (
        s.parkedOn !== undefined &&
        permits !== undefined &&
        isBindingLimit(permits, s.parkedOn)
      ) {
        return `waiting for ${s.parkedOn} ${parkedTime}`;
      }
      return `waiting to start ${parkedTime}`;
    }
    // The director bypasses maxConcurrent (`usesSlot` is false for it), so its in-flight run
    // is a state of its own: a distinct label that `isActivePhase`'s cap-mirroring set
    // excludes while still carrying the live detail, so its work stays visible without
    // counting as a permit holder (BUGS.md 2026-10-06). The bare label matches the working
    // branch's no-root shape.
    if (s.role === DIRECTOR_ROLE) {
      return root ? inFlightDetail(inFlightLabel(s, "director working"), runProgress(root, s, live)) : "director working";
    }
    // The run's work is committed and under adversarial review: the raw log tail now
    // describes the reviewer run — show its live progress with a "reviewing" label. The
    // reviewer's run writes the same role log as the author's (each `session` event names
    // its worktree), so read the GATE accumulator here — the author one still holds the
    // finished authoring run (BUGS.md 2026-09-22).
    if (s.phase === "review") {
      const p = root ? runProgress(root, s, live, "gate") : null;
      return inFlightDetail(inFlightLabel(s, "reviewing"), p);
    }
    // In-flight runs finish even while the budget is paused — only NEW runs are blocked,
    // so a running role keeps its live detail.
    return root ? workingDetail(root, s, live) : "working";
  }
  if (s.role === DIRECTOR_ROLE) return "ready for messages"; // exempt from both gates
  if (userPaused) {
    // A timed per-role pause (`pause --role <id> --for`): the marker's `until` gives the
    // operator a countdown, mirroring the team header badge and the GUI role-list's
    // `· resumes in <s>` — an indefinite per-role pause or a team-wide pause (deadline
    // absent) keeps today's bare `paused`, so the surfaces cannot drift.
    if (pausedUntilMs !== undefined && pausedUntilMs > Date.now()) {
      return `paused · resumes in ${humanUntil(pausedUntilMs, Date.now())}`;
    }
    // An absent deadline (indefinite per-role pause, team-wide pause) or an expired one
    // (the marker team-state already reads as unpaused) keeps today's bare `paused` — never
    // a stale `resumes in 0s`.
    return "paused";
  }
  // The role's OWN daily cap: the more specific spend
  // state, so it names itself ahead of the team's budget pause — the ladder's existing
  // "user intent is more specific than spend state" argument extended one level down.
  if (capPaused) return "waiting: daily cap spent";
  // The role's OWN quiet-hours window (PLANS.md, quietHoursPerRole): the team gate's own
  // wording — `quiet until <end>` — scoped to the one role the operator scheduled. Shown
  // after the cap and before the team's budget pause: the role's own schedule is more
  // specific than either.
  if (quietHold) return `quiet until ${quietWindowEnd(quietHold)}`;
  if (budgetPaused) return "waiting: budget spent";
  // The disk floor (plans/disk-floor.md, part 4/4): the team starts no new work below the
  // floor, so an idle role reads "disk hold" — the team-wide gate's own wording, ranked with
  // the budget pause (ROLE_RANK_RULES). In-flight runs keep their live detail above, exactly
  // as under every autonomous gate.
  if (diskHeld) return "waiting: low disk";
  // New-project bootstrap (plans/work-ratio.md, part 2/2): the idle role is held until enough
  // plans are Done. The literal label names the reason, like the gates above.
  if (bootstrapHeld) return "waiting: bootstrap";
  // The maintenance allowance's own hold (plans/work-ratio.md, part 1b/4): the label carries the
  // figures so the operator sees how far over the window is; the string is preformatted by the
  // snapshot's holder, like roleQuietPaused's window.
  if (maintenanceQuotaHold) return maintenanceQuotaHold;
  // Main's own suite is known red at this role's last run: main_red is the last completed
  // outcome. Shown before sleep/queue
  // because it explains why the role keeps waking and merge nothing; self-correcting, since
  // each run re-records main_red while red and a green wake overwrites lastResult.
  // Except a green wake that queues a change: `queued` is in flight, not a completed result,
  // so it leaves the main_red pair in place until its merge resolves (run-apply.ts's
  // applyRunOutcome) — its stashed summary is the tell that the role's latest run saw
  // main green, so "main red" would be stale.
  // Except too when main's newest merge-scope check PASSED after this role's red run ended:
  // the team-level verdict is fresher than the role's own, so the label is stale until the
  // role's next run — which can be hours away (BUGS.md 2026-09-30). A check older than the
  // red run, a failed or skipped one, or an unknown run end all keep the label.
  if (heldByMainRed(s, mainCheck)) return "main's check is failing";
  // An error streak at or past the warning threshold (run-apply.ts's ERROR_STREAK_WARN): the
  // role is retrying the same failure on the error ladder, and the operator must see
  // "failing" — not a sleepy label — while it is stuck (BUGS.md 2026-09-15). The streak
  // alone is the tell, not `lastResult`: a run whose leftover recovery failed keeps the
  // pin while its own authoring run may end `no_change`/`queued`, so a dead reviewer
  // backend must still read "failing" (BUGS.md 2026-09-21). Self-clearing: the first
  // healthy run resets the streak, and each retry re-arms it while the environment stays
  // broken.
  if (onErrorStreak(s)) return "failing";
  // The resting state cell (sleeping / idle / deferred / queued): it is the only label that
  // names what a role has been RETURNING, so the consecutive no-change streak rides on it
  // (run-apply.ts applyRunOutcome's noChangeStreak, persisted in RunnerState). A role that
  // keeps waking and returning nothing to do reads " · no change ×N" instead of an ordinary
  // idle — the harness premise's silent no-op failure mode, otherwise indistinguishable from a
  // healthy idle role. Observational only: a legitimately idle maintenance role with an empty
  // backlog can hold a long streak and that is expected, so it never warns (unlike
  // consecutiveErrors/quietKillStreak). N=1 and an absent field read 0 and render the label
  // byte-identically; the error/quiet-kill/merge/paused cells return earlier and never carry
  // the suffix. `noChangeStreak` is on the state accumulator, so its type is on the full
  // RunnerState.
  let cell: string;
  if (s.nextRunAt > Date.now()) {
    // The role is sleeping *now* until nextRunAt: show the remaining sleep duration
    // ("for 30m"), not a future start ("in 30m"). Floor at 1s so a sub-second remainder
    // never renders as "sleeping (for now)".
    const remain = Math.max(1, secondsUntil(s.nextRunAt, Date.now()));
    cell = `sleeping (for ${humanSeconds(remain)})`;
  } else {
    switch (s.skipReason) {
      case "no-free-entry":
        cell = `idle: no unclaimed ${baseRoleOf(s.role) === "bugfix" ? "bugs" : "plans"}`;
        break;
      case "claim-hold":
        cell = `idle: another ${baseRoleOf(s.role)} instance is working on it`;
        break;
      case "deferred-backlog":
        cell = "deferred (backlog open)";
        break;
      case "deferred-no-work":
        cell = "deferred (no new work)";
        break;
      case "deferred-plans-full":
        cell = "deferred (plans full)";
        break;
      case "instances-full":
        cell = `idle: every ${baseRoleOf(s.role)} instance is busy`;
        break;
      case "maintenance-due-cap":
        cell = "waiting: maintenance allowance spent this poll";
        break;
      case "yield-gap":
        cell = `idle: waiting out its yield gap ×${yieldMultiplierFor(s)}`;
        break;
      default:
        cell = "due";
    }
  }
  // Two or more consecutive runs earn the suffix (N=1 is a single run — ordinary, not yet
  // a pattern). A cut-off run is itself a `no_change`, so noChangeStreak counts a
  // context-ceiling episode too — but the plain suffix would mislabel a window-burning
  // episode as a benign idle one, so when the cut-off streak reads 2+ it wins: it names the
  // costly cause (operator should split the task or raise the model's context window before
  // the give-up). Observational only, like the no-change suffix — it never warns from here
  // (the once-per-episode crossing warning comes from run-finalize.ts).
  const cutOff = s.cutOffStreak ?? 0;
  if (cutOff >= 2) cell += ` · cut off ×${cutOff}`;
  else {
    const streak = s.noChangeStreak ?? 0;
    if (streak >= 2) cell += ` · no change ×${streak}`;
  }
  return cell;
}

/** One rendered role-table row's sort key: the role name, its rendered phase label
 * (rolePhase), and its last run end. Both the TUI/status table and the GUI page's browser
 * copy carry these three fields. */
interface RoleSortRow {
  role: string;
  phase: string;
  lastRunEndedAt?: number | null;
}

/** One role row's display derivation — the block both observer surfaces re-ran per role
 * (renderStatus's withMetrics map and statusPayload's roles map): a single live tail read
 * (the running-and-not-parked gate, read at the phase's progressKind), the token metrics
 * over that tail, and the rendered phase string. The phase's snapshot-level gates are
 * derived here too — budget paused (only `paused` stops a role; `fallback` keeps it running
 * on the free model, which the header badge names), the team pause plus the per-role one
 * (one `paused` flag to rolePhase covers both), and the role's merge cell (merge queue
 * 4/5) — so the two dashboards' per-role cells cannot drift apart. */
export function roleRowCells(
  snap: StatusSnapshot,
  root: string,
  s: RunnerState,
): { live: LiveProgress | null; generated: number; peakCtx: number; phase: string } {
  const live = s.running && !s.parkedSince
    ? runProgress(root, s, undefined, progressKind(s))
    : null;
  const m = displayTokenMetrics(root, s, live);
  const phase = rolePhase(
    s,
    snap.running,
    root,
    // The per-tier budget pause (part 5c/8): a role whose model tier resolved to no usable
    // free pair reads `budget paused` — per role, not the team-wide verdict, so a demoted
    // strong pair no longer paints the whole team paused while small and default keep
    // running on their own pairs.
    snap.budgetPausedRoles.includes(s.role),
    live,
    // The per-role pause reads the same `paused` cell as the team pause: one flag to
    // rolePhase covers both gates (status-model has no per-role branch of its own).
    snap.paused || snap.pausedRunners.includes(s.role),
    mergeForRole(snap.mergeQueue, s.role),
    // The snapshot's newest merge-scope check lets a stale main-red phase retire itself
    // between runs (BUGS.md 2026-09-30) — the banner (teamAlerts) reads this same phase.
    snap.mainCheck,
    // The per-role cap's verdict, computed once per poll in the snapshot (status/status-data.ts
    // roleCapPaused): an idle role over its own cap reads `cap paused` on every surface.
    snap.capPaused.includes(s.role),
    // The per-role quiet window's verdict (status/status-data.ts roleQuietPaused): an idle role
    // inside its own window reads `quiet until <end>` — the team badge's wording, scoped.
    snap.roleQuietPaused?.[s.role],
    // The disk floor's verdict (status/status-data.ts disk): an idle role while the hold is on
    // reads `disk hold` — the team-wide gate, ranked with the budget pause.
    snap.disk?.held === true,
    // The new-project bootstrap's verdict (status/status-data.ts bootstrapHeld): an idle role
    // it holds reads `held: bootstrap` — the team gate's own wording.
    snap.bootstrapHeld.includes(s.role),
    // The maintenance allowance's verdict (status/status-data.ts maintenanceQuota): an idle role
    // it holds reads `held: maintenance quota <used>/<allowance>` — the team gate's figures.
    snap.maintenanceQuota.held.includes(s.role)
      ? `waiting: maintenance allowance used ${snap.maintenanceQuota.used}/${snap.maintenanceQuota.allowance}`
      : undefined,
    // The permit pool's live state (plans/provider-concurrency.md §8): names the parked
    // waiter's provider key in `awaiting <key> slot` when that key is at its cap.
    snap.permits,
    // A timed per-role pause's deadline — only when the role itself is individually paused
    // (in `pausedRoles`) and not under a team-wide pause, matching the GUI's phaseDetail
    // guard, so the team pause (whose countdown rides the header badge) never double-appends.
    snap.paused || !snap.pausedRunners.includes(s.role) ? undefined : snap.pausedRolesUntil,
  );
  return { live, generated: m.generated, peakCtx: m.peakCtx, phase };
}

/** The phase prefixes that make a role a permit holder — working, reviewing, merge. The
 * browser dashboard (gui-client.ts) interpolates this list into its isActivePhase, exactly as
 * gui-client-model.ts interpolates ROLE_RANK_RULES, so the two dashboards cannot disagree
 * about which phases are in flight. */
export const ACTIVE_PHASE_PREFIXES = ["working", "reviewing", "merging"] as const;

/** Whether `key` is the binding limit in the published permit snapshot: its cap is set and
 * its in-use already meets or exceeds it, so the pool is granting nothing more on that key and
 * a waiter carrying it is queued on the key, not on the team total. A key without a cap in
 * the snapshot (uncapped) is never binding. One home for the rule, shared by status-model's
 * `awaiting <key> slot` and the GUI chip's provider detail. */
function isBindingLimit(permits: PermitSnapshot, key: string): boolean {
  const entry = permits.byKey[key];
  return entry?.limit !== undefined && entry.inUse >= entry.limit;
}

/** Is this phase one of the PERMIT-HOLDER in-flight states — the rows an operator counts
 * against maxConcurrent? The three labels come from rolePhase: `working …`, `reviewing …`,
 * and the marker-driven `merge …` (merge queue 4/5) — a approved change waiting for the merge
 * slot (`approved, awaiting merge`) runs nothing, so it is not in flight. The running director's
 * `director working …` label is deliberately outside the set: the director never calls
 * `semaphore.acquire`, so the cap-mirroring rows are exactly the permit holders (BUGS.md
 * 2026-10-06). Named once so the two rendered tables and their lockstep test share the rule
 * instead of restating the prefixes — and statusPayload reuses it for each role row's
 * `inFlight` flag, the cap count every surface reads. The row ACTIONS (abort vs wake) instead
 * key off the running set, which also includes the director: the GUI derives it from the
 * rendered phase (gui-client-roles.ts/drawer's phaseInfo.live). */
export function isActivePhase(phase: string): boolean {
  return ACTIVE_PHASE_PREFIXES.some((p) => phase.startsWith(p));
}

/** A role's rank in the rendered tables, from its phase label (rolePhase): -1 a RUNNING
 * DIRECTOR — live work of its own, outside the maxConcurrent cap it bypasses, so it groups
 * apart and never inflates the permit-holder count (BUGS.md 2026-10-06); 0 live work —
 * working, reviewing, merge (isActivePhase); 1 work waiting in the pipeline — a approved change
 * awaiting the merge slot, or a run parked awaiting a permit; 2 needs attention — failing, or
 * its last run read main red; 3 paused — by the operator, by the budget, or by the role's own
 * per-role cap; 4 everything else (idle: sleeping, queued, the director waiting for prompts, a
 * stopped team). The dashboard groups its role table by these ranks; the TUI/status table
 * orders by them.
 *
 * The rank → phase mapping is ROLE_RANK_RULES, one home for the phase literals so the
 * dashboard's browser twin cannot drift; a rule matches by `active` (isActivePhase), `phases`
 * (exact equality), or `prefixes` (startsWith), and the first match wins. */
export const ROLE_RANK_RULES: ReadonlyArray<{
  rank: number;
  active?: boolean;
  phases?: readonly string[];
  prefixes?: readonly string[];
}> = [
  { rank: -1, prefixes: ["director working"] },
  { rank: 0, active: true },
  { rank: 1, prefixes: ["approved", "waiting to start", "waiting for "] },
  { rank: 2, phases: ["failing", "main's check is failing"] },
  { rank: 3, phases: ["paused"] },
  { rank: 3, prefixes: ["paused", "waiting:"] },
];

/** The rank ROLE_RANK_RULES assigns `phase`: -1 for director working, 4 for idle, otherwise the
 * first matching rule's rank. */
export function roleRank(phase: string): number {
  for (const rule of ROLE_RANK_RULES) {
    if (
      rule.active
        ? isActivePhase(phase)
        : rule.phases?.includes(phase) || rule.prefixes?.some((p) => phase.startsWith(p))
    )
      return rule.rank;
  }
  return 4;
}

/** The role tables' shared row order: by roleRank (live work, then work waiting in the
 * pipeline, then roles that need attention, then paused, then idle); within a rank by last run
 * most-recent-first, a row for a role that has never run (null) after any timestamp, ties
 * broken by role ascending. This is the TUI/status table's comparator; the GUI page's browser copy
 * (gui-client-model.ts) cannot import TS, so test/gui.test.ts cross-checks the two over the
 * same fixtures to keep them in lockstep. /api/status and `status --json` keep
 * their payload (config) order — only the rendered tables sort. */
export function sortRolesByState<T extends RoleSortRow>(roles: readonly T[]): T[] {
  return roles.slice().sort((a, b) => {
    const ra = roleRank(a.phase);
    const rb = roleRank(b.phase);
    if (ra !== rb) return ra - rb;
    const ta = a.lastRunEndedAt ?? 0;
    const tb = b.lastRunEndedAt ?? 0;
    if (ta !== tb) return tb - ta;
    return a.role.localeCompare(b.role);
  });
}

/** Token metrics for display. gen / peak ctx are per-run windows — runner-run.ts resets them at
 * run start, so the persisted values hold only what the current (mid-flight) or last
 * completed run used, never lifetime totals. While a run is in flight the on-disk values
 * are 0 and the live log tail supplies exactly this run's output; idle roles show their
 * last completed run as-is. Only running roles combine persisted + live: an idle role's
 * log tail describes its last COMPLETED run, whose tokens ARE the persisted values
 * (combining would double-count), while a stale `running` flag after a crash is still
 * correct to combine because that unfinished run's counters were reset to 0 at run start
 * and never re-saved. `live`, when given, is the frame's precomputed tail — it skips the log
 * read; without it a running role reads on its own (standalone callers). Module-private:
 * roleRowCells is the only reader now that both dashboards derive their rows through it. */
function displayTokenMetrics(
  root: string,
  s: RunnerState,
  live?: LiveProgress | null,
): { generated: number; peakCtx: number } {
  const p = s.running && !s.parkedSince
    ? runProgress(root, s, live)
    : null;
  return {
    generated: s.generatedTokens + (p?.outputTokens ?? 0),
    peakCtx: Math.max(s.peakContextTokens, p?.peakContextTokens ?? 0),
  };
}

