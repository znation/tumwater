import path from "node:path";
import { DIRECTOR_ROLE } from "../roles.js";
import type { LoopState } from "../types.js";
import type { StatusSnapshot } from "./status.js";
import { ERROR_STREAK_WARN, QUIET_KILL_RESUME_LIMIT, budgetGate, dailyCost, fleetDailyCost, budgetReached } from "../state.js";
import { readLiveProgress, type LiveProgress } from "./progress.js";
import { compactTokens, cutSplitsSurrogatePair, formatTime, pad2, shortSha, usd, usdCap } from "../text.js";

/** Presentation layer over the status data (status.ts): human-facing labels for a loop's
 * cycle position, time/token formatters, and the width-aware table shared by
 * `tumwater status` and the TUI. Depends on status.ts one way — rendering reads the
 * snapshot; it never collects fleet state itself (live tick detail is display-only). */

/** Compact whole-second duration: `45s`, `12m`, or `3h`. Shared by ago and the sleeping-
 * remaining label so their s/m/h bucketing (thresholds and rounding) cannot drift. */
function humanSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function ago(ts: number | undefined): string {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return `${humanSeconds(s)} ago`;
}

/** The table's `last tick` cell: the absolute local time of the last tick end alongside its
 * relative age ("14:32:05 · 3m ago"). Zero-padded HH:MM:SS in local time, prefixed `MM-DD `
 * once older than a day so multi-day runs stay unambiguous; "-" for loops that never ticked.
 * The GUI renders the same cell (absolute stamp plus relative age) from its own JS copy in
 * gui-client.ts — formatting at each surface, per the fmtTokens precedent. */
