import path from "node:path";
import type { LoopState } from "./types.js";
import { enabledRoleIds, loadConfig } from "./config.js";
import { loadLoopState } from "./state.js";
import { inboxSize } from "./inbox.js";
import { orchestratorAlive, readOrchestratorInfo } from "./orchestrator.js";
import { readLiveProgress } from "./progress.js";

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  loops: LoopState[];
}

export function snapshot(root: string): StatusSnapshot {
  const config = loadConfig(root);
  const roles = enabledRoleIds(config);
  const info = readOrchestratorInfo(root);
  return {
    running: orchestratorAlive(root),
    pid: info?.pid,
    inbox: inboxSize(root),
    loops: roles.map((r) => loadLoopState(root, r)),
  };
}

function ago(ts: number | undefined): string {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function inFuture(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`;
}

function tokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The state cell for a working loop: elapsed · turns · live context · current tool. */
export function workingDetail(root: string, s: LoopState): string {
  const live = readLiveProgress(root, s.role);
  const elapsed = s.lastTickStartedAt ? duration(Date.now() - s.lastTickStartedAt) : "";
  if (!live) return `working ${elapsed}`.trim();
  const parts = [`working ${elapsed}`.trim(), `turn ${live.turns + 1}`];
  if (live.contextTokens > 0) parts.push(`ctx ${tokens(live.contextTokens)}`);
  if (live.lastTool) parts.push(live.lastTool);
  if (live.quietMs > 120_000) parts.push(`no pi output for ${duration(live.quietMs)}`);
  return parts.join(" · ");
}

export function loopPhase(s: LoopState, orchestratorRunning: boolean, root?: string): string {
  if (!orchestratorRunning) return "stopped";
  if (s.running) return root ? workingDetail(root, s) : "working";
  if (s.role === "director") return "waiting for prompts";
  if (s.nextRunAt > Date.now()) return `sleeping (${inFuture(s.nextRunAt)})`;
  return "queued";
}

/** Truncate to `width` with a trailing ellipsis when over. The result never exceeds
 * `width` characters (even at width ≤ 1), so clipped lines cannot wrap in a terminal of
 * that many columns. Shared by the status table and the TUI's line rendering. */
export function clipToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + "…";
}

/** Columns allowed to shrink when the table is wider than the terminal, widest offender
 * first: `last result` (holds the tick summary), then `state` (live working detail). */
const FLEXIBLE_COLUMNS: Array<{ index: number; minWidth: number }> = [
  { index: 7, minWidth: 12 },
  { index: 1, minWidth: 12 },
];
const COLUMN_GAP = 2;

/** Render the status table shared by `tumwater status` and the TUI. When `maxWidth` is
 * given, wide cells are clipped so no line exceeds it (terminal rows never wrap). */
export function renderStatus(root: string, snap: StatusSnapshot, maxWidth?: number): string {
  const name = path.basename(path.resolve(root));
  const lines: string[] = [];
  const header = snap.running ? `running (pid ${snap.pid})` : "not running — start with `tumwater run`";
  lines.push(`tumwater · ${name} · ${header}${snap.inbox ? ` · inbox: ${snap.inbox}` : ""}`);
  lines.push("");
  const cols = ["loop", "state", "ticks", "commits", "tokens", "cost", "last tick", "last result"];
  const rows = snap.loops.map((s) => [
    s.role,
    loopPhase(s, snap.running, root),
    String(s.ticks),
    String(s.commits),
    String(s.totalTokens),
    `$${s.totalCostUsd.toFixed(2)}`,
    ago(s.lastTickEndedAt),
    s.lastResult ? `${s.lastResult}${s.lastSummary ? ` — ${s.lastSummary}` : ""}` : "-",
  ]);
  const totalsRow = [
    "total",
    "",
    "",
    "",
    tokens(snap.loops.reduce((sum, s) => sum + s.totalTokens, 0)),
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
