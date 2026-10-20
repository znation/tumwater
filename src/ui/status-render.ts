// vocabulary: plain
import type { RunnerState } from "../runner/runner-state.js";
import type { StatusSnapshot } from "../status/status-data.js";
import { dailyCost } from "../budget/budget.js";
import type { LiveProgress } from "./progress-data.js";
import { clipToWidth, displayWidth } from "../text/text-width.js";
import { compactTokens, usd } from "../text/format.js";
import { formatTime, humanAgo, nextRunPhrase, pad2, secondsUntil } from "../text/datetime.js";
import { projectName } from "../project-name.js";
import { bootstrapBadge, buildBadge, budgetBadge, claudeWindowTone, diskBadge, mergeBadge, mainCheckBadge, mainCheckVerdict, pauseBadge, roleWakeMarker, permitsBadge, checksBadge, quietBadge, runWindowBadge, wakeBadge, workspacesBadge } from "./badges.js";
import { idleClaimText, isActivePhase, roleRowCells, onErrorStreak, sortRolesByState } from "./status-model.js";
import { tickProgress } from "./tick-progress-model.js";
import { eventTypeLabel } from "../events/event-labels.js";
import { roleLabel } from "../roles/role-labels.js";
import { yieldMultiplierFor, yieldMultiplierSuffix } from "../scheduling/backoff.js";
import { phaseTone, resultTone, type Tone } from "./tone.js";
import { teamAlerts } from "./team-alerts.js";
import type { TeamAlert } from "./team-alerts.js";
import { openQuestions } from "../backlog/backlog.js";
import { refusedEntryTitles } from "../backlog/backlog-eligibility.js";

/** The status RENDER layer: time/token cell formatters and the width-aware table shared by
 * `tumwater status` and the TUI. The labels, badges, and metrics it draws come from the shared
 * display model (status-model.ts); this module decides column widths and layout. Depends on
 * status/status-data.ts one way — rendering reads the snapshot; it never collects team state
 * itself (live tick detail is display-only). */

function ago(ts: number | undefined): string {
  if (!ts) return "-";
  return humanAgo(ts, Date.now());
}

/** The table's `last tick` cell: the absolute local time of the last tick end alongside its
 * relative age ("14:32:05 · 3m ago"). Zero-padded HH:MM:SS in local time, prefixed `MM-DD `
 * once older than a day so multi-day runs stay unambiguous; "-" for roles that never ticked.
 * The GUI renders the same cell (absolute stamp plus relative age) from its own JS copy in
 * gui-client.ts — formatting at each surface, per the fmtTokens precedent. */
