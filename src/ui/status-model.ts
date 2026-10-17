// vocabulary: plain
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { baseRoleOf } from "../roles/loop-ids.js";
import type { LoopState } from "../loop/loop-state.js";
import type { PermitSnapshot } from "../team/orchestrator-info.js";
import type { StatusSnapshot } from "../status/status-data.js";
import { heldByMainRed } from "../status/status-polls.js";
import { ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT } from "../tick/tick-apply.js";
import { readLiveProgress, type LiveProgress } from "./progress-data.js";
import { quietWindowEnd } from "../scheduling/quiet-hours.js";
import { humanSeconds, secondsUntil } from "../text/datetime.js";
import {
  duration,
  inFlightDetail,
  inFlightLabel,
  progressKind,
  tickProgress,
  workingDetail,
} from "./tick-progress-model.js";
import { landingChanges, LANDING_STAGE_LABELS, type LandingChange } from "../merge/merge-slot.js";

/** The status DISPLAY MODEL: the loop's cycle position (the phase ladder), its landing cell,
 * and its per-loop row derivation (the header badges live next door in badges.ts, the
 * in-flight tick's live progress detail in tick-progress-model.ts) — derived from the status
 * data (status/status-data.ts) and shared by BOTH observer surfaces: the terminal table
 * (status-render.ts's renderStatus/stateCell) and the JSON/GUI payload (status-payload.ts).
 * Kept apart from status-render.ts so the GUI payload depends on the shared model, not on the
 * TUI table module — "what to show" (here) is separate from "how a terminal lays it out"
 * (status-render.ts). Depends on status/status-data.ts one way: deriving reads the snapshot
 * and never collects team state itself (live tick detail is display-only). */

type LandingCell = Pick<LandingChange, "status" | "startedAt" | "stage" | "stageSince">;

/** The snapshot's in-flight landing record (merge queue 4/5) filtered to one role: this
 * role's change record while the pipeline holds it — vetting or merging it (`landing`), or
 * keeping it for the merge slot (`vetted`) — and null otherwise, including once the merge is
 * `done` with it (a change that reached its outcome must not keep a live label while the rest of
 * its stack lands — BUGS.md 2026-09-23). An older generation's one-change marker reads as one
 * `landing` record (landingChanges). The single home of the "is this role landing" filter —
 * every phase call site derives its `landing` argument through this so the filtering cannot
 * drift between them. */
export function landingForRole(landQueue: StatusSnapshot["landQueue"], role: string): LandingCell | null {
  if (!landQueue.inFlight) return null;
  const change = landingChanges(landQueue.inFlight).find((c) => c.role === role);
  return change && change.status !== "done"
    ? { status: change.status, startedAt: change.startedAt, stage: change.stage, stageSince: change.stageSince }
    : null;
}

/** The work text a row shows in place of live progress while it is idle or landing
 * (plans/parallel-work-instances.md "Observability", part 6/7): the claim's heading when the
 * instance holds one. Returns null otherwise, so the state cell keeps its plain phase — an
 * idle instance's phase label (`idle: no unclaimed plans`) carries its own reason. */
export function idleClaimText(s: { claim?: LoopState["claim"]; role: string }, _phase: string): string | null {
  return s.claim ? s.claim.title : null;
}

