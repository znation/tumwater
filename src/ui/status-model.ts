import { DIRECTOR_ROLE } from "../roles/roles.js";
import type { LoopState } from "../loop/loop-state.js";
import type { StatusSnapshot } from "../status/status-data.js";
import { ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT } from "../tick/tick-apply.js";
import { readLiveProgress, type LiveProgress } from "../progress-data.js";
import { fleetBudgetGate } from "./badges.js";
import { quietWindowEnd } from "../quiet-hours.js";
import { humanSeconds, secondsUntil } from "../text/datetime.js";
import {
  duration,
  inFlightDetail,
  inFlightLabel,
  progressKind,
  tickProgress,
  workingDetail,
} from "./tick-progress-model.js";
import { landingChanges, type LandingChange, type LandingStage } from "../landing/landing-slot.js";

/** The status DISPLAY MODEL: the loop's cycle position (the phase ladder), its landing cell,
 * and its per-loop row derivation (the header badges live next door in badges.ts, the
 * in-flight tick's live progress detail in tick-progress-model.ts) — derived from the status
 * data (status/status-data.ts)
 * and shared by BOTH
 * observer surfaces: the terminal table (status-render.ts's renderStatus/stateCell) and the
 * JSON/GUI payload (status-payload.ts). Kept apart from status-render.ts so the GUI payload
 * depends on the shared model, not on the TUI table module — "what to show" (here) is separate
 * from "how a terminal lays it out" (status-render.ts). Depends on status/status-data.ts one way: deriving
 * reads the snapshot and never collects fleet state itself (live tick detail is display-only). */

type LandingCell = Pick<LandingChange, "status" | "startedAt" | "stage">;

/** The snapshot's in-flight landing record (merge queue 4/5) filtered to one role: this
 * role's change record while the pipeline holds it — vetting or merging it (`landing`), or
 * keeping it for the merge slot (`vetted`) — and null otherwise, including once the merge is
 * `done` with it (a change that reached its outcome must not keep a live label while the rest of
 * its stack lands — BUGS.md 2026-09-23). An older generation's one-change marker reads as one
 * `landing` record (landingChanges). The single home of the "is this role landing" filter — every phase call
 * site derives its `landing` argument through this so the filtering cannot drift between
 * them. */
export function landingForRole(landQueue: StatusSnapshot["landQueue"], role: string): LandingCell | null {
  if (!landQueue.inFlight) return null;
  const change = landingChanges(landQueue.inFlight).find((c) => c.role === role);
  return change && change.status !== "done"
    ? { status: change.status, startedAt: change.startedAt, stage: change.stage }
    : null;
}

/** How each landing stage names itself in the landing cell. */
const LANDING_STAGE_LABELS: Record<LandingStage, string> = {
  rebasing: "rebasing",
  "check-wait": "waiting for a check slot",
  "build-check": "build check",
  reviewing: "reviewing",
  merging: "merging",
};