export function lastTickCell(ts: number | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  let s = formatTime(d);
  if (Date.now() - ts > 86_400_000) s = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${s}`;
  return `${s} · ${ago(ts)}`;
}

/** The table's `last merged` cell: when the role last merged a change on main, in the SAME
 * absolute-time-plus-relative-age shape as the `last tick` cell (lastTickCell), so the two
 * columns cannot drift on what "ago" means. A role that has never merged shows the same dash
 * lastTickCell uses for a never-ticked role. */
export function lastMergedCell(ts: number | undefined): string {
  return lastTickCell(ts);
}

/** The table's `next run` cell: when the role may tick again, or `-` when that is not the
 * operator's question — a role in flight (an active rendered phase: working/reviewing/merge,
 * or `s.running`) has no next run to speak of, and a stopped team renders no schedule at all
 * (its `nextRunAt`s are stale leftovers, not plans). A due idle role reads `now`; a future one
 * reads its remaining time through humanSeconds (the same bucketing the sleeping phase label
 * uses, so the two cannot drift), prefixed `backoff ` while `backoffSeconds > 0` — the wake
 * row-action clears exactly that, so the prefix is what makes waking meaningful. The GUI
 * renders the same rules from its own JS copy in gui-client.ts (fmtNextRun). The `phase` and
 * `teamRunning` arguments come from the caller because neither fact lives on RunnerState: the
 * active-phase check needs the rendered label (a merge is visible only there), and the
 * team's running flag lives on the snapshot, not the role. */
export function nextRunCell(s: RunnerState, phase: string, now: number, teamRunning: boolean): string {
  if (!teamRunning || s.running || isActivePhase(phase)) return "-";
  const remain = secondsUntil(s.nextRunAt, now);
  // The yield multiplier rides the cell as `×N` (yield-scaled clocks, PLANS.md): a scalable
  // role whose recent ticks merged nothing keeps a longer effective gap than nextRunAt's
  // countdown shows, and the suffix is what makes that visible. The multiplier gates the
  // scheduled gap and the main-moved wake in isEligible, so a `now`-due cell at ×4 is a
  // role waiting out its stretched gap, not a broken clock.
  const suffix = yieldMultiplierSuffix(yieldMultiplierFor(s));
  return nextRunPhrase(remain, s.backoffSeconds > 0, "now", false) + suffix;
}

/** The table's state cell: a role's phase label (rolePhase, computed once per row by
 * renderStatus so the same label drives the row order), with the current work item prepended
 * while a tick is in flight ("implement plan X · working 3m · turn 2"). Prepending — not
 * appending — so the item survives ellipsis clipping on narrow terminals; the live detail
 * after it is what gets clipped first. Idle roles are untouched: their log tail describes a
 * finished tick and must not leak its work item into the state cell. (The GUI shows the same
 * item in its own `current` column instead, so its state cell stays clean.) */
function stateCell(root: string, s: RunnerState, phase: string, live?: LiveProgress | null): string {
  // While under review the log tail's "current work" is the reviewer's own output, not the
  // author's task — don't prepend it; the phase cell already carries the reviewer's live
  // detail. The merge label rides the same guard: the merge role is not running, so its
  // phase ("merge <elapsed> · <stage>", with the reviewer's live detail while it reviews)
  // is returned without a work-item prefix.
  if (!s.running || s.parkedSince || s.phase === "review") {
    // Parallel work instances, part 6/7: an idle or merge instance leads with the entry it
    // claimed (or, for an idle extra with none, the no-unclaimed note), so the operator can
    // see WHAT it is parked on without opening its drawer.
    const idle = idleClaimText(s, phase);
    return idle ? `${idle} · ${phase}` : phase;
  }
  const p = tickProgress(root, s, live);
  const work = p?.currentWork;
  return work ? `${work} · ${phase}` : phase;
}

/** Columns allowed to shrink when the table is wider than the terminal, widest offender
 * first: `last result` (holds the tick summary), then `state` (live working detail), then
 * `last tick` — it shrinks last so on a narrow terminal it loses " · 3m ago" before whole
 * lines clip; its minimum is a bare HH:MM:SS. `last merged` sits right of `last tick` and is
 * not flexible: it is a short sibling time cell whose width follows lastTickCell's, and the
 * whole-line clip that already protects the header also bounds it. Indices are positional in
 * the `cols` array below — renumber when columns change. (`today`, like `cost`, is a short
 * fixed-width cell: never flexible.)
 * The name column (index 0) gives way after all of these, down to the longest bare role label. */
const FLEXIBLE_COLUMNS: Array<{ index: number; minWidth: number }> = [
  { index: 10, minWidth: 12 },
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

/** The attention line's mark and tone, per alert tone — shared by the TUI and `tumwater
 * status` (status-render.ts alertLines), so the two surfaces draw the same banner glyphs. */
const ALERT_MARKS: Record<TeamAlert["tone"], { mark: string; tone: Tone | undefined }> = {
  red: { mark: "!", tone: "red" },
  amber: { mark: "!", tone: "yellow" },
  indigo: { mark: "?", tone: "magenta" },
  blue: { mark: "i", tone: "blue" },
  gray: { mark: "i", tone: "dim" },
};

/** A plain line clipped to a width, in one tone. */
export function toneLine(text: string, width: number, tone?: StatusSpan["tone"]): StatusLine {
  return clipSpans([{ text, ...(tone ? { tone } : {}) }], width);
}

/** The attention lines under a header: one per alert — its mark and title in its tone, then
 * the detail — at most `max` of them, the rest counted on a last line. This is the banner
 * block the TUI draws under its header and `tumwater status` pushes under its own, so the two
 * surfaces render the same wording from the one shared alert source (team-alerts.ts). */
export function alertLines(alerts: readonly TeamAlert[], width: number, max = 3): StatusLine[] {
  const shown = alerts.length > max ? alerts.slice(0, max - 1) : alerts;
  const lines = shown.map((a) => {
    const { mark, tone } = ALERT_MARKS[a.tone];
    const t = tone ? { tone } : {};
    return clipSpans([{ text: `${mark} `, ...t }, { text: a.title, ...t }, { text: a.detail ? ` — ${a.detail}` : "" }], width);
  });
  if (shown.length < alerts.length) lines.push(toneLine(`  +${alerts.length - shown.length} more — the dashboard lists them all`, width, "dim"));
  return lines;
}

/** A header badge (" · merge queue: 2", ", build abc…") as a plain separator plus its toned
 * words, so the TUI colors the words and not the dots. Empty badges add nothing. */
function badgeSpans(badge: string, tone?: StatusSpan["tone"]): StatusSpan[] {
  if (!badge) return [];
  const sep = /^(?: · |, )/.exec(badge)?.[0] ?? "";
  return [{ text: sep }, { text: badge.slice(sep.length), ...(tone ? { tone } : {}) }];
}

/** The daily budget badge's tone: yellow from 85% of the cap, red once it is spent; the
 * subscription window's own severity (amber near its limit, red when a rejected window holds
 * the seams) wins when it stands beside the daily spend. */
function budgetTone(
  budget: StatusSnapshot["budget"],
  claudeWindow?: StatusSnapshot["claudeWindow"],
): Tone | undefined {
  const window = claudeWindowTone(claudeWindow);
  if (window !== undefined) return window;
  if (budget.free || !(budget.capUsd > 0)) return undefined;
  const share = budget.spentUsd / budget.capUsd;
  return share >= 1 ? "red" : share >= 0.85 ? "yellow" : undefined;
}

/** The role facts one status render computed, for callers that build more on them (the TUI's
 * attention lines): each role's rendered phase, whether its own failure streak is at the
 * alarm threshold (onErrorStreak — the red "failing tick after tick" alert keys on this, not
 * the phase, so it stays up while a streak stands behind a `working` label; BUGS.md
 * 2026-10-14), whether it is in flight, its last error. */
interface StatusRoleRow {
  role: string;
  phase: string;
  errorStreak: boolean;
  inFlight: boolean;
  lastError?: string;
}

/** Render the status table shared by `tumwater status` and the TUI as lines of toned spans,
 * plus the per-role facts it computed (see StatusRoleRow). When `maxWidth` is given, wide cells
 * are clipped so no line exceeds it (terminal rows never wrap). */
export function renderStatusSpans(
  root: string,
  snap: StatusSnapshot,
  maxWidth?: number,
  scoped = false,
): { lines: StatusLine[]; roles: StatusRoleRow[] } {
  const name = projectName(root);
  const lines: StatusLine[] = [];
  // One clock read per render, shared by the timed-pause badge's countdown and every row's
  // next-run cell — a per-site Date.now() could tick over between them and disagree with
  // itself.
  const now = Date.now();
  // The questions badge (like the inbox one) appears only when something needs an answer.
  // The budget badge is standing information for a money-spending system in EVERY cap state
  // (disabled reads `· no cap` — and it is the affordance for editing the cap); on narrow
  // terminals the header's existing last-resort whole-line clipping applies. A team whose
  // models are all free reads n/a — spend can never accumulate against a cap that cannot be
  // reached, so a dollar figure would mislead. The timed-pause badge (plans/pause-countdown
  // wording) rides last so a team under a timed pause reads how long until it comes back —
  // empty unless the team marker's deadline stands in the future, so a role-only or
  // indefinite pause keeps today's header byte-identical.
  const running: StatusSpan[] = snap.running
    ? [{ text: "running", tone: "green" }, { text: ` (pid ${snap.pid}` }, ...badgeSpans(buildBadge(snap.build), snap.build?.stale ? "yellow" : undefined), { text: ")" }]
    : [{ text: "not running — start with `tumwater start`", tone: "dim" }];
  lines.push([
    { text: "tumwater", tone: "brand" },
    { text: ` · ${name} · ` },
    ...running,
    ...(snap.running ? badgeSpans(runWindowBadge(snap.runStopsAt, now), "blue") : []),
    ...badgeSpans(mergeBadge(snap.mergeQueue), "blue"),
    ...(snap.inbox ? [{ text: ` · inbox: ${snap.inbox}` }] : []),
    ...(snap.questions ? badgeSpans(` · questions: ${snap.questions}`, "magenta") : []),
    ...badgeSpans(budgetBadge(snap.budget, snap.claudeWindow, now, snap.chain), budgetTone(snap.budget, snap.claudeWindow)),
    // The disk floor (plans/disk-floor.md, part 4/4): `disk 8.2 GB free — holding new work`
    // while the hold is on, or the bare reading below the reclaim threshold. Empty in every
    // comfortable or unmeasured state, so an unaffected header stays byte-identical.
    ...badgeSpans(diskBadge(snap.disk), snap.disk?.held ? "yellow" : "blue"),
    // The permit pool's live state (plans/provider-concurrency.md §8): the team line reads
    // `slots 5/8 · omlx 3/3` only while the per-provider cap map is set (permitsBadge already
    // omits the providers on a map-less team, so the header stays byte-identical).
    ...badgeSpans(permitsBadge(snap.permits), "blue"),
    // Checks running/waiting for a check permit; empty while the check pool is idle.
    ...badgeSpans(checksBadge(snap.checkPermits), snap.checkPermits && snap.checkPermits.waiting > 0 ? "yellow" : "blue"),
    // The workspace pool, only while it is full or a run waits for a slot.
    ...badgeSpans(workspacesBadge(snap.slotPool), snap.slotPool && snap.slotPool.waiting > 0 ? "yellow" : "blue"),
    // New-project bootstrap (plans/work-ratio.md, part 2/2): the progress reading while the
    // hold is active. Empty in every normal project, so the header stays byte-identical.
    ...badgeSpans(bootstrapBadge(snap.bootstrap), "blue"),
    ...badgeSpans(mainCheckBadge(snap.mainCheck), snap.mainCheck
      // The helper's tone is string (the GUI's palette differs); with a Tone fallback here
      // every branch is a Tone, so the cast cannot widen the value.
      ? mainCheckVerdict(snap.mainCheck.status, "yellow").tone as Tone
      : undefined),
    ...badgeSpans(pauseBadge(snap.pausedUntil, now, snap.pauseReason), "yellow"),
    ...badgeSpans(wakeBadge(snap.scheduledWake, now), "blue"),
    // Quiet hours 2/2 rides the header last: the window as standing information whenever it
    // is configured, the yellow `quiet until <end>` reading while the hold is on — the same
    // ask-me-nothing informality the pause badge's countdown uses, without stealing its
    // urgency. Unset keeps the header byte-identical (the badge is empty).
    ...badgeSpans(quietBadge(snap.quietHours, snap.inQuietHours), snap.inQuietHours ? "yellow" : undefined),
  ]);
  lines.push([]);
  // `today` is the role's daily budget window (dailyCost): $0.00 while its stamp is stale
  // or missing, so roles that never ticked — or last ticked yesterday — read zero without a
  // save. It renders whether or not the cap is enabled: spend observability does not depend
  // on it.
  // `next run` is a short fixed-width cell like `today`, never flexible: the columns that
  // give way when the table is wider than the terminal are `last result`, then `state`, then
  // `last tick`, in FLEXIBLE_COLUMNS' order.
  const cols = ["role", "state", "runs", "commits", "output", "peak ctx", "cost", "today", "last run", "last merged", "last result", "next run"];
  // One live tail read per running role per frame, threaded through every cell that shows
  // in-flight detail (metrics, state, current work) — each helper used to re-read the log on
  // its own, up to three stats + reads per role per second. The phase is computed once per
  // row (in roleRowCells, shared with the GUI payload) and carried on the row: the same
  // label drives the state cell and the shared row order (sortRolesByState).
  // Per-role prompts 2/2 — a role with queued prompts carries a small `p:N` marker on its
  // state cell (appended, so the work-item prefix survives clipping ahead of it), telling the
  // operator steering one role that something is waiting for it. A pending scheduled wake
  // naming the role adds a blue ` · wake in …` marker after it.
  const roleQueued = (role: string): string => {
    const n = snap.roleInbox[role] ?? 0;
    return n > 0 ? ` p:${n}` : "";
  };
  const withMetrics = snap.roles.map((s) => {
    // roleRowCells single-homes the per-role tail read + metrics + phase derivation the GUI
    // payload (status-payload.ts) repeats, so the two dashboards cannot drift apart.
    const cells = roleRowCells(snap, root, s);
    return {
      s,
      m: { generated: cells.generated, peakCtx: cells.peakCtx },
      live: cells.live,
      phase: cells.phase,
      role: s.role,
      lastRunEndedAt: s.lastRunEndedAt,
    };
  });
  // User-defined roles (snapshot's `custom` flag) get an asterisk beside their name — the
  // dashboards' at-a-glance marker. The name column (index 0) is not in FLEXIBLE_COLUMNS;
  // its width derives from row content and it shrinks only after those,
  // so the extra character widens it.
  // Rows are ordered by the shared display rule (status-model's roleRank, then last tick most
  // recent first) so the TUI/status table groups roles the way the GUI table does.
  // Each cell is spans: the state cell takes its phase's tone (the p:N marker stays plain), the
  // last result tones its outcome word, a backoff countdown reads yellow.
  const cell = (text: string, tone?: StatusSpan["tone"]): StatusSpan[] => [{ text, ...(tone ? { tone } : {}) }];
  // A model every role shares prints once in a footnote instead of on each name cell.
  const modelInner = (s: (typeof snap.roles)[number]): string =>
    s.modelTier
      ? `${s.modelTier}${s.model ? ` · ${s.model}` : ""}`
      : s.model
        ? `${s.model}${s.modelFromPi ? ", pi default" : ""}`
        : "";
  const inners = snap.roles.map(modelInner);
  const sharedModel = snap.roles.length >= 2 && inners[0] && inners.every((m) => m === inners[0]) ? inners[0] : undefined;
  const rows = sortRolesByState(withMetrics).map(({ s, m, live, phase }): StatusSpan[][] => {
    // The name cell appends the selector the role resolves to; with a top-level tier map
    // declared it additionally names the seam tier (model-tiers.md part 7a,
    // "Observability"). No model resolved and no tier keeps the name byte-identical to
    // today's.
    const inner = modelInner(s);
    const modelSuffix = inner && !sharedModel ? ` (${inner})` : "";
    // Model failure fallback, part 2/2: while the role runs off-model its name cell says so,
    // so the operator can see which roles the fallback pair is carrying without reading logs.
    const fallbackSuffix = s.fallback ? " (over-cap model)" : "";
    const name = (s.custom ? `${roleLabel(s.role)}*` : roleLabel(s.role)) + modelSuffix + fallbackSuffix;
    const state = stateCell(root, s, phase, live);
    const tone = phaseTone(phase);
    // The whole state cell carries the phase's tone: a work item leads the cell (so it
    // survives clipping), and clipping often leaves only it — the color still tells the state.
    const stateSpans: StatusSpan[] = [{ text: state, ...(tone ? { tone } : {}) }];
    const next = nextRunCell(s, phase, now, snap.running);
    const wakeMark = roleWakeMarker(snap.scheduledWakes, s.role, s.instanceOf, now);
    const resultT = resultTone(s.lastResult);
    return [
      cell(name),
      // Merge queue 4/5 — the merge role's phase label (the marker-driven record, filtered to
      // this role by rolePhase's `merge` argument above) rides this same phase string.
      [...stateSpans, { text: roleQueued(s.role) }, ...(wakeMark ? [{ text: wakeMark, tone: "blue" as const }] : [])],
      cell(String(s.runs)),
      cell(String(s.commits)),
      cell(compactTokens(m.generated)),
      cell(compactTokens(m.peakCtx)),
      cell(usd(s.totalCostUsd)),
      cell(usd(dailyCost(s))),
      cell(lastTickCell(s.lastRunEndedAt)),
      cell(lastMergedCell(s.lastMergedAt)),
      s.lastResult
        ? [{ text: eventTypeLabel(s.lastResult), ...(resultT ? { tone: resultT } : {}) }, { text: s.lastSummary ? ` — ${s.lastSummary}` : "" }]
        : cell("-"),
      cell(next, next.startsWith("sleeping") ? "yellow" : undefined),
    ];
  });
  const totalsRow: StatusSpan[][] = [
    "total",
    "",
    "",
    "",
    compactTokens(withMetrics.reduce((sum, { m }) => sum + m.generated, 0)),
    compactTokens(Math.max(0, ...withMetrics.map(({ m }) => m.peakCtx))),
    usd(snap.roles.reduce((sum, s) => sum + s.totalCostUsd, 0)),
    // The team's today-spend, from the snapshot's budget block — the same number the header
    // badge reads, so table and badge cannot drift. While the orchestrator runs that figure is
    // the scheduler's live sum over its in-memory states, which can sit ABOVE the per-role
    // `today` cells above (each role's persisted copy, written only at its saves): the gap is
    // exactly the in-flight charge the budget gate has already counted, and displaying it is
    // the point (BUGS.md 2026-09-30). Not running, the snapshot derives the block from these
    // same roles, so cells and total agree by construction.
    // A role-scoped table adds up the rows shown instead: the team figure would not match them.
    usd(scoped ? snap.roles.reduce((sum, s) => sum + dailyCost(s), 0) : snap.budget.spentUsd),
    "",
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
    // The name column gives way last, down to the longest bare role label.
    if (overflow > 0) {
      const floor = Math.max(
        displayWidth(cols[0] ?? ""),
        ...snap.roles.map((s) => displayWidth(s.custom ? `${roleLabel(s.role)}*` : roleLabel(s.role))),
      );
      widths[0] = Math.max(floor, (widths[0] ?? 0) - overflow);
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
  const roles = withMetrics.map(({ s, phase, live }) => ({
    role: s.role,
    phase,
    errorStreak: onErrorStreak(s),
    inFlight: isActivePhase(phase),
    ...(live?.quietMs !== undefined ? { stuckMs: live.quietMs } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
    // The role's image-input surface (plans/image-input.md "Surfaces", part 5/5): always
    // present, so the TUI's images attention line keys on it like the dashboard's.
    imageInput: s.imageInput,
    imageReroute: s.imageRerouteLabel,
  }));
  const separator: StatusLine = [{ text: widths.map((w) => "-".repeat(w)).join("  "), tone: "dim" }];
  lines.push(fmt(cols.map((c) => cell(c)), "dim"));
  lines.push(separator);
  for (const r of rows) lines.push(fmt(r));
  lines.push(separator);
  lines.push(fmt(totalsRow, "bold"));
  // One footnote under the table when any custom role exists — explains the asterisk without
  // taking a column. Absent (byte-identical table) on a team with no user-defined roles.
  if (sharedModel) lines.push([{ text: `model (every role): ${sharedModel}`, tone: "dim" }]);
  if (snap.roles.some((l) => l.custom)) lines.push([{ text: "* custom role", tone: "dim" }]);
  // The header line (and any residual overflow past the columns' minimums) is clipped too,
  // so no status line ever wraps in a terminal of `maxWidth` columns.
  return { lines: maxWidth === undefined ? lines : lines.map((l) => clipSpans(l, maxWidth)), roles };
}

/** Render the status table shared by `tumwater status` and the TUI as plain text (see
 * renderStatusSpans). When `maxWidth` is given, wide cells are clipped so no line exceeds it
 * (terminal rows never wrap). */
export function renderStatus(root: string, snap: StatusSnapshot, maxWidth?: number, scoped = false): string {
  const { lines, roles } = renderStatusSpans(root, snap, maxWidth, scoped);
  // The team-attention banners (team-alerts.ts) drop under the header's blank line here, on
  // the CLI-only plain-text surface — the same spelled-out banners the dashboard and TUI draw,
  // from the one shared source, so the CLI/GUI/TUI cannot drift on wording. One QUESTIONS.md
  // read (openQuestions) for the pending-questions alert — the dashboard's cadence. The CLI
  // omits the not-running banner: the header's first line already spells out the team's state,
  // so a `status` run on a stopped team does not lead with a banner that duplicates it.
  // Composed here, NOT inside renderStatusSpans: the TUI re-slices that function's shared
  // `lines` (lines[0], its own attention block, then lines.slice(1)), so a banner embedded
  // there would render twice in the TUI.
  const alerts = teamAlerts(snap, openQuestions(root), roles, Date.now(), refusedEntryTitles(root)).filter((a) => a.key !== "stopped");
  const banner = alertLines(alerts, maxWidth ?? Number.MAX_SAFE_INTEGER, alerts.length).map(plainText);
  const text = lines.map(plainText);
  return [...text.slice(0, 2), ...banner, ...text.slice(2)].join("\n");
}