export function lastTickCell(ts: number | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  let s = formatTime(d);
  if (Date.now() - ts > 86_400_000) s = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${s}`;
  return `${s} · ${ago(ts)}`;
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

/** Human label of where a loop is in its cycle (stopped / working / waiting for prompts /
 * paused / budget paused / main red / failing / sleeping / queued). Pass `root` so an in-flight tick expands into live detail
 * (elapsed · turn · ctx · tool); without it a working loop shows plain "working".
 * `budgetPaused` marks the fleet's daily cost budget as reached: idle role loops show
 * `budget paused` instead of their sleep/queue state — that is why they are not ticking.
 * `userPaused` marks an operator pause (`tumwater pause` marker present): idle role loops
 * show `paused`, checked before the budget gate because user intent is more specific than
 * spend state — while both hold, "paused" tells the operator what to do (`resume`).
 * `live`, when given, is the frame's precomputed tail (see workingDetail) — it skips the log
 * read; without it an in-flight tick reads on its own.
 * `landing`, when given for this role, is the snapshot's in-flight landing record — the
 * authoring role's tick already ended "queued" before its landing ran, so it is NOT running
 * here and no phase can carry the label: the marker-driven record does, and renders
 * `landing <elapsed>` (elapsed from the marker's startedAt) ahead of every other idle state.
 * Build it with landingForRole so the marker's role filter lives in one place. */

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

/** The table's state cell: loopPhase's label, with the current work item prepended while a
 * tick is in flight ("implement plan X · working 3m · turn 2"). Prepending — not appending —
 * so the item survives ellipsis clipping on narrow terminals; the live detail after it is what
 * gets clipped first. Idle loops are untouched: their log tail describes a finished tick and
 * must not leak its work item into the state cell. (The GUI shows the same item in its own
 * `current` column instead, so its state cell stays clean.) */
function stateCell(
  root: string,
  s: LoopState,
  orchestratorRunning: boolean,
  budgetPaused = false,
  live?: LiveProgress | null,
  userPaused = false,
  landing?: { startedAt: number } | null,
): string {
  const phase = loopPhase(s, orchestratorRunning, root, budgetPaused, live, userPaused, landing);
  // While under review the log tail's "current work" is the reviewer's own output, not the
  // author's task — don't prepend it; the phase cell already carries the reviewer's live
  // detail. The landing label rides the same guard: the landing role is not running, so the
  // bare phase ("landing <elapsed>") is returned without a work-item prefix.
  if (!s.running || s.phase === "review") return phase;
  const p = live === undefined ? readLiveProgress(root, s.role) : live;
  const work = p?.currentWork;
  return work ? `${work} · ${phase}` : phase;
}

/** Truncate to `width` with a trailing ellipsis when over. The result never exceeds
 * `width` characters (even at width ≤ 1), so clipped lines cannot wrap in a terminal of
 * that many columns. A cut that would split a surrogate pair backs off one unit, so no line
 * ever carries a lone surrogate (terminals render it as garbage). A negative width fits
 * nothing and yields the empty string, keeping the invariant at degenerate budgets. Shared
 * by the status table and the TUI's line rendering. */
export function clipToWidth(text: string, width: number): string {
  if (width < 0) return ""; // No budget fits nothing; without this, slice(0, -1) would keep almost all of text.
  if (text.length <= width) return text;
  const bare = width <= 1; // No room for an ellipsis at degenerate widths.
  let cut = bare ? width : width - 1;
  if (cutSplitsSurrogatePair(text, cut)) cut -= 1; // Never emit a lone high surrogate.
  return bare ? text.slice(0, cut) : `${text.slice(0, cut)}…`;
}

/** Columns allowed to shrink when the table is wider than the terminal, widest offender
 * first: `last result` (holds the tick summary), then `state` (live working detail), then
 * `last tick` — it shrinks last so on a narrow terminal it loses " · 3m ago" before whole
 * lines clip; its minimum is a bare HH:MM:SS. Indices are positional in the `cols` array
 * below — renumber when columns change. (`today`, like `cost`, is a short fixed-width cell:
 * never flexible.) */
const FLEXIBLE_COLUMNS: Array<{ index: number; minWidth: number }> = [
  { index: 9, minWidth: 12 },
  { index: 1, minWidth: 12 },
  { index: 8, minWidth: 10 },
];
const COLUMN_GAP = 2;

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

/** Render the status table shared by `tumwater status` and the TUI. When `maxWidth` is
 * given, wide cells are clipped so no line exceeds it (terminal rows never wrap). */
export function renderStatus(root: string, snap: StatusSnapshot, maxWidth?: number): string {
  const name = path.basename(path.resolve(root));
  const lines: string[] = [];
  const header = snap.running ? `running (pid ${snap.pid}${buildBadge(snap.build)})` : "not running — start with `tumwater run`";
  // The questions badge (like the inbox one) appears only when something needs an answer.
  // The budget badge is standing information for a money-spending system in EVERY cap state
  // (disabled reads `· no cap` — and it is the affordance for editing the cap); on narrow
  // terminals the header's existing last-resort whole-line clipping applies. A fleet whose
  // models are all free reads n/a — spend can never accumulate against a cap that cannot be
  // reached, so a dollar figure would mislead.
  lines.push(
    `tumwater · ${name} · ${header}${landingBadge(snap.landQueue)}${snap.inbox ? ` · inbox: ${snap.inbox}` : ""}${
      snap.questions ? ` · questions: ${snap.questions}` : ""
    }${budgetBadge(snap.budget)}`,
  );
  lines.push("");
  // `today` is the loop's daily budget window (dailyCost): $0.00 while its stamp is stale
  // or missing, so loops that never ticked — or last ticked yesterday — read zero without a
  // save. It renders whether or not the cap is enabled: spend observability does not depend
  // on it.
  const cols = ["loop", "state", "ticks", "commits", "gen", "peak ctx", "cost", "today", "last tick", "last result"];
  // The budget gate is fleet-wide (plans/daily-cost-budget.md) and three-valued since
  // plans/fallback-model.md: only `paused` — the cap reached with no usable free fallback —
  // stops the loops, so only it turns an idle role row into `budget paused`. Under `fallback`
  // the loops keep ticking (on the free model, which the header badge names), so their rows
  // read their normal state. The operator pause is fleet-wide too and outranks both.
  const budgetPausedNow = budgetGate(budgetReached(snap.budget), snap.budget.fallback !== null) === "paused";
  const userPausedNow = snap.paused;
  // One live tail read per running loop per frame, threaded through every cell that shows
  // in-flight detail (metrics, state, current work) — each helper used to re-read the log on
  // its own, up to three stats + reads per loop per second.
  const withMetrics = snap.loops.map((s) => {
    const live = s.running ? readLiveProgress(root, s.role) : null;
    return { s, m: displayTokenMetrics(root, s, live), live };
  });
  // User-defined loops (snapshot's `custom` flag) get an asterisk beside their name — the
  // dashboards' at-a-glance marker. The name column (index 0) is not in FLEXIBLE_COLUMNS and
  // its width derives from row content, so the extra character widens it automatically.
  const rows = withMetrics.map(({ s, m, live }) => [
    s.custom ? `${s.role}*` : s.role,
    // Merge queue 4/5 — the role whose change is landing reads `landing <elapsed>` (the
    // marker-driven record, filtered to this role); every other role is untouched.
    stateCell(
      root,
      s,
      snap.running,
      budgetPausedNow,
      live,
      userPausedNow,
      landingForRole(snap.landQueue, s.role),
    ),
    String(s.ticks),
    String(s.commits),
    compactTokens(m.generated),
    compactTokens(m.peakCtx),
    usd(s.totalCostUsd),
    usd(dailyCost(s)),
    lastTickCell(s.lastTickEndedAt),
    s.lastResult ? `${s.lastResult}${s.lastSummary ? ` — ${s.lastSummary}` : ""}` : "-",
  ]);
  const totalsRow = [
    "total",
    "",
    "",
    "",
    compactTokens(withMetrics.reduce((sum, { m }) => sum + m.generated, 0)),
    compactTokens(Math.max(0, ...withMetrics.map(({ m }) => m.peakCtx))),
    usd(snap.loops.reduce((sum, s) => sum + s.totalCostUsd, 0)),
    // The fleet's today-spend — by construction equal to the header badge's spend while
    // enabled (snapshot derives both from the same loops), so table and badge cannot drift.
    usd(fleetDailyCost(snap.loops)),
    "",
    "",
  ];
  const allRows = [...rows, totalsRow];
  const widths = cols.map((c, i) => Math.max(c.length, ...allRows.map((r) => (r[i] ?? "").length)));

  if (maxWidth !== undefined) {
    let overflow = widths.reduce((a, b) => a + b, 0) + COLUMN_GAP * (cols.length - 1) - maxWidth;
    for (const { index, minWidth } of FLEXIBLE_COLUMNS) {
      if (overflow <= 0) break;
      const current = widths[index] ?? 0;
      const reduction = Math.min(overflow, Math.max(0, current - minWidth));
      widths[index] = current - reduction;
      overflow -= reduction;
    }
  }

  const fmt = (r: string[]) =>
    r.map((cell, i) => clipToWidth(cell, widths[i] ?? 0).padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  lines.push(fmt(cols));
  lines.push(separator);
  for (const r of rows) lines.push(fmt(r));
  lines.push(separator);
  lines.push(fmt(totalsRow));
  // One footnote under the table when any custom loop exists — explains the asterisk without
  // taking a column. Absent (byte-identical table) on a fleet with no user-defined loops.
  if (snap.loops.some((l) => l.custom)) lines.push("* user-defined loop");
  // The header line (and any residual overflow past the columns' minimums) is clipped too,
  // so no status line ever wraps in a terminal of `maxWidth` columns.
  const finished = lines.join("\n");
  if (maxWidth === undefined) return finished;
  return finished
    .split("\n")
    .map((line) => clipToWidth(line, maxWidth))
    .join("\n");
}
