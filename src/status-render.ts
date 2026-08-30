import path from "node:path";
import { DIRECTOR_ROLE } from "./roles.js";
import type { LoopState } from "./types.js";
import type { StatusSnapshot } from "./status.js";
import { readLiveProgress } from "./progress.js";
import { compactTokens } from "./text.js";

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
 * The GUI renders the same absolute stamp (without the relative age) from its own JS copy —
 * formatting at each surface, per the fmtTokens precedent. */
export function lastTickCell(ts: number | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  let s = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (Date.now() - ts > 86_400_000) s = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${s}`;
  return `${s} · ${ago(ts)}`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
}

/** The state cell for a working loop: elapsed · turns · live context · current tool. */
export function workingDetail(root: string, s: LoopState): string {
  const live = readLiveProgress(root, s.role);
  const elapsed = s.lastTickStartedAt ? duration(Date.now() - s.lastTickStartedAt) : "";
  if (!live) return `working ${elapsed}`.trim();
  const parts = [`working ${elapsed}`.trim(), `turn ${live.turns + 1}`];
  if (live.contextTokens > 0) parts.push(`ctx ${compactTokens(live.contextTokens)}`);
  if (live.lastTool) parts.push(live.lastTool);
  // Silence under five minutes is normal (slow local-model prefills, long tool calls);
  // only flag a stall once at least five minutes have passed without any pi output.
  if (live.quietMs >= 300_000) parts.push(`no pi output for ${duration(live.quietMs)}`);
  return parts.join(" · ");
}

/** Human label of where a loop is in its cycle (stopped / working / waiting for prompts /
 * sleeping / queued). Pass `root` so an in-flight tick expands into live detail
 * (elapsed · turn · ctx · tool); without it a working loop shows plain "working".
 * `budgetPaused` marks the fleet's daily cost budget as reached: idle role loops show
 * `budget paused` instead of their sleep/queue state — that is why they are not ticking. */
export function loopPhase(
  s: LoopState,
  orchestratorRunning: boolean,
  root?: string,
  budgetPaused = false,
): string {
  if (!orchestratorRunning) return "stopped";
  if (s.running) {
    // The tick's work is committed and under adversarial review: the live log tail now
    // describes the reviewer run, not the author's — show the gate instead of pi detail.
    if (s.phase === "review") {
      const elapsed = s.lastTickStartedAt ? duration(Date.now() - s.lastTickStartedAt) : "";
      return `reviewing ${elapsed}`.trim();
    }
    // In-flight ticks finish even while the budget is paused — only NEW ticks are blocked,
    // so a running loop keeps its live detail.
    return root ? workingDetail(root, s) : "working";
  }
  if (s.role === DIRECTOR_ROLE) return "waiting for prompts"; // exempt from the cap
  if (budgetPaused) return "budget paused";
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
 * and never re-saved. */
export function displayTokenMetrics(root: string, s: LoopState): { generated: number; peakCtx: number } {
  const live = s.running ? readLiveProgress(root, s.role) : null;
  return {
    generated: s.generatedTokens + (live?.outputTokens ?? 0),
    peakCtx: Math.max(s.peakContextTokens, live?.peakContextTokens ?? 0),
  };
}

/** The table's state cell: loopPhase's label, with the current work item prepended while a
 * tick is in flight ("implement plan X · working 3m · turn 2"). Prepending — not appending —
 * so the item survives ellipsis clipping on narrow terminals; the live detail after it is what
 * gets clipped first. Idle loops are untouched: their log tail describes a finished tick and
 * must not leak its work item into the state cell. (The GUI shows the same item in its own
 * `current` column instead, so its state cell stays clean.) */
function stateCell(root: string, s: LoopState, orchestratorRunning: boolean, budgetPaused = false): string {
  const phase = loopPhase(s, orchestratorRunning, root, budgetPaused);
  // While under review the log tail's "current work" is the reviewer's own output, not the
  // author's task — show the bare gate label.
  if (!s.running || s.phase === "review") return phase;
  const work = readLiveProgress(root, s.role)?.currentWork;
  return work ? `${work} · ${phase}` : phase;
}

/** Truncate to `width` with a trailing ellipsis when over. The result never exceeds
 * `width` characters (even at width ≤ 1), so clipped lines cannot wrap in a terminal of
 * that many columns. Shared by the status table and the TUI's line rendering. */
export function clipToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + "…";
}

/** Columns allowed to shrink when the table is wider than the terminal, widest offender
 * first: `last result` (holds the tick summary), then `state` (live working detail), then
 * `last tick` — it shrinks last so on a narrow terminal it loses " · 3m ago" before whole
 * lines clip; its minimum is a bare HH:MM:SS. Indices are positional in the `cols` array
 * below — renumber when columns change. */
const FLEXIBLE_COLUMNS: Array<{ index: number; minWidth: number }> = [
  { index: 8, minWidth: 12 },
  { index: 1, minWidth: 12 },
  { index: 7, minWidth: 10 },
];
const COLUMN_GAP = 2;

/** Render the status table shared by `tumwater status` and the TUI. When `maxWidth` is
 * given, wide cells are clipped so no line exceeds it (terminal rows never wrap). */
/** The budget cap for display: whole dollars stay bare ($50), fractional ones keep their
 * cents ($12.34) — the badge reads `· budget: $12.34/$50 today`. */
function usdCap(n: number): string {
  return `$${n.toFixed(2).replace(/\.00$/, "")}`;
}

export function renderStatus(root: string, snap: StatusSnapshot, maxWidth?: number): string {
  const name = path.basename(path.resolve(root));
  const lines: string[] = [];
  const header = snap.running ? `running (pid ${snap.pid})` : "not running — start with `tumwater run`";
  // The questions badge (like the inbox one) appears only when something needs an answer.
  // The budget badge is standing information for a money-spending system, so it shows at all
  // levels while enabled (absent when disabled); on narrow terminals the header's existing
  // last-resort whole-line clipping applies.
  lines.push(
    `tumwater · ${name} · ${header}${snap.inbox ? ` · inbox: ${snap.inbox}` : ""}${
      snap.questions ? ` · questions: ${snap.questions}` : ""
    }${snap.budget ? ` · budget: $${snap.budget.spentUsd.toFixed(2)}/${usdCap(snap.budget.capUsd)} today` : ""}`,
  );
  lines.push("");
  const cols = ["loop", "state", "ticks", "commits", "gen", "peak ctx", "cost", "last tick", "last result"];
  // The budget gate is fleet-wide (plans/daily-cost-budget.md): when today's spend has
  // reached the cap, every idle role loop shows `budget paused` in its state cell.
  const budgetPausedNow = snap.budget !== null && snap.budget.spentUsd >= snap.budget.capUsd;
  const withMetrics = snap.loops.map((s) => ({ s, m: displayTokenMetrics(root, s) }));
  const rows = withMetrics.map(({ s, m }) => [
    s.role,
    stateCell(root, s, snap.running, budgetPausedNow),
    String(s.ticks),
    String(s.commits),
    compactTokens(m.generated),
    compactTokens(m.peakCtx),
    `$${s.totalCostUsd.toFixed(2)}`,
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
    `$${snap.loops.reduce((sum, s) => sum + s.totalCostUsd, 0).toFixed(2)}`,
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
  // The header line (and any residual overflow past the columns' minimums) is clipped too,
  // so no status line ever wraps in a terminal of `maxWidth` columns.
  const finished = lines.join("\n");
  if (maxWidth === undefined) return finished;
  return finished
    .split("\n")
    .map((line) => clipToWidth(line, maxWidth))
    .join("\n");
}
