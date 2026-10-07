import type { LoopState } from "../loop/loop-state.js";
import type { StatusSnapshot } from "../status/status-data.js";
import { dailyCost } from "../budget/budget.js";
import type { LiveProgress } from "./progress-data.js";
import { clipToWidth, displayWidth } from "../text/text-width.js";
import { compactTokens, usd } from "../text/format.js";
import { elapsedSeconds, formatTime, humanSeconds, pad2, secondsUntil } from "../text/datetime.js";
import { projectName } from "../project-name.js";
import { buildBadge, budgetBadge, landingBadge, mainCheckBadge, mainCheckVerdict, pauseBadge, quietBadge } from "./badges.js";
import { isActivePhase, loopRowCells, sortLoopsByState } from "./status-model.js";
import { tickProgress } from "./tick-progress-model.js";
import { yieldMultiplierFor } from "../scheduling/backoff.js";
import { phaseTone, resultTone, type Tone } from "./tone.js";

/** The status RENDER layer: time/token cell formatters and the width-aware table shared by
 * `tumwater status` and the TUI. The labels, badges, and metrics it draws come from the shared
 * display model (status-model.ts); this module decides column widths and layout. Depends on
 * status/status-data.ts one way — rendering reads reads the snapshot; it never collects fleet state itself
 * (live tick detail is display-only). */