/** The loop's state label — the one precedence ladder shared by the status table and both
 * dashboards (renderStatus, statusPayload). First match wins: a stopped harness; an in-flight
 * landing (the role's tick already ended "queued" while its change lands, so the marker
 * supplies the label); a running tick ("working", or "reviewing" while the review gate holds
 * it — in-flight work finishes through both team gates); the director's "waiting for
 * prompts" (exempt from those gates); user pause; budget pause; a red main ("main red"); an
 * error or quiet-kill streak at its threshold ("failing"); sleep; then the scheduling
 * poll's recorded skip (`idle: …` / `deferred (…)`, from LoopState.skipReason), else
 * "queued".
 * Pass `root` so an in-flight tick expands into live detail (elapsed · turn · ctx · tool);
 * without it a working loop shows plain "working". `live`, when given, is the frame's
 * precomputed tail (see workingDetail) — it skips the log read; without it an in-flight tick
 * reads on its own. `budgetPaused` marks the team's daily cost budget as reached: idle role
 * loops show `budget paused` instead of their sleep/queue state — that is why they are not
 * ticking. `userPaused` marks an operator pause (`tumwater pause` marker present): idle role
 * loops show `paused`, checked before the budget gate because user intent is more specific
 * than spend state — while both hold, "paused" tells the operator what to do (`resume`).
 * `landing`, when given for this role, is its change's record in the snapshot's in-flight
 * landing — build it with landingForRole so the marker's role filter lives in one place. A
 * change the pipeline holds but is not working on reads `vetted, awaiting merge`, with no
 * elapsed since nothing of its own is running: its vet approved it and it waits for the merge
 * slot. (A queued change whose vet is still parked for a permit has no record: it reads
 * plainly queued.)
 * `mainCheck`, when given (loopRowCells passes the snapshot's), lets the main-red label
 * retire itself between ticks: main's newest merge-scope check passing AFTER this loop's red
 * tick ended means main is green now — the loop's `main_red` verdict is stale until its next
 * tick, which sleep, a full slot pool, a pause, or a spent budget can defer for hours
 * (BUGS.md 2026-09-30), so the label falls through to the ordinary idle state and the
 * teamAlerts banner follows. A check that is newer but failed keeps the label (main is
 * genuinely red); so does one older than the red tick or with no known pass at all — the
 * blockage stands until the loop's own next tick re-verdicts it.
 * Otherwise its elapsed is the CHANGE's own landing (its record's startedAt — from its vet's
 * start, never another change's), never the authoring tick's,
 * and its stage scopes the cell to the phase the landing is actually in: `reviewing` carries
 * the reviewer run's live detail exactly as a reviewing tick does (`landing 3m · reviewing ·
 * turn 2 · ctx 18.0k · bash npm test`), and `resolving` the conflict resolver's the same way;
 * `build-check`, `resolve-wait` and `merging` render just the stage (`landing 1m · build
 * check`) and never read the log — no reviewer or resolver is running then, and the log's
 * newest run is typically a finished one (the author's, a previous review) whose turns are
 * stale and whose silence would read as a false stall; a record with no stage (an older
 * writer mid-upgrade) keeps the bare elapsed label. */
export function onErrorStreak(s: Pick<LoopState, "consecutiveErrors" | "lastResult" | "quietKillStreak">): boolean {
  // An error streak at or past the warning threshold (tick-apply.ts's ERROR_STREAK_WARN), or
  // a quiet-kill streak at the give-up threshold (BUGS.md 2026-09-18): the exact condition
  // that makes loopPhase read "failing", split out so the team alert (team-alerts.ts) can
  // key its red "failing tick after tick" banner on the streak rather than on the rendered
  // phase — an in-flight tick hides the streak behind a `working`/`landing` label (loopPhase
  // ranks running work above failing), but the alert must stay up while the loop's next tick
  // runs and clear only when the streak resets (BUGS.md 2026-10-14).
  return (
    (s.consecutiveErrors ?? 0) >= ERROR_STREAK_WARN ||
    (s.lastResult === "quiet_killed" && (s.quietKillStreak ?? 0) >= QUIET_KILL_RESUME_LIMIT)
  );
}

