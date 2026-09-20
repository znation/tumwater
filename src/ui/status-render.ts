import path from "node:path";
import type { LoopState } from "../types.js";
import type { StatusSnapshot } from "./status.js";
import { budgetGate, dailyCost, fleetDailyCost, budgetReached } from "../budget.js";
import { readLiveProgress, type LiveProgress } from "./progress.js";
import { clipToWidth, compactTokens, formatTime, pad2, usd } from "../text.js";
import {
  buildBadge,
  budgetBadge,
  displayTokenMetrics,
  humanSeconds,
  landingBadge,
  landingForRole,
  loopPhase,
} from "./status-model.js";

/** The status RENDER layer: time/token cell formatters and the width-aware table shared by
 * `tumwater status` and the TUI. The labels, badges, and metrics it draws come from the shared
 * display model (status-model.ts); this module decides column widths and layout. Depends on
 * status.ts one way — rendering reads the snapshot; it never collects fleet state itself
 * (live tick detail is display-only). */

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