function ago(ts: number | undefined): string {
  if (!ts) return "-";
  const s = elapsedSeconds(ts);
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

/** The table's `next run` cell: when the loop may tick again, or `-` when that is not the
 * operator's question — a loop in flight (an active rendered phase: working/reviewing/landing,
 * or `s.running`) has no next run to speak of, and a stopped fleet renders no schedule at all
 * (its `nextRunAt`s are stale leftovers, not plans). A due idle loop reads `now`; a future one
 * reads its remaining time through humanSeconds (the same bucketing the sleeping phase label
 * uses, so the two cannot drift), prefixed `backoff ` while `backoffSeconds > 0` — the wake
 * row-action clears exactly that, so the prefix is what makes waking meaningful. The GUI
 * renders the same rules from its own JS copy in gui-client.ts (fmtNextRun). The `phase` and
 * `fleetRunning` arguments come from the caller because neither fact lives on LoopState: the
 * active-phase check needs the rendered label (a landing is visible only there), and the
 * fleet's running flag lives on the snapshot, not the loop. */
export function nextRunCell(s: LoopState, phase: string, now: number, fleetRunning: boolean): string {
  if (!fleetRunning || s.running || isActivePhase(phase)) return "-";
  const remain = secondsUntil(s.nextRunAt, now);
  // The yield multiplier rides the cell as `×N` (yield-scaled clocks, PLANS.md): a scalable
  // role whose recent ticks landed nothing keeps a longer effective gap than nextRunAt's
  // countdown shows, and the suffix is what makes that visible. The multiplier gates the
  // scheduled gap and the main-moved wake in isEligible, so a `now`-due cell at ×4 is a
  // role waiting out its stretched gap, not a broken clock.
  const mult = yieldMultiplierFor(s);
  const suffix = mult > 1 ? ` ×${mult}` : "";
  if (remain <= 0) return `now${suffix}`;
  const label = humanSeconds(remain);
  return (s.backoffSeconds > 0 ? `backoff ${label}` : label) + suffix;
}

/** The table's state cell: a loop's phase label (loopPhase, computed once per row by
 * renderStatus so the same label drives the row order), with the current work item prepended
 * while a tick is in flight ("implement plan X · working 3m · turn 2"). Prepending — not
 * appending — so the item survives ellipsis clipping on narrow terminals; the live detail
 * after it is what gets clipped first. Idle loops are untouched: their log tail describes a
 * finished tick and must not leak its work item into the state cell. (The GUI shows the same
 * item in its own `current` column instead, so its state cell stays clean.) */
function stateCell(root: string, s: LoopState, phase: string, live?: LiveProgress | null): string {
  // While under review the log tail's "current work" is the reviewer's own output, not the
  // author's task — don't prepend it; the phase cell already carries the reviewer's live
  // detail. The landing label rides the same guard: the landing role is not running, so its
  // phase ("landing <elapsed> · <stage>", with the reviewer's live detail while it reviews)
  // is returned without a work-item prefix.
  if (!s.running || s.parkedSince || s.phase === "review") return phase;
  const p = tickProgress(root, s, live);
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

/** A run of text on a status line, with the tone it may be drawn in (tone.ts's Tone, or
 * "brand" / "bold" for the header's name and the totals). Plain renderings join the text and
 * ignore the tone; the TUI colors each toned span. */
export interface StatusSpan {
  text: string;
  tone?: Tone | "brand" | "bold";
}

/** One status line as spans. */
export type StatusLine = StatusSpan[];

const plainText = (line: readonly StatusSpan[]): string => line.map((s) => s.text).join("");

/** Clip a line of spans to `width` display columns exactly as clipToWidth clips its joined text
 * (same cut, same ellipsis), keeping each surviving span's tone — so coloring a line never
 * changes where it is cut, and escape codes are never counted as columns. */
export function clipSpans(line: readonly StatusSpan[], width: number): StatusSpan[] {
  const joined = plainText(line);
  const clipped = clipToWidth(joined, width);
  if (clipped === joined) return [...line];
  const ellipsis = width > 1; // clipToWidth spends one column on "…" whenever it can
  let keep = clipped.length - (ellipsis ? 1 : 0);
  const out: StatusSpan[] = [];
  for (const span of line) {
    if (keep <= 0) break;
    const text = span.text.slice(0, keep);
    keep -= text.length;
    out.push({ ...span, text });
  }
  if (ellipsis) {
    const last = out[out.length - 1];
    if (last) out[out.length - 1] = { ...last, text: `${last.text}…` };
    else out.push({ text: "…" });
  }
  return out;
}

/** A header badge (" · land queue: 2", ", build abc…") as a plain separator plus its toned
 * words, so the TUI colors the words and not the dots. Empty badges add nothing. */
function badgeSpans(badge: string, tone?: StatusSpan["tone"]): StatusSpan[] {
  if (!badge) return [];
  const sep = /^(?: · |, )/.exec(badge)?.[0] ?? "";
  return [{ text: sep }, { text: badge.slice(sep.length), ...(tone ? { tone } : {}) }];
}

/** The daily budget badge's tone: yellow from 85% of the cap, red once it is spent. */
function budgetTone(budget: StatusSnapshot["budget"]): Tone | undefined {
  if (budget.free || !(budget.capUsd > 0)) return undefined;
  const share = budget.spentUsd / budget.capUsd;
  return share >= 1 ? "red" : share >= 0.85 ? "yellow" : undefined;
}

/** The loop facts one status render computed, for callers that build more on them (the TUI's
 * attention lines): each loop's rendered phase, whether it is in flight, its last error. */
interface StatusLoopRow {
  role: string;
  phase: string;
  inFlight: boolean;
  lastError?: string;
}

/** Render the status table shared by `tumwater status` and the TUI as lines of toned spans,
 * plus the per-loop facts it computed (see StatusLoopRow). When `maxWidth` is given, wide cells
 * are clipped so no line exceeds it (terminal rows never wrap). */
export function renderStatusSpans(
  root: string,
  snap: StatusSnapshot,
  maxWidth?: number,
): { lines: StatusLine[]; loops: StatusLoopRow[] } {
  const name = projectName(root);
  const lines: StatusLine[] = [];
  // One clock read per render, shared by the timed-pause badge's countdown and every row's
  // next-run cell — a per-site Date.now() could tick over between them and disagree with
  // itself.
  const now = Date.now();
  // The questions badge (like the inbox one) appears only when something needs an answer.
  // The budget badge is standing information for a money-spending system in EVERY cap state
  // (disabled reads `· no cap` — and it is the affordance for editing the cap); on narrow
  // terminals the header's existing last-resort whole-line clipping applies. A fleet whose
  // models are all free reads n/a — spend can never accumulate against a cap that cannot be
  // reached, so a dollar figure would mislead. The timed-pause badge (plans/pause-countdown
  // wording) rides last so a fleet under a timed pause reads how long until it comes back —
  // empty unless the fleet marker's deadline stands in the future, so a role-only or
  // indefinite pause keeps today's header byte-identical.
  const running: StatusSpan[] = snap.running
    ? [{ text: "running", tone: "green" }, { text: ` (pid ${snap.pid}` }, ...badgeSpans(buildBadge(snap.build), snap.build?.stale ? "yellow" : undefined), { text: ")" }]
    : [{ text: "not running — start with `tumwater run`", tone: "dim" }];
  lines.push([
    { text: "tumwater", tone: "brand" },
    { text: ` · ${name} · ` },
    ...running,
    ...badgeSpans(landingBadge(snap.landQueue), "blue"),
    ...(snap.inbox ? [{ text: ` · inbox: ${snap.inbox}` }] : []),
    ...(snap.questions ? badgeSpans(` · questions: ${snap.questions}`, "magenta") : []),
    ...badgeSpans(budgetBadge(snap.budget), budgetTone(snap.budget)),
    ...badgeSpans(mainCheckBadge(snap.mainCheck), snap.mainCheck
      // The helper's tone is string (the GUI's palette differs); with a Tone fallback here
      // every branch is a Tone, so the cast cannot widen the value.
      ? mainCheckVerdict(snap.mainCheck.status, "yellow").tone as Tone
      : undefined),
    ...badgeSpans(pauseBadge(snap.pausedUntil, now, snap.pauseReason), "yellow"),
    // Quiet hours 2/2 rides the header last: the window as standing information whenever it
    // is configured, the yellow `quiet until <end>` reading while the hold is on — the same
    // ask-me-nothing informality the pause badge's countdown uses, without stealing its
    // urgency. Unset keeps the header byte-identical (the badge is empty).
    ...badgeSpans(quietBadge(snap.quietHours, snap.inQuietHours), snap.inQuietHours ? "yellow" : undefined),
  ]);
  lines.push([]);
  // `today` is the loop's daily budget window (dailyCost): $0.00 while its stamp is stale
  // or missing, so loops that never ticked — or last ticked yesterday — read zero without a
  // save. It renders whether or not the cap is enabled: spend observability does not depend
  // on it.
  // `next run` is appended last and never flexible (a short fixed-width cell like `today`):
  // FLEXIBLE_COLUMNS' positional indices above stay untouched when columns change.
  const cols = ["loop", "state", "ticks", "commits", "gen", "peak ctx", "cost", "today", "last tick", "last result", "next run"];
  // One live tail read per running loop per frame, threaded through every cell that shows
  // in-flight detail (metrics, state, current work) — each helper used to re-read the log on
  // its own, up to three stats + reads per loop per second. The phase is computed once per
  // row (in loopRowCells, shared with the GUI payload) and carried on the row: the same
  // label drives the state cell and the shared row order (sortLoopsByState).
  // Per-role prompts 2/2 — a loop with queued prompts carries a small `p:N` marker on its
  // state cell (appended, so the work-item prefix survives clipping ahead of it), telling the
  // operator steering one loop that something is waiting for it.
  const roleQueued = (role: string): string => {
    const n = snap.roleInbox[role] ?? 0;
    return n > 0 ? ` p:${n}` : "";
  };
  const withMetrics = snap.loops.map((s) => {
    // loopRowCells single-homes the per-loop tail read + metrics + phase derivation the GUI
    // payload (status-payload.ts) repeats, so the two dashboards cannot drift apart.
    const cells = loopRowCells(snap, root, s);
    return {
      s,
      m: { generated: cells.generated, peakCtx: cells.peakCtx },
      live: cells.live,
      phase: cells.phase,
      role: s.role,
      lastTickEndedAt: s.lastTickEndedAt,
    };
  });
  // User-defined loops (snapshot's `custom` flag) get an asterisk beside their name — the
  // dashboards' at-a-glance marker. The name column (index 0) is not in FLEXIBLE_COLUMNS and
  // its width derives from row content, so the extra character widens it automatically.
  // Rows are ordered by the shared display rule (status-model's loopRank, then last tick most
  // recent first) so the TUI/status table groups loops the way the GUI table does.
  // Each cell is spans: the state cell takes its phase's tone (the p:N marker stays plain), the
  // last result tones its outcome word, a backoff countdown reads yellow.
  const cell = (text: string, tone?: StatusSpan["tone"]): StatusSpan[] => [{ text, ...(tone ? { tone } : {}) }];
  const rows = sortLoopsByState(withMetrics).map(({ s, m, live, phase }): StatusSpan[][] => {
    // The name cell appends the selector the role resolves to; with a top-level tier map
    // declared it additionally names the seam tier (model-tiers.md part 7a,
    // "Observability"). No model resolved and no tier keeps the name byte-identical to
    // today's.
    const modelSuffix = s.modelTier
      ? ` (${s.modelTier}${s.model ? ` · ${s.model}` : ""})`
      : s.model
        ? ` (${s.model})`
        : "";
    // Model failure fallback, part 2/2: while the loop runs off-model its name cell says so,
    // so the operator can see which loops the fallback pair is carrying without reading logs.
    const fallbackSuffix = s.fallback ? " (on fallback)" : "";
    const name = (s.custom ? `${s.role}*` : s.role) + modelSuffix + fallbackSuffix;
    const state = stateCell(root, s, phase, live);
    const tone = phaseTone(phase);
    // The whole state cell carries the phase's tone: a work item leads the cell (so it
    // survives clipping), and clipping often leaves only it — the color still tells the state.
    const stateSpans: StatusSpan[] = [{ text: state, ...(tone ? { tone } : {}) }];
    const next = nextRunCell(s, phase, now, snap.running);
    const resultT = resultTone(s.lastResult);
    return [
      cell(name),
      // Merge queue 4/5 — the landing role's phase label (the marker-driven record, filtered to
      // this role by loopPhase's `landing` argument above) rides this same phase string.
      [...stateSpans, { text: roleQueued(s.role) }],
      cell(String(s.ticks)),
      cell(String(s.commits)),
      cell(compactTokens(m.generated)),
      cell(compactTokens(m.peakCtx)),
      cell(usd(s.totalCostUsd)),
      cell(usd(dailyCost(s))),
      cell(lastTickCell(s.lastTickEndedAt)),
      s.lastResult
        ? [{ text: s.lastResult, ...(resultT ? { tone: resultT } : {}) }, { text: s.lastSummary ? ` — ${s.lastSummary}` : "" }]
        : cell("-"),
      cell(next, next.startsWith("backoff") ? "yellow" : undefined),
    ];
  });
  const totalsRow: StatusSpan[][] = [
    "total",
    "",
    "",
    "",
    compactTokens(withMetrics.reduce((sum, { m }) => sum + m.generated, 0)),
    compactTokens(Math.max(0, ...withMetrics.map(({ m }) => m.peakCtx))),
    usd(snap.loops.reduce((sum, s) => sum + s.totalCostUsd, 0)),
    // The fleet's today-spend, from the snapshot's budget block — the same number the header
    // badge reads, so table and badge cannot drift. While the orchestrator runs that figure is
    // the scheduler's live sum over its in-memory states, which can sit ABOVE the per-loop
    // `today` cells above (each loop's persisted copy, written only at its saves): the gap is
    // exactly the in-flight charge the budget gate has already counted, and displaying it is
    // the point (BUGS.md 2026-09-30). Not running, the snapshot derives the block from these
    // same loops, so cells and total agree by construction.
    usd(snap.budget.spentUsd),
    "",
    "",
    "",
  ].map((text) => cell(text));
  const allRows = [...rows, totalsRow];
  // Widths are measured in terminal display columns (displayWidth), not UTF-16 code units:
  // a cell holding CJK or emoji renders two columns per code point, and a code-unit measure
  // lets that row's later cells drift right of the header's.
  const widths = cols.map((c, i) => Math.max(displayWidth(c), ...allRows.map((r) => displayWidth(plainText(r[i] ?? [])))));

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

  // Each cell clipped and padded to its column (padding stays untoned), the columns joined by
  // the gap, and the line's trailing padding trimmed — the plain text is exactly the aligned
  // table it has always been.
  const fmt = (r: StatusSpan[][], tone?: StatusSpan["tone"]): StatusLine => {
    const out: StatusSpan[] = [];
    r.forEach((c, i) => {
      const w = widths[i] ?? 0;
      const clipped = clipSpans(c, w);
      if (i > 0) out.push({ text: "  " });
      out.push(...clipped.map((sp) => (tone && !sp.tone ? { ...sp, tone } : sp)));
      const pad = w - displayWidth(plainText(clipped));
      if (pad > 0) out.push({ text: " ".repeat(pad) });
    });
    // trimEnd, span-wise. An empty-text span (a blank cell renders as one) is trailing
    // material like padding is: it must be popped, not treated as already-trimmed content —
    // "".trimEnd() === "" would otherwise stop the loop at the first blank cell and leave
    // every pad span before it on the line (the totals row rendered with trailing spaces).
    while (out.length) {
      const last = out[out.length - 1]!;
      const trimmed = last.text.trimEnd();
      if (last.text !== "" && trimmed === last.text) break;
      if (trimmed) {
        out[out.length - 1] = { ...last, text: trimmed };
        break;
      }
      out.pop();
    }
    return out;
  };
  const separator: StatusLine = [{ text: widths.map((w) => "-".repeat(w)).join("  "), tone: "dim" }];
  lines.push(fmt(cols.map((c) => cell(c)), "dim"));
  lines.push(separator);
  for (const r of rows) lines.push(fmt(r));
  lines.push(separator);
  lines.push(fmt(totalsRow, "bold"));
  // One footnote under the table when any custom loop exists — explains the asterisk without
  // taking a column. Absent (byte-identical table) on a fleet with no user-defined loops.
  if (snap.loops.some((l) => l.custom)) lines.push([{ text: "* user-defined loop", tone: "dim" }]);
  const loops = withMetrics.map(({ s, phase }) => ({ role: s.role, phase, inFlight: isActivePhase(phase), ...(s.lastError ? { lastError: s.lastError } : {}) }));
  // The header line (and any residual overflow past the columns' minimums) is clipped too,
  // so no status line ever wraps in a terminal of `maxWidth` columns.
  return { lines: maxWidth === undefined ? lines : lines.map((l) => clipSpans(l, maxWidth)), loops };
}

/** Render the status table shared by `tumwater status` and the TUI as plain text (see
 * renderStatusSpans). When `maxWidth` is given, wide cells are clipped so no line exceeds it
 * (terminal rows never wrap). */
export function renderStatus(root: string, snap: StatusSnapshot, maxWidth?: number): string {
  return renderStatusSpans(root, snap, maxWidth).lines.map(plainText).join("\n");
}
