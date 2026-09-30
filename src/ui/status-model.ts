import { DIRECTOR_ROLE, yieldScaledRole } from "../roles.js";
import type { LoopState } from "../loop-state.js";
import type { StatusSnapshot } from "./status.js";
import {
  ERROR_STREAK_WARN,
  QUIET_KILL_RESUME_LIMIT,
  yieldMultiplier,
} from "../tick-outcome.js";
import { budgetGate, budgetReached, type BudgetGate } from "../budget.js";
import { readLiveProgress, type LiveProgress, type ProgressRunKind } from "./progress.js";
import { compactTokens, shortSha, usd, usdCap } from "../text.js";
import { landingChanges, type LandingChange, type LandingStage } from "../landing-slot.js";

/** The status DISPLAY MODEL: what a loop's cycle position is, what each header badge reads,
 * and the per-loop token metrics — derived from the status data (status.ts) and shared by BOTH
 * observer surfaces: the terminal table (status-render.ts's renderStatus/stateCell) and the
 * JSON/GUI payload (status-payload.ts). Kept apart from status-render.ts so the GUI payload
 * depends on the shared model, not on the TUI table module — "what to show" (here) is separate
 * from "how a terminal lays it out" (status-render.ts). Depends on status.ts one way: deriving
 * reads the snapshot and never collects fleet state itself (live tick detail is display-only). */

/** Compact whole-second duration: `45s`, `12m`, or `3h`. Shared by ago and the sleeping-
 * remaining label so their s/m/h bucketing (thresholds and rounding) cannot drift. */
export function humanSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
}

/** The label for a loop's in-flight tick: `<label>` plus how long it has been running
 * ("working 3m", "reviewing 2m") — shared by workingDetail and the review-gate branch of
 * loopPhase so their elapsed formatting cannot drift. A tick with no recorded start time
 * renders as just the bare label. (A landing's elapsed is its marker's, never the tick's —
 * loopPhase's landing branch builds that head itself.) */
function inFlightLabel(s: LoopState, label: string): string {
  const elapsed = s.lastTickStartedAt ? duration(Date.now() - s.lastTickStartedAt) : "";
  return `${label} ${elapsed}`.trim();
}

/** The shared parts assembly for an in-flight state cell: `head` (the phase label with its
 * own elapsed — inFlightLabel for a tick, the landing branch's own for a landing) plus turn,
 * live context, current tool, and the ≥5-min no-output stall flag. `p` is null when there is
 * no progress (no log yet) — falls back to the bare head. */
function inFlightDetail(head: string, p: LiveProgress | null): string {
  if (!p) return head;
  const parts = [head, `turn ${p.turns + 1}`];
  if (p.contextTokens > 0) parts.push(`ctx ${compactTokens(p.contextTokens)}`);
  // A tool call open and silent past the configured stall threshold names itself in the cell —
  // the same rule as runPi's warning event, derived from the raw log tail. It takes lastTool's
  // slot when it is that tool (the common single-call case) instead of repeating the label.
  if (p.stalledTool) parts.push(`tool call stalled: ${p.stalledTool}`);
  else if (p.lastTool) parts.push(p.lastTool);
  // Silence under five minutes is normal (slow local-model prefills, long tool calls);
  // only flag a stall once at least five minutes have passed without any pi output.
  if (p.quietMs >= 300_000) parts.push(`no pi output for ${duration(p.quietMs)}`);
  return parts.join(" · ");
}

/** Which pi run kind (progress.ts's ProgressRunKind) a loop's in-flight cells should read:
 * the review gate's reviewer run ("gate") while the tick is under review — its `session`
 * event is the log's newest and its counts are what "reviewing" describes — the author's
 * own run ("author") for every other in-flight phase. One home for the rule so the TUI
 * table and the GUI payload cannot drift (the precomputed `live` tail must name the same
 * run the phase label does). Module-private: loopRowCells is the only reader. */
function progressKind(s: LoopState): ProgressRunKind {
  return s.phase === "review" ? "gate" : "author";
}

/** The yield multiplier a loop's row surfaces beside its next-run time (yield-scaled
 * clocks, PLANS.md): the role's recent-yield multiplier when its role is scalable, else 1.
 * One home for the rule so the TUI's next-run cell (status-render.ts), the JSON payload
 * (status-payload.ts), and the GUI's JS twin cannot disagree about whether a quiet role's
 * next run is stretched. */
export function yieldMultiplierFor(s: LoopState): number {
  return yieldScaledRole(s.role)
    ? yieldMultiplier((s.recentOutcomes ?? "").split(""))
    : 1;
}

