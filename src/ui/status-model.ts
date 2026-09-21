import { DIRECTOR_ROLE } from "../roles.js";
import type { LoopState } from "../types.js";
import type { StatusSnapshot } from "./status.js";
import { ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT } from "../state.js";
import { budgetGate, budgetReached } from "../budget.js";
import { readLiveProgress, type LiveProgress } from "./progress.js";
import { compactTokens, shortSha, usd, usdCap } from "../text.js";

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
 * renders as just the bare label. */
function inFlightLabel(s: LoopState, label: string): string {
  const elapsed = s.lastTickStartedAt ? duration(Date.now() - s.lastTickStartedAt) : "";
  return `${label} ${elapsed}`.trim();
}

/** The shared parts assembly for an in-flight state cell: `<label> <elapsed>` plus turn,
 * live context, current tool, and the ≥5-min no-output stall flag. `p` is null when there is
 * no progress (no log yet) — falls back to the bare label. */
function inFlightDetail(s: LoopState, label: string, p: LiveProgress | null): string {
  if (!p) return inFlightLabel(s, label);
  const parts = [inFlightLabel(s, label), `turn ${p.turns + 1}`];
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

/** The state cell for a working loop: elapsed · turns · live context · current tool. Pass
 * `live` — this frame's already-fetched tail (renderStatus reads once per running loop and
 * threads it through every helper) — to avoid re-reading the log; without it, this reads on
 * its own for standalone callers. */
export function workingDetail(root: string, s: LoopState, live?: LiveProgress | null): string {
  const p = live === undefined ? readLiveProgress(root, s.role) : live;
  return inFlightDetail(s, "working", p);
}

/** The snapshot's in-flight landing record (merge queue 4/5) filtered to one role: the
 * record when this role's change is landing, null otherwise. The single home of the
 * "is this role landing" filter — every phase call site derives its `landing` argument
 * through this so the filtering cannot drift between them. */
export function landingForRole(
  landQueue: StatusSnapshot["landQueue"],
  role: string,
): { startedAt: number } | null {
  return landQueue.inFlight && landQueue.inFlight.role === role
    ? { startedAt: landQueue.inFlight.startedAt }
    : null;
}

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
 * `landing`, when given for this role, is the snapshot's in-flight landing record — build it
 * with landingForRole so the marker's role filter lives in one place. */
export function loopPhase(
  s: LoopState,
  orchestratorRunning: boolean,
  root?: string,
  budgetPaused = false,
  live?: LiveProgress | null,
  userPaused = false,
  landing?: { startedAt: number } | null,
): string {
  if (!orchestratorRunning) return "stopped";
  // Merge queue 4/5 — the marker-driven landing label: only the role whose in-flight record
  // was passed gets it (callers derive it via landingForRole), and a stopped harness never
  // shows it — a dead fleet's marker is stale by definition.
  if (landing) return `landing ${duration(Date.now() - landing.startedAt)}`;
  if (s.running) {
    // The tick's work is committed and under adversarial review: the raw log tail now
    // describes the reviewer run — show its live progress with a "reviewing" label.
    if (s.phase === "review") {
      const p = root ? (live === undefined ? readLiveProgress(root, s.role) : live) : null;
      return inFlightDetail(s, "reviewing", p);
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
  if (s.lastResult === "main_red") return "main red";
  // An error streak at or past the warning threshold (state.ts's ERROR_STREAK_WARN): the
  // loop is retrying the same failure on the error ladder, and the operator must see
  // "failing" — not a sleepy label — while it is stuck (BUGS.md 2026-09-15). Self-clearing:
  // the first non-error tick resets the streak, and each retry re-records "error" while the
  // environment stays broken.
  if (s.lastResult === "error" && (s.consecutiveErrors ?? 0) >= ERROR_STREAK_WARN) return "failing";
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
export interface LoopSortRow {
  role: string;
  phase: string;
  lastTickEndedAt?: number | null;
}

/** Is this phase one of the in-flight states? The three labels come from loopPhase:
 * `working …`, `reviewing …`, and the marker-driven `landing …` (merge queue 4/5). Named once
 * so the two rendered tables and their lockstep test share the rule instead of restating the
 * prefixes. */
export function isActivePhase(phase: string): boolean {
  return phase.startsWith("working") || phase.startsWith("reviewing") || phase.startsWith("landing");
}

/** The loop tables' shared row order: in-flight phases (working, reviewing, landing) before
 * inactive ones; within a category by last tick most-recent-first, a never-ticked (null) row
 * after any timestamp, ties broken by role ascending. This is the TUI/status table's
 * comparator; the GUI page's browser copy (`sortLoops`, gui-client.ts) cannot import TS (the
 * fmtTokens/lastTickCell precedent), so test/gui.test.ts cross-checks the two over the same
 * fixtures to keep them in lockstep. /api/status and `status --json` keep their payload
 * (config) order — only the two rendered tables sort. */
export function sortLoopsByState<T extends LoopSortRow>(loops: readonly T[]): T[] {
  return loops.slice().sort((a, b) => {
    const ca = isActivePhase(a.phase) ? 0 : 1;
    const cb = isActivePhase(b.phase) ? 0 : 1;
    if (ca !== cb) return ca - cb;
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
 * read; without it a running loop reads on its own (standalone callers). */
export function displayTokenMetrics(
  root: string,
  s: LoopState,
  live?: LiveProgress | null,
): { generated: number; peakCtx: number } {
  const p = s.running ? (live === undefined ? readLiveProgress(root, s.role) : live) : null;
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
    budgetGate(budgetReached(budget), budget.fallback !== null) === "fallback"
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
