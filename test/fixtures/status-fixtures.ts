/** Shared fixtures for the status UI tests (status-render.test.ts, status-model.test.ts):
 * the snapshot/table geometry builders, pi-log writers, and time stamps both suites assemble
 * their StatusSnapshots and logs from, plus the header-line extractor the badge suites read. Split
 * out of status-render.test.ts when the status-model
 * suite moved to its own file, so the two halves cannot drift (one fixture, two surfaces). */
import assert from "node:assert/strict";
import path from "node:path";
import type { StatusSnapshot } from "../../src/status/status-data.js";
import { freshRunnerState } from "../../src/runner/runner-state.js";
import { applyRunOutcome } from "../../src/run/run-apply.js";
import { defaultConfig } from "../../src/config/config.js";
import { piLogPath, worktreesDir } from "../../src/paths.js";
import { writeLogLines } from "./log-fixtures.js";
import { clockOf } from "../helpers/oracles.js";

export const SESSION = JSON.stringify({ type: "session", version: 3, id: "x" });

/** A session event for a review-gate run: pi stamps the worktree it started in, and the
 * gate's legacy runs start in the role's `_land-<role>` lander worktree — the discriminator
 * the live-progress reader keys a session with no kind marker on (BUGS.md 2026-09-22). */
export const GATE_SESSION = (root: string, role: string) =>
  JSON.stringify({ type: "session", version: 3, id: "x", cwd: path.join(worktreesDir(root), `_land-${role}`) });

/** A rendered status table's header line (its first line) — what the badge suites assert
 * against, since every badge rides that line. renderStatus always emits the header, so the
 * empty-string fallback is unreachable in practice; a suite reading an empty render gets an
 * empty header and a failing match instead of a crash. */
export function headerOf(rendered: string): string {
  return rendered.split("\n")[0] ?? "";
}

/** Write a raw pi log for `role` under `root`; returns the file path. */
export function writePiLog(root: string, role: string, lines: string[]): string {
  const file = piLogPath(root, role);
  writeLogLines(file, lines);
  return file;
}

// The default is the default config's enabled cap with no spend — the badge renders in
// every render now (standing information + edit affordance), and 0 < 50 keeps budgetReached
// false so phase assertions are unaffected by the default.
export const DEFAULT_BUDGET: StatusSnapshot["budget"] = {
  spentUsd: 0,
  capUsd: 50,
  capHitAt: null,
  free: false,
  fallback: null,
};

export function snapshotWith(
  roles: Array<
    Partial<ReturnType<typeof freshRunnerState>> & {
      role: string;
      custom?: boolean;
      /** The model-fallback episode tag (status-data's active-episode row field), which a
       * literal RunnerState does not carry — a test passes it to exercise the `on fallback`
       * name-cell suffix. */
      fallback?: StatusSnapshot["roles"][number]["fallback"];
      /** The role's image-input surface (plans/image-input.md "Surfaces", part 5/5), which
       * a literal RunnerState does not carry — a test passes it to exercise the images alert. */
      imageInput?: boolean | null;
      /** The role's declared context window (part 3c/…), which a literal RunnerState does
       * not carry — a test passes it to exercise the `peak ctx` share cell. */
      contextWindow?: number;
    }
  >,
  budget: StatusSnapshot["budget"] = DEFAULT_BUDGET,
  paused = false,
  pausedRoles: string[] = [],
  roleInbox: Record<string, number> = {},
  // The per-role cap's held roles default to none — existing tables stay byte-identical; a
  // test passes roles to exercise the `cap paused` cell (status-model/render tests).
  capPaused: string[] = [],
  // The per-tier budget pause's held roles default to none — existing tables stay
  // unchanged; a test passes roles to exercise the `budget paused` cell (part 5c/8).
  budgetPausedRoles: string[] = [],
  // The per-role quiet windows' held roles default to none — existing tables stay
  // unchanged; a test passes role → window pairs to exercise the `quiet until` cell.
  roleQuietPaused: Record<string, string> = {},
  // The new-project bootstrap's held roles and progress default to off — existing tables and
  // headers stay byte-identical; a test passes them to exercise `held: bootstrap` and the
  // progress badge (plans/work-ratio.md, part 2/2).
  bootstrapHeld: string[] = [],
  bootstrap?: StatusSnapshot["bootstrap"],
  // The maintenance allowance defaults to an open gate with no window data — existing tables
  // stay byte-identical; a test passes figures and held roles to exercise the
  // `held: maintenance quota <used>/<allowance>` cell (plans/work-ratio.md, part 1b/4).
  maintenanceQuota: StatusSnapshot["maintenanceQuota"] = { allowance: 0, used: 0, held: [] },
): StatusSnapshot {
  return {
    running: false,
    inbox: 0,
    inboxPrompts: [],
    // The fixture's queues are empty by default; a test passes per-role counts to exercise
    // the `p:N` state marker. With no previews there are
    // no cancel addresses and no per-role rows either.
    inboxFiles: [],
    inboxQueuedAt: [],
    inboxNotBefore: [],
    roleInboxPrompts: {},
    roleInbox,
    questions: 0,
    // `custom` is display-only metadata snapshot() computes per row; the fixture defaults it
    // to false so existing all-built-in tables stay byte-identical.
    roles: roles.map((partial) => ({
      ...freshRunnerState(partial.role),
      ...partial,
      custom: partial.custom ?? false,
      // The image-input surface (plans/image-input.md "Surfaces", part 5/5) is always
      // present; the fixture defaults a row that does not name one to `unknown` so existing
      // tables stay byte-identical (no images alert, no Images line change).
      imageInput: partial.imageInput ?? null,
    })),
    budget,
    paused,
    pausedRoles,
    pausedRunners: pausedRoles,
    capPaused,
    bootstrapHeld,
    maintenanceQuota,
    ...(bootstrap ? { bootstrap } : {}),
    budgetPausedRoles,
    roleQuietPaused,
    // Part 3a/9: the per-backend free-ness answer defaults to false (a fixture without a
    // window block reads as a paying team), matching the unconditional snapshot field.
    subscriptionOnly: false,
    // Quiet hours default to off — no window, not inside one — so existing header
    // assertions stay byte-identical; a test sets quietHours/inQuietHours to exercise the
    // badge (status-header.test.ts).
    inQuietHours: false,
    build: null,
    // The fixture's queue is idle: depth 0 keeps every existing header line byte-identical
    // (the 4/5 badge is empty at depth 0) and renders no in-flight label.
    mergeQueue: { depth: 0 },
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

/** Local wall clock `HH:MM:SS` of an epoch-ms instant — the stamp the per-cell suites compare
 * lastRunCell's absolute half against. Built by oracles.ts's raw-parts clockOf, so it stays
 * independent of datetime.ts's formatTime. */
export function stampOf(ts: number): string {
  return clockOf(new Date(ts));
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

export function pendingFeature(): ReturnType<typeof freshRunnerState> {
  const s = freshRunnerState("feature");
  applyRunOutcome(s, defaultConfig(), "feature", { result: "refused", summary: "objected to the plan" });
  applyRunOutcome(s, defaultConfig(), "feature", { result: "queued", summary: "add the widget", commit: PENDING_SHA });
  return s;
}