/** The state cell for a working loop: elapsed · turns · live context · current tool. Pass
 * `live` — this frame's already-fetched tail (renderStatus reads once per running loop and
 * threads it through every helper) — to avoid re-reading the log; without it, this reads on
 * its own for standalone callers. */
export function workingDetail(root: string, s: LoopState, live?: LiveProgress | null): string {
  const p = live === undefined ? readLiveProgress(root, s.role) : live;
  return inFlightDetail(inFlightLabel(s, "working"), p);
}

/** The part of a change's in-flight landing record the landing cell renders: where the
 * pipeline is with it (its status), the change's own start (its elapsed), and the stage it is
 * in (absent from an older writer's marker). */
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
  merging: "merging",
  "build-check": "build check",
  reviewing: "reviewing",
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
      const p = root ? (live === undefined ? readLiveProgress(root, s.role, "gate") : live) : null;
      return inFlightDetail(inFlightLabel(s, "reviewing"), p);
    }
    // In-flight ticks finish even while the budget is paused — only NEW ticks are blocked,
    // so a running loop keeps its live detail.
    return root ? workingDetail(root, s, live) : "working";
  }
  if (s.role === DIRECTOR_ROLE) return "waiting for prompts"; // exempt from both gates
  if (userPaused) return "paused";
  if (budgetPaused) return "budget paused";
  // Main's own suite is known red at this loop's last tick: code-producing loops are blocked
  // from authoring until main is green (the red-main baseline check). Shown before sleep/queue
  // because it explains why the loop keeps waking and landing nothing; self-correcting, since
  // each blocked tick re-records main_red while red and a green wake overwrites lastResult.
  // Except a green wake that queues a change: `queued` is in flight, not a completed result,
  // so it leaves the main_red pair in place until its landing resolves (tick-outcome.ts's
  // applyTickOutcome) — its stashed summary is the tell that the loop's latest tick got past
  // the red-main gate, so main was green then and "main red" would be stale.
  if (s.lastResult === "main_red" && s.queuedSummary === undefined) return "main red";
  // An error streak at or past the warning threshold (tick-outcome.ts's ERROR_STREAK_WARN): the
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
    const remain = Math.max(1, Math.round((s.nextRunAt - Date.now()) / 1000));
    return `sleeping (for ${humanSeconds(remain)})`;
  }
  return "queued";
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
  const live = s.running && !s.parkedSince ? readLiveProgress(root, s.role, progressKind(s)) : null;
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
 * blocked by a red main; 3 paused — by the operator or by the budget; 4 everything else (idle:
 * sleeping, queued, the director waiting for prompts, a stopped fleet). The dashboard groups its
 * loop table by these ranks; the TUI/status table orders by them. */
export function loopRank(phase: string): number {
  if (isActivePhase(phase)) return 0;
  if (phase.startsWith("vetted") || phase.startsWith("awaiting slot")) return 1;
  if (phase === "failing" || phase === "main red") return 2;
  if (phase === "paused" || phase === "budget paused") return 3;
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
  const p = s.running && !s.parkedSince ? (live === undefined ? readLiveProgress(root, s.role) : live) : null;
  return {
    generated: s.generatedTokens + (p?.outputTokens ?? 0),
    peakCtx: Math.max(s.peakContextTokens, p?.peakContextTokens ?? 0),
  };
}

/** The header's build fragment: which commit the running harness was compiled from and, when
 * main's build inputs have moved past it, how far — the fleet is then executing code main no
 * longer describes (auto-restart lands the new build; off, restart `tumwater run` by hand).
 * A stale build also says what auto-restart is doing about it: `restart pending` resolves
 * itself, `restart BLOCKED` never will until main moves, and telling them apart at a glance is
 * the whole point (see BuildStatus.restartBlocked). Empty when the dist carries no stamp.
 * Shared by the TUI/status header here and the GUI's. */
export function buildBadge(build: StatusSnapshot["build"]): string {
  if (!build) return "";
  const stale = build.stale ? ` — STALE: main +${build.aheadCommits ?? 0} commit(s) since` : "";
  const restart = build.restartBlocked
    ? `; restart BLOCKED: ${build.restartBlocked}`
    : build.restartPending
      ? "; restart pending"
      : "";
  return `, build ${shortSha(build.sha)}${stale}${restart}`;
}

/** Main's newest merge-scope check as a header badge (PLANS.md "Retire the README freshness
 * stamp"): `· main <sha>: green · N/N (N skipped)` — the live replacement for the committed
 * README stamp the readme role used to maintain. Empty when the snapshot carries no check
 * (none has run yet), so a quiet header stays byte-identical to a pre-check fleet. The
 * verdict maps passed→green, failed→red; anything else (a skipped scope check) renders its
 * raw word — an unverified tree must not read green. The counts fragment omits a zero-skip
 * parenthetical, matching the stamp wording the README carried. */