export function loopPhase(
  s: LoopState,
  orchestratorRunning: boolean,
  root?: string,
  budgetPaused = false,
  live?: LiveProgress | null,
  userPaused = false,
  landing?: LandingCell | null,
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
  // Merge queue 4/5 — the marker-driven landing label: only a role whose change record was
  // passed gets it (callers derive it via landingForRole), and a stopped harness never
  // shows it — a dead team's marker is stale by definition.
  if (landing) {
    if (landing.status === "approved") return "approved, waiting to merge";
    const head = landing.startedAt === undefined ? "merging" : `merging ${duration(Date.now() - landing.startedAt)}`;
    if (!landing.stage) return head;
    const base = `${head} · ${LANDING_STAGE_LABELS[landing.stage]}`;
    const staged = landing.stageSince === undefined ? base : `${base} ${duration(Date.now() - landing.stageSince)}`;
    if (landing.stage !== "reviewing" && landing.stage !== "resolving") return staged;
    // The reviewer writes the role's own log from its leased pooled slot, and the conflict
    // resolver from the merge worktree, both as gate runs (loop-pi.ts): the GATE accumulator,
    // read here rather than taken from `live` — the landing role's tick has ended, so the
    // frame's per-running-loop tail is not this run's (callers pass null for it). Each run's
    // `tumwater_run` marker resets that accumulator, so neither shows the other's counts.
    return inFlightDetail(staged, root ? readLiveProgress(root, s.role, "gate") : null);
  }
  if (s.running) {
    // A parked waiter is reserved against double-scheduling but holds no maxConcurrent permit
    // and runs no pi yet: render its true state and keep it OUT of the active set (isActivePhase)
    // so the operator can count active rows against the cap — a landing visibly counts, a
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
    // The director bypasses maxConcurrent (`usesSlot` is false for it), so its in-flight tick
    // is a state of its own: a distinct label that `isActivePhase`'s cap-mirroring set
    // excludes while still carrying the live detail, so its work stays visible without
    // counting as a permit holder (BUGS.md 2026-10-06). The bare label matches the working
    // branch's no-root shape.
    if (s.role === DIRECTOR_ROLE) {
      return root ? inFlightDetail(inFlightLabel(s, "director working"), tickProgress(root, s, live)) : "director working";
    }
    // The tick's work is committed and under adversarial review: the raw log tail now
    // describes the reviewer run — show its live progress with a "reviewing" label. The
    // reviewer's run writes the same role log as the author's (each `session` event names
    // its worktree), so read the GATE accumulator here — the author one still holds the
    // finished authoring run (BUGS.md 2026-09-22).
    if (s.phase === "review") {
      const p = root ? tickProgress(root, s, live, "gate") : null;
      return inFlightDetail(inFlightLabel(s, "reviewing"), p);
    }
    // In-flight ticks finish even while the budget is paused — only NEW ticks are blocked,
    // so a running loop keeps its live detail.
    return root ? workingDetail(root, s, live) : "working";
  }
  if (s.role === DIRECTOR_ROLE) return "ready for messages"; // exempt from both gates
  if (userPaused) {
    // A timed per-role pause (`pause --role <id> --for`): the marker's `until` gives the
    // operator a countdown, mirroring the team header badge and the GUI loop-list's
    // `· resumes in <s>` — an indefinite per-role pause or a team-wide pause (deadline
    // absent) keeps today's bare `paused`, so the surfaces cannot drift.
    if (pausedUntilMs !== undefined && pausedUntilMs > Date.now()) {
      return `paused · resumes in ${humanSeconds(Math.max(0, Math.round((pausedUntilMs - Date.now()) / 1000)))}`;
    }
    // An absent deadline (indefinite per-role pause, team-wide pause) or an expired one
    // (the marker team-state already reads as unpaused) keeps today's bare `paused` — never
    // a stale `resumes in 0s`.
    return "paused";
  }
  // The loop's OWN daily cap: the more specific spend
  // state, so it names itself ahead of the team's budget pause — the ladder's existing
  // "user intent is more specific than spend state" argument extended one level down.
  if (capPaused) return "waiting: daily cap spent";
  // The loop's OWN quiet-hours window (PLANS.md, quietHoursPerRole): the team gate's own
  // wording — `quiet until <end>` — scoped to the one loop the operator scheduled. Shown
  // after the cap and before the team's budget pause: the loop's own schedule is more
  // specific than either.
  if (quietHold) return `quiet until ${quietWindowEnd(quietHold)}`;
  if (budgetPaused) return "waiting: budget spent";
  // The disk floor (plans/disk-floor.md, part 4/4): the team starts no new work below the
  // floor, so an idle loop reads "disk hold" — the team-wide gate's own wording, ranked with
  // the budget pause (LOOP_RANK_RULES). In-flight ticks keep their live detail above, exactly
  // as under every autonomous gate.
  if (diskHeld) return "waiting: low disk";
  // New-project bootstrap (plans/work-ratio.md, part 2/2): the idle loop is held until enough
  // plans are Done. The literal label names the reason, like the gates above.
  if (bootstrapHeld) return "waiting: bootstrap";
  // The maintenance allowance's own hold (plans/work-ratio.md, part 1b/4): the label carries the
  // figures so the operator sees how far over the window is; the string is preformatted by the
  // snapshot's holder, like roleQuietPaused's window.
  if (maintenanceQuotaHold) return maintenanceQuotaHold;
  // Main's own suite is known red at this loop's last tick: code-producing loops are blocked
  // from authoring until main is green (the red-main baseline check). Shown before sleep/queue
  // because it explains why the loop keeps waking and landing nothing; self-correcting, since
  // each blocked tick re-records main_red while red and a green wake overwrites lastResult.
  // Except a green wake that queues a change: `queued` is in flight, not a completed result,
  // so it leaves the main_red pair in place until its landing resolves (tick-apply.ts's
  // applyTickOutcome) — its stashed summary is the tell that the loop's latest tick got past
  // the red-main gate, so main was green then and "main red" would be stale.
  // Except too when main's newest merge-scope check PASSED after this loop's red tick ended:
  // the team-level verdict is fresher than the loop's own, so the label is stale until the
  // loop's next tick — which can be hours away (BUGS.md 2026-09-30). A check older than the
  // red tick, a failed or skipped one, or an unknown tick end all keep the label.
  if (heldByMainRed(s, mainCheck)) return "main's check is failing";
  // An error streak at or past the warning threshold (tick-apply.ts's ERROR_STREAK_WARN): the
  // loop is retrying the same failure on the error ladder, and the operator must see
  // "failing" — not a sleepy label — while it is stuck (BUGS.md 2026-09-15). The streak
  // alone is the tell, not `lastResult`: a tick whose leftover recovery failed keeps the
  // pin while its own authoring run may end `no_change`/`queued`, so a dead reviewer
  // backend must still read "failing" (BUGS.md 2026-09-21). Self-clearing: the first
  // healthy tick resets the streak, and each retry re-arms it while the environment stays
  // broken.
  if (onErrorStreak(s)) return "failing";
  // The resting state cell (sleeping / idle / deferred / queued): it is the only label that
  // names what a loop has been RETURNING, so the consecutive no-change streak rides on it
  // (tick-apply.ts applyTickOutcome's noChangeStreak, persisted in LoopState). A loop that
  // keeps waking and returning nothing to do reads " · no change ×N" instead of an ordinary
  // idle — the harness premise's silent no-op failure mode, otherwise indistinguishable from a
  // healthy idle loop. Observational only: a legitimately idle maintenance loop with an empty
  // backlog can hold a long streak and that is expected, so it never warns (unlike
  // consecutiveErrors/quietKillStreak). N=1 and an absent field read 0 and render the label
  // byte-identically; the error/quiet-kill/landing/paused cells return earlier and never carry
  // the suffix. `noChangeStreak` is on the state accumulator, so its type is on the full
  // LoopState.
  let cell: string;
  if (s.nextRunAt > Date.now()) {
    // The loop is sleeping *now* until nextRunAt: show the remaining sleep duration
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
      default:
        cell = "due";
    }
  }
  // Two or more consecutive no-change ticks earn the suffix (N=1 is a single quiet tick —
  // ordinary, not yet a pattern).
  const streak = s.noChangeStreak ?? 0;
  if (streak >= 2) cell += ` · no change ×${streak}`;
  return cell;
}