/** The loop's state label — the one precedence ladder shared by the status table and both
 * dashboards (renderStatus, statusPayload). First match wins: a stopped harness; an in-flight
 * landing (the role's tick already ended "queued" while its change lands, so the marker
 * supplies the label); a running tick ("working", or "reviewing" while the review gate holds
 * it — in-flight work finishes through both fleet gates); the director's "waiting for
 * prompts" (exempt from those gates); user pause; budget pause; a red main ("main red"); an
 * error or quiet-kill streak at its threshold ("failing"); sleep; then "queued".
 * Pass `root` so an in-flight tick expands into live detail (elapsed · turn · ctx · tool);
 * without it a working loop shows plain "working". `live`, when given, is the frame's
 * precomputed tail (see workingDetail) — it skips the log read; without it an in-flight tick
 * reads on its own. `budgetPaused` marks the fleet's daily cost budget as reached: idle role
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
 * fleetAlerts banner follows. A check that is newer but failed keeps the label (main is
 * genuinely red); so does one older than the red tick or with no known pass at all — the
 * blockage stands until the loop's own next tick re-verdicts it.
 * Otherwise its elapsed is the CHANGE's own landing (its record's startedAt — from its vet's
 * start, never another change's), never the authoring tick's,
 * and its stage scopes the cell to the phase the landing is actually in: `reviewing` carries
 * the reviewer run's live detail exactly as a reviewing tick does (`landing 3m · reviewing ·
 * turn 2 · ctx 18.0k · bash npm test`); `build-check` and `merging` render just the stage
 * (`landing 1m · build check`) and never read the log — no reviewer is running then, and the log's newest run is
 * typically a finished one (the author's, a previous review) whose turns are stale and whose
 * silence would read as a false stall; a record with no stage (an older writer mid-upgrade)
 * keeps the bare elapsed label. */
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
): string {
  if (!orchestratorRunning) return "stopped";
  // Merge queue 4/5 — the marker-driven landing label: only a role whose change record was
  // passed gets it (callers derive it via landingForRole), and a stopped harness never
  // shows it — a dead fleet's marker is stale by definition.
  if (landing) {
    if (landing.status === "vetted") return "vetted, awaiting merge";
    const head = landing.startedAt === undefined ? "landing" : `landing ${duration(Date.now() - landing.startedAt)}`;
    if (!landing.stage) return head;
    const staged = `${head} · ${LANDING_STAGE_LABELS[landing.stage]}`;
    if (landing.stage !== "reviewing") return staged;
    // The reviewer writes the role's own log from its lander worktree: the GATE accumulator,
    // read here rather than taken from `live` — the landing role's tick has ended, so the
    // frame's per-running-loop tail is not this run's (callers pass null for it).
    return inFlightDetail(staged, root ? readLiveProgress(root, s.role, "gate") : null);
  }
  if (s.running) {
    // A parked waiter is reserved against double-scheduling but holds no maxConcurrent permit
    // and runs no pi yet: render its true state and keep it OUT of the active set (isActivePhase)
    // so the operator can count active rows against the cap — a landing visibly counts, a
    // parked waiter visibly does not (BUGS.md 2026-09-24).
    if (s.parkedSince) return `awaiting slot ${duration(Date.now() - s.parkedSince)}`;
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
  if (s.role === DIRECTOR_ROLE) return "waiting for prompts"; // exempt from both gates
  if (userPaused) return "paused";
  // The loop's OWN daily cap (PLANS.md, per-role cap part 2/2): the more specific spend
  // state, so it names itself ahead of the fleet's budget pause — the ladder's existing
  // "user intent is more specific than spend state" argument extended one level down.
  if (capPaused) return "cap paused";
  // The loop's OWN quiet-hours window (PLANS.md, quietHoursPerRole): the fleet gate's own
  // wording — `quiet until <end>` — scoped to the one loop the operator scheduled. Shown
  // after the cap and before the fleet's budget pause: the loop's own schedule is more
  // specific than either.
  if (quietHold) return `quiet until ${quietWindowEnd(quietHold)}`;
  if (budgetPaused) return "budget paused";
  // Main's own suite is known red at this loop's last tick: code-producing loops are blocked
  // from authoring until main is green (the red-main baseline check). Shown before sleep/queue
  // because it explains why the loop keeps waking and landing nothing; self-correcting, since
  // each blocked tick re-records main_red while red and a green wake overwrites lastResult.
  // Except a green wake that queues a change: `queued` is in flight, not a completed result,
  // so it leaves the main_red pair in place until its landing resolves (tick-apply.ts's
  // applyTickOutcome) — its stashed summary is the tell that the loop's latest tick got past
  // the red-main gate, so main was green then and "main red" would be stale.
  // Except too when main's newest merge-scope check PASSED after this loop's red tick ended:
  // the fleet-level verdict is fresher than the loop's own, so the label is stale until the
  // loop's next tick — which can be hours away (BUGS.md 2026-09-30). A check older than the
  // red tick, a failed or skipped one, or an unknown tick end all keep the label.
  if (s.lastResult === "main_red" && s.queuedSummary === undefined && !mainCheckRecovered(mainCheck, s)) return "main red";
  // An error streak at or past the warning threshold (tick-apply.ts's ERROR_STREAK_WARN): the
  // loop is retrying the same failure on the error ladder, and the operator must see
  // "failing" — not a sleepy label — while it is stuck (BUGS.md 2026-09-15). The streak
  // alone is the tell, not `lastResult`: a tick whose leftover recovery failed keeps the
  // pin while its own authoring run may end `no_change`/`queued`, so a dead reviewer
  // backend must still read "failing" (BUGS.md 2026-09-21). Self-clearing: the first
  // healthy tick resets the streak, and each retry re-arms it while the environment stays
  // broken.
  if ((s.consecutiveErrors ?? 0) >= ERROR_STREAK_WARN) return "failing";
  // A quiet-kill streak at the give-up threshold reads "failing" too (BUGS.md 2026-09-18):
  // the loop is retrying a session the backend will not schedule, and before this it looked
  // exactly like a sleeping loop while it burned an hour of slot time per tick.
  if (s.lastResult === "quiet_killed" && (s.quietKillStreak ?? 0) >= QUIET_KILL_RESUME_LIMIT) return "failing";
  if (s.nextRunAt > Date.now()) {
    // The loop is sleeping *now* until nextRunAt: show the remaining sleep duration
    // ("for 30m"), not a future start ("in 30m"). Floor at 1s so a sub-second remainder
    // never renders as "sleeping (for now)".
    const remain = Math.max(1, secondsUntil(s.nextRunAt, Date.now()));
    return `sleeping (for ${humanSeconds(remain)})`;
  }
  return "queued";
}

/** Has main's newest merge-scope check retired a loop's stale `main_red` verdict? Only a
 * PASSED check stamped strictly after the loop's red tick ended counts — the fleet-level
 * green is newer evidence than the loop's own red (BUGS.md 2026-09-30). A failed or skipped
 * newest check, a check from before the red tick, or a loop with no known tick end all leave
 * the verdict standing. Single-homed here so loopPhase's main-red branch and its callers
 * cannot drift. */
function mainCheckRecovered(mainCheck: StatusSnapshot["mainCheck"], s: LoopState): boolean {
  return mainCheck?.status === "passed"
    && s.lastTickEndedAt !== undefined
    && mainCheck.at > s.lastTickEndedAt;
}

/** One rendered loop-table row's sort key: the role name, its rendered phase label
 * (loopPhase), and its last tick end. Both the TUI/status table and the GUI page's browser
 * copy carry these three fields. */
interface LoopSortRow {
  role: string;
  phase: string;
  lastTickEndedAt?: number | null;
}

/** One loop row's display derivation — the block both observer surfaces re-ran per loop
 * (renderStatus's withMetrics map and statusPayload's loops map): a single live tail read
 * (the running-and-not-parked gate, read at the phase's progressKind), the token metrics
 * over that tail, and the rendered phase string. The phase's snapshot-level gates are
 * derived here too — budget paused (only `paused` stops a loop; `fallback` keeps it ticking
 * on the free model, which the header badge names), the fleet pause plus the per-role one
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
    fleetBudgetGate(snap.budget) === "paused",
    live,
    // The per-role pause reads the same `paused` cell as the fleet pause: one flag to
    // loopPhase covers both gates (status-model has no per-role branch of its own).
    snap.paused || snap.pausedRoles.includes(s.role),
    landingForRole(snap.landQueue, s.role),
    // The snapshot's newest merge-scope check lets a stale main-red phase retire itself
    // between ticks (BUGS.md 2026-09-30) — the banner (fleetAlerts) reads this same phase.
    snap.mainCheck,
    // The per-role cap's verdict, computed once per poll in the snapshot (status/status-data.ts
    // roleCapPaused): an idle loop over its own cap reads `cap paused` on every surface.
    snap.capPaused.includes(s.role),
    // The per-role quiet window's verdict (status/status-data.ts roleQuietPaused): an idle loop
    // inside its own window reads `quiet until <end>` — the fleet badge's wording, scoped.
    snap.roleQuietPaused?.[s.role],
  );
  return { live, generated: m.generated, peakCtx: m.peakCtx, phase };
}

/** Is this phase one of the in-flight states? The three labels come from loopPhase:
 * `working …`, `reviewing …`, and the marker-driven `landing …` (merge queue 4/5) — a vetted
 * change waiting for the merge slot (`vetted, awaiting merge`) runs nothing, so it is not in
 * flight. Named once so the two rendered tables and their lockstep
 * test share the rule instead of restating the prefixes — and statusPayload reuses it for each
 * loop row's `inFlight` flag, so the GUI's row actions never re-derive the three phase
 * prefixes client-side. */
export function isActivePhase(phase: string): boolean {
  return phase.startsWith("working") || phase.startsWith("reviewing") || phase.startsWith("landing");
}

/** A loop's rank in the rendered tables, from its phase label (loopPhase): 0 live work —
 * working, reviewing, landing (isActivePhase); 1 work waiting in the pipeline — a vetted change
 * awaiting the merge slot, or a tick parked awaiting a permit; 2 needs attention — failing, or
 * blocked by a red main; 3 paused — by the operator, by the budget, or by the loop's own
 * per-role cap; 4 everything else (idle: sleeping, queued, the director waiting for prompts, a
 * stopped fleet). The dashboard groups its loop table by these ranks; the TUI/status table
 * orders by them. */
export function loopRank(phase: string): number {
  if (isActivePhase(phase)) return 0;
  if (phase.startsWith("vetted") || phase.startsWith("awaiting slot")) return 1;
  if (phase === "failing" || phase === "main red") return 2;
  if (phase === "paused" || phase === "budget paused" || phase === "cap paused") return 3;
  return 4;
}

/** The loop tables' shared row order: by loopRank (live work, then work waiting in the
 * pipeline, then loops that need attention, then paused, then idle); within a rank by last tick
 * most-recent-first, a never-ticked (null) row after any timestamp, ties broken by role
 * ascending. This is the TUI/status table's comparator; the GUI page's browser copy
 * (`sortLoops`, gui-client-model.ts) cannot import TS, so test/gui.test.ts cross-checks the two over
 * the same fixtures to keep them in lockstep. /api/status and `status --json` keep their payload
 * (config) order — only the rendered tables sort. */
export function sortLoopsByState<T extends LoopSortRow>(loops: readonly T[]): T[] {
  return loops.slice().sort((a, b) => {
    const ra = loopRank(a.phase);
    const rb = loopRank(b.phase);
    if (ra !== rb) return ra - rb;
    const ta = a.lastTickEndedAt ?? 0;
    const tb = b.lastTickEndedAt ?? 0;
    if (ta !== tb) return tb - ta;
    return a.role.localeCompare(b.role);
  });
}

/** Token metrics for display. gen / peak ctx are per-tick windows — loop.ts resets them at
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