export function mainCheckBadge(mainCheck: StatusSnapshot["mainCheck"]): string {
  if (!mainCheck) return "";
  const verdict = mainCheck.status === "passed" ? "green" : mainCheck.status === "failed" ? "red" : mainCheck.status;
  const counts = mainCheck.counts
    ? ` · ${mainCheck.counts.pass}/${mainCheck.counts.tests}${mainCheck.counts.skipped > 0 ? ` (${mainCheck.counts.skipped} skipped)` : ""}`
    : "";
  const sha = mainCheck.sha ? `${shortSha(mainCheck.sha)}: ` : "";
  return ` · main ${sha}${verdict}${counts}`;
}

/** The fleet's current budget-gate state, derived from a snapshot's budget block — the one
 * home for the budgetReached + fallback-readiness wiring both observer surfaces share: the
 * TUI/status table needs the `paused` verdict for loopPhase, the JSON/GUI payload ships the
 * same one, and budgetBadge needs `fallback` — so the three-valued display rule cannot
 * drift between the surfaces. Module-private: loopPhase (via loopRowCells) and budgetBadge
 * are the only readers. */
function fleetBudgetGate(budget: StatusSnapshot["budget"]): BudgetGate {
  return budgetGate(budgetReached(budget), budget.fallback !== null);
}

/** The header's daily-cost-budget fragment, standing in every cap state (the badge is also
 * the affordance for editing the cap, so a disabled fleet needs it too): `· budget: n/a`
 * for a fleet whose models are all free (spend can never accumulate against a cap that
 * cannot be reached — and no priced model means no daily spend to count, hence no "today"
 * — checked first, in every cap state), `· budget: $X.XX/$Y today` while enabled with
 * priced models, and `· budget: $X today · no cap` when disabled. One
 * home for the rule — renderStatus renders it in the TUI/status header and status-payload.ts
 * ships its output preformatted as `budgetBadge`, so the GUI page cannot drift from this
 * string. */
export function budgetBadge(budget: StatusSnapshot["budget"]): string {
  if (budget.free) return " · budget: n/a";
  // Only while the fallback is actually carrying the fleet (plans/fallback-model.md): the cap
  // is spent, so the dollar figure alone would read like a stopped fleet. Naming the model
  // answers the operator's next question — what is it running on now? Its cost is n/a by
  // construction (the gate engages nothing else), so no second figure is shown. Off-gate the
  // badge is byte-identical to before.
  const fallback =
    fleetBudgetGate(budget) === "fallback"
      ? ` · fallback: ${budget.fallback?.model ?? budget.fallback?.provider ?? "pi default"} (cost n/a)`
      : "";
  if (budget.capUsd > 0)
    return ` · budget: ${usd(budget.spentUsd)}/${usdCap(budget.capUsd)} today${fallback}`;
  return ` · budget: ${usd(budget.spentUsd)} today · no cap`;
}

/** The header's land-queue fragment (plans/merge-queue.md 4/5): `· land queue: N` while any
 * landing is queued or in flight, empty when the queue is idle — so an idle fleet keeps
 * every existing header byte intact. One home for the rule, like buildBadge and budgetBadge:
 * renderStatus renders it in the TUI/status header and status-payload.ts ships its output
 * preformatted, so the GUI page cannot drift from this string. */
export function landingBadge(landQueue: { depth: number }): string {
  return landQueue.depth > 0 ? ` · land queue: ${landQueue.depth}` : "";
}

/** The header's fleet timed-pause fragment: `· paused — auto-resumes in <duration>` while a
 * timed pause stands, empty otherwise — so an operator can tell at a glance whether a paused
 * fleet will come back on its own or needs a manual `resume` (the Timed pause plan left the
 * display out on purpose). The snapshot's `pausedUntil` is the FLEET marker's deadline (ms
 * epoch, plans/daily-cost-budget.md item 5), so the badge stands exactly when the fleet
 * itself is timed-paused: a role-only timed pause leaves the header unchanged, and an absent
 * or already-expired deadline renders nothing — the read side treats an expired marker as
 * unpaused, so the badge never claims a countdown that is over. The duration goes through
 * the shared humanSeconds so one helper owns duration phrasing. renderStatus renders it in
 * the TUI/status header after the budget badge; the GUI recomputes the ticking number
 * client-side from the payload's raw `pausedUntil` (status-payload.ts) using its own
 * humanSeconds copy, pinned against this one by test. */
export function pauseBadge(pausedUntil: number | undefined, now: number): string {
  if (pausedUntil === undefined || pausedUntil <= now) return "";
  return ` · paused — auto-resumes in ${humanSeconds(Math.round((pausedUntil - now) / 1000))}`;
}