/** One rendered loop-table row's sort key: the role name, its rendered phase label
 * (loopPhase), and its last tick end. Both the TUI/status table and the GUI page's browser
 * copy carry these three fields. */
interface LoopSortRow {
  role: string;
  phase: string;
  lastRunEndedAt?: number | null;
}

/** One loop row's display derivation — the block both observer surfaces re-ran per loop
 * (renderStatus's withMetrics map and statusPayload's loops map): a single live tail read
 * (the running-and-not-parked gate, read at the phase's progressKind), the token metrics
 * over that tail, and the rendered phase string. The phase's snapshot-level gates are
 * derived here too — budget paused (only `paused` stops a loop; `fallback` keeps it ticking
 * on the free model, which the header badge names), the team pause plus the per-role one
 * (one `paused` flag to loopPhase covers both), and the role's landing cell (merge queue
 * 4/5) — so the two dashboards' per-loop cells cannot drift apart. */
export function loopRowCells(
  snap: StatusSnapshot,
  root: string,
  s: LoopState,
): { live: LiveProgress | null; generated: number; peakCtx: number; phase: string } {
  const live = s.running && !s.parkedSince
    ? tickProgress(root, s, undefined, progressKind(s))
    : null;
  const m = displayTokenMetrics(root, s, live);
  const phase = loopPhase(
    s,
    snap.running,
    root,
    // The per-tier budget pause (part 5c/8): a loop whose model tier resolved to no usable
    // free pair reads `budget paused` — per role, not the team-wide verdict, so a demoted
    // strong pair no longer paints the whole team paused while small and default keep
    // ticking on their own pairs.
    snap.budgetPausedRoles.includes(s.role),
    live,
    // The per-role pause reads the same `paused` cell as the team pause: one flag to
    // loopPhase covers both gates (status-model has no per-role branch of its own).
    snap.paused || snap.pausedLoops.includes(s.role),
    landingForRole(snap.landQueue, s.role),
    // The snapshot's newest merge-scope check lets a stale main-red phase retire itself
    // between ticks (BUGS.md 2026-09-30) — the banner (teamAlerts) reads this same phase.
    snap.mainCheck,
    // The per-role cap's verdict, computed once per poll in the snapshot (status/status-data.ts
    // roleCapPaused): an idle loop over its own cap reads `cap paused` on every surface.
    snap.capPaused.includes(s.role),
    // The per-role quiet window's verdict (status/status-data.ts roleQuietPaused): an idle loop
    // inside its own window reads `quiet until <end>` — the team badge's wording, scoped.
    snap.roleQuietPaused?.[s.role],
    // The disk floor's verdict (status/status-data.ts disk): an idle loop while the hold is on
    // reads `disk hold` — the team-wide gate, ranked with the budget pause.
    snap.disk?.held === true,
    // The new-project bootstrap's verdict (status/status-data.ts bootstrapHeld): an idle loop
    // it holds reads `held: bootstrap` — the team gate's own wording.
    snap.bootstrapHeld.includes(s.role),
    // The maintenance allowance's verdict (status/status-data.ts maintenanceQuota): an idle loop
    // it holds reads `held: maintenance quota <used>/<allowance>` — the team gate's figures.
    snap.maintenanceQuota.held.includes(s.role)
      ? `waiting: maintenance allowance used ${snap.maintenanceQuota.used}/${snap.maintenanceQuota.allowance}`
      : undefined,
    // The permit pool's live state (plans/provider-concurrency.md §8): names the parked
    // waiter's provider key in `awaiting <key> slot` when that key is at its cap.
    snap.permits,
    // A timed per-role pause's deadline — only when the loop itself is individually paused
    // (in `pausedRoles`) and not under a team-wide pause, matching the GUI's phaseDetail
    // guard, so the team pause (whose countdown rides the header badge) never double-appends.
    snap.paused || !snap.pausedLoops.includes(s.role) ? undefined : snap.pausedRolesUntil,
  );
  return { live, generated: m.generated, peakCtx: m.peakCtx, phase };
}

