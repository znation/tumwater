/** Shared fixtures for the status UI tests (status-render.test.ts, status-model.test.ts):
 * the snapshot/table geometry builders, pi-log writers, and time stamps both suites assemble
 * their StatusSnapshots and logs from. Split out of status-render.test.ts when the status-model
 * suite moved to its own file, so the two halves cannot drift (one fixture, two surfaces). */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import type { StatusSnapshot } from "../src/ui/status.js";
import { applyTickOutcome, freshLoopState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { landWorktreePath, piLogPath } from "../src/paths.js";

export const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

/** A session event for a review-gate run: pi stamps the worktree it started in, and the
 * gate's runs start in the role's `_land-<role>` lander worktree — the discriminator the
 * live-progress reader keys on (BUGS.md 2026-09-22). */
export const GATE_SESSION = (root: string, role: string) =>
  JSON.stringify({ type: "session", version: 3, id: "x", cwd: landWorktreePath(root, role) });

/** Write a raw pi log for `role` under `root`; returns the file path. */
export function writePiLog(root: string, role: string, lines: string[]): string {
  const file = piLogPath(root, role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// The default is the default config's enabled cap with no spend — the badge renders in
// every render now (standing information + edit affordance), and 0 < 50 keeps budgetReached
// false so phase assertions are unaffected by the default.
export const DEFAULT_BUDGET: StatusSnapshot["budget"] = { spentUsd: 0, capUsd: 50, free: false, fallback: null };

export function snapshotWith(
  loops: Array<Partial<ReturnType<typeof freshLoopState>> & { role: string; custom?: boolean }>,
  budget: StatusSnapshot["budget"] = DEFAULT_BUDGET,
  paused = false,
  pausedRoles: string[] = [],
  roleInbox: Record<string, number> = {},
): StatusSnapshot {
  return {
    running: false,
    inbox: 0,
    inboxPrompts: [],
    // The fixture's queues are empty by default; a test passes per-role counts to exercise
    // the `p:N` state marker (PLANS.md "Per-role prompts 2/2").
    roleInbox,
    questions: 0,
    // `custom` is display-only metadata snapshot() computes per row; the fixture defaults it
    // to false so existing all-built-in tables stay byte-identical.
    loops: loops.map((partial) => ({ ...freshLoopState(partial.role), ...partial, custom: partial.custom ?? false })),
    budget,
    paused,
    pausedRoles,
    build: null,
    // The fixture's queue is idle: depth 0 keeps every existing header line byte-identical
    // (the 4/5 badge is empty at depth 0) and renders no in-flight label.
    landQueue: { depth: 0 },
  };
}

/** A rendered status table's geometry: the separator line (index 3) holds one dash run per
 * column at its exact width, so a column is named by position and read by slicing rows at
 * those offsets — padded header cells and two-space gaps make a text split unreliable.
 * `headers` holds the header line's labels in the same positions. Shared by every test that
 * reads a table cell by column name. */
export function tableCells(out: string): {
  lines: string[];
  widths: number[];
  cellAt: (row: string, i: number) => string;
  headers: string[];
} {
  const lines = out.split("\n");
  const widths = (lines[3] ?? "").split("  ").map((seg) => seg.length);
  const cellAt = (row: string, i: number): string => {
    let start = 0;
    for (let j = 0; j < i; j++) start += (widths[j] ?? 0) + 2;
    return row.slice(start, start + (widths[i] ?? 0)).trim();
  };
  return { lines, widths, cellAt, headers: widths.map((_, i) => cellAt(lines[2] ?? "", i)) };
}

export function stampOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}


export function toolStart(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName, args });
}

export const PENDING_SHA = "b".repeat(40);

/** The rendered row for `role`, trailing padding trimmed: its last cell is "last result". */
export function rowOf(out: string, role: string): string {
  const row = out.split("\n").find((l) => l.startsWith(`${role} `));
  assert.ok(row, `a row for ${role}`);
  return row.trimEnd();
}


export function pendingFeature(): ReturnType<typeof freshLoopState> {
  const s = freshLoopState("feature");
  applyTickOutcome(s, defaultConfig(), "feature", { result: "refused", summary: "objected to the plan" });
  applyTickOutcome(s, defaultConfig(), "feature", { result: "queued", summary: "add the widget", commit: PENDING_SHA });
  return s;
}

