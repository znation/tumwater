import fs from "node:fs";
import path from "node:path";
import type { LoopState } from "./types.js";
import { loadConfig } from "./config.js";
import { loadLoopState } from "./state.js";
import { inboxSize } from "./inbox.js";
import { orchestratorAlive, readOrchestratorInfo } from "./orchestrator.js";
import { automatonDir } from "./paths.js";
import { readLiveProgress } from "./progress.js";

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  loops: LoopState[];
}

export function snapshot(root: string): StatusSnapshot {
  const config = loadConfig(root);
  const roles = Object.entries(config.roles)
    .filter(([, rc]) => rc.enabled)
    .map(([id]) => id);
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

/** Render the status table shared by `automaton status` and the TUI. */
export function renderStatus(root: string, snap: StatusSnapshot): string {
  const name = path.basename(path.resolve(root));
  const lines: string[] = [];
  const header = snap.running ? `running (pid ${snap.pid})` : "not running — start with `automaton run`";
  lines.push(`automaton · ${name} · ${header}${snap.inbox ? ` · inbox: ${snap.inbox}` : ""}`);
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
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  lines.push(fmt(cols));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) lines.push(fmt(r));
  return lines.join("\n");
}

export function projectInitialized(root: string): boolean {
  return fs.existsSync(path.join(root, "automaton.json")) || fs.existsSync(automatonDir(root));
}