/** The phase prefixes that make a loop a permit holder — working, reviewing, landing. The
 * browser dashboard (gui-client.ts) interpolates this list into its isActivePhase, exactly as
 * gui-client-model.ts interpolates LOOP_RANK_RULES, so the two dashboards cannot disagree
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
 * against maxConcurrent? The three labels come from loopPhase: `working …`, `reviewing …`,
 * and the marker-driven `landing …` (merge queue 4/5) — a vetted change waiting for the merge
 * slot (`vetted, awaiting merge`) runs nothing, so it is not in flight. The running director's
 * `director working …` label is deliberately outside the set: the director never calls
 * `semaphore.acquire`, so the cap-mirroring rows are exactly the permit holders (BUGS.md
 * 2026-10-06). Named once so the two rendered tables and their lockstep test share the rule
 * instead of restating the prefixes — and statusPayload reuses it for each loop row's
 * `inFlight` flag, the cap count every surface reads. The row ACTIONS (abort vs wake) instead
 * key off the running set, which also includes the director: the GUI derives it from the
 * rendered phase (gui-client-loops.ts/drawer's phaseInfo.live). */
export function isActivePhase(phase: string): boolean {
  return ACTIVE_PHASE_PREFIXES.some((p) => phase.startsWith(p));
}

/** A loop's rank in the rendered tables, from its phase label (loopPhase): -1 a RUNNING
 * DIRECTOR — live work of its own, outside the maxConcurrent cap it bypasses, so it groups
 * apart and never inflates the permit-holder count (BUGS.md 2026-10-06); 0 live work —
 * working, reviewing, landing (isActivePhase); 1 work waiting in the pipeline — a vetted change
 * awaiting the merge slot, or a tick parked awaiting a permit; 2 needs attention — failing, or
 * blocked by a red main; 3 paused — by the operator, by the budget, or by the loop's own
 * per-role cap; 4 everything else (idle: sleeping, queued, the director waiting for prompts, a
 * stopped team). The dashboard groups its loop table by these ranks; the TUI/status table
 * orders by them.
 *
 * The rank → phase mapping is LOOP_RANK_RULES, one home for the phase literals so the
 * dashboard's browser twin (gui-client-model.ts loopRank, which interpolates the list) cannot
 * drift; a rule matches by `active` (isActivePhase), `phases` (exact equality), or `prefixes`
 * (startsWith), and the first match wins. */
export const LOOP_RANK_RULES: ReadonlyArray<{
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

/** The rank LOOP_RANK_RULES assigns `phase`: -1 for director working, 4 for idle, otherwise the
 * first matching rule's rank. */
export function loopRank(phase: string): number {
  for (const rule of LOOP_RANK_RULES) {
    if (
      rule.active
        ? isActivePhase(phase)
        : rule.phases?.includes(phase) || rule.prefixes?.some((p) => phase.startsWith(p))
    )
      return rule.rank;
  }
  return 4;
}

/** The loop tables' shared row order: by loopRank (live work, then work waiting in the
 * pipeline, then loops that need attention, then paused, then idle); within a rank by last tick
 * most-recent-first, a never-ticked (null) row after any timestamp, ties broken by role
 * ascending. This is the TUI/status table's comparator; the GUI page's browser copy
 * (`sortLoops`, gui-client-model.ts) cannot import TS, so test/gui.test.ts cross-checks the
 * two over the same fixtures to keep them in lockstep. /api/status and `status --json` keep
 * their payload (config) order — only the rendered tables sort. */
export function sortLoopsByState<T extends LoopSortRow>(loops: readonly T[]): T[] {
  return loops.slice().sort((a, b) => {
    const ra = loopRank(a.phase);
    const rb = loopRank(b.phase);
    if (ra !== rb) return ra - rb;
    const ta = a.lastRunEndedAt ?? 0;
    const tb = b.lastRunEndedAt ?? 0;
    if (ta !== tb) return tb - ta;
    return a.role.localeCompare(b.role);
  });
}

/** Token metrics for display. gen / peak ctx are per-tick windows — loop-tick.ts resets them at
 * tick start, so the persisted values hold only what the current (mid-flight) or last
 * completed tick used, never lifetime totals. While a tick is in flight the on-disk values
 * are 0 and the live log tail supplies exactly this run's output; idle loops show their
 * last completed tick as-is. Only running loops combine persisted + live: an idle loop's
 * log tail describes its last COMPLETED tick, whose tokens ARE the persisted values
 * (combining would double-count), while a stale `running` flag after a crash is still
 * correct to combine because that unfinished tick's counters were reset to 0 at tick start
 * and never re-saved. `live`, when given, is the frame's precomputed tail — it skips the log
 * read; without it a running loop reads on its own (standalone callers). Module-private:
 * loopRowCells is the only reader now that both dashboards derive their rows through it. */
function displayTokenMetrics(
  root: string,
  s: LoopState,
  live?: LiveProgress | null,
): { generated: number; peakCtx: number } {
  const p = s.running && !s.parkedSince
    ? tickProgress(root, s, live)
    : null;
  return {
    generated: s.generatedTokens + (p?.outputTokens ?? 0),
    peakCtx: Math.max(s.peakContextTokens, p?.peakContextTokens ?? 0),
  };
}
