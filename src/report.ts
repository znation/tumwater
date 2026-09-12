import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent } from "./types.js";
import { eventsLogPath } from "./paths.js";
import { forEachTailChunk } from "./files.js";
import { formatDate } from "./text.js";

/** One day of a usage report: the local calendar day key plus what the fleet did on it.
 * `ticksByRole` counts tick_end events per loop id (role ids — works for custom loops too);
 * tokensOut sums their `tokens`; commits counts `merged` events; costUsd sums `costUsd`. */
export interface ReportDay {
  date: string; // "YYYY-MM-DD" local day key
  tokensOut: number;
  ticksByRole: Record<string, number>;
  commits: number;
  costUsd: number;
  featuresDone: number;
  bugsFixed: number;
}

/** Fleet usage over a window of exactly `days` local calendar days ending today. */
export interface ReportData {
  days: number;
  from: string; // day key of the oldest day in the series
  to: string; // day key of today
  series: ReportDay[]; // oldest → newest, zero-filled
  totals: {
    tokensOut: number;
    ticks: number;
    commits: number;
    costUsd: number;
    featuresDone: number;
    bugsFixed: number;
  };
}

function parseEventLine(line: string): HarnessEvent | null {
  try {
    return JSON.parse(line) as HarnessEvent;
  } catch {
    return null; // Skip partial/corrupt lines (e.g. torn writes).
  }
}

/** The oldest COMPLETE line in a backwards chunk buffer, or null when none is complete yet.
 * `parts` holds the read bytes oldest-first; unless we reached the file start, its leading
 * segment up to the first newline was cut by a chunk boundary and is discarded (it becomes
 * whole again once the earlier chunk lands). Lines are bounded by \n bytes, which cannot occur
 * inside a multi-byte UTF-8 sequence, so slicing on them is character-safe. */
function oldestCompleteLine(parts: Buffer[], atFileStart: boolean): string | null {
  let offset = 0;
  if (!atFileStart) {
    const first = parts[0];
    if (first === undefined || first.length === 0) return null;
    const nl = first.indexOf(10);
    if (nl < 0) return null; // Still one partial line in hand.
    offset = nl + 1;
  }
  let line = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? Buffer.alloc(0);
    const start = i === 0 ? offset : 0;
    if (start >= part.length) continue;
    const nl = part.indexOf(10, start);
    line += part.toString("utf8", start, nl >= 0 ? nl : undefined);
    if (nl >= 0) return line;
  }
  return null; // No complete line yet.
}

/** The events whose local day is on or after `fromKey`, read with bounded I/O: the log is
 * append-only and chronological, so we scan backwards in chunks from EOF (files.forEachTailChunk)
 * and stop as soon as the oldest complete line in hand predates the window — cost scales with
 * the window's size, not the log's. */
function readWindowEvents(root: string, fromKey: string): HarnessEvent[] {
  const file = eventsLogPath(root);
  const parts: Buffer[] = [];
  forEachTailChunk(file, (chunk) => {
    parts.unshift(chunk);
    // At the file start the oldest chunk's first line is complete, not torn — passing false may
    // forgo an early stop on that last chunk, which costs nothing: the scan ends with the file.
    const oldest = oldestCompleteLine(parts, false);
    if (oldest !== null) {
      const ev = parseEventLine(oldest);
      if (ev && typeof ev.ts === "number" && formatDate(new Date(ev.ts)) < fromKey) return true; // Window passed.
    }
    return false;
  });
  const text = Buffer.concat(parts).toString("utf8");

  const events: HarnessEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const ev = parseEventLine(line); // A torn leading line fails to parse and is skipped.
    if (ev && typeof ev.ts === "number" && formatDate(new Date(ev.ts)) >= fromKey) events.push(ev);
  }
  return events;
}

/** A file's text, or "" when missing/unreadable — a report degrades to zeros, never throws. */
function readMarkdown(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The completion dates ("YYYY-MM-DD") of the entries inside one `## <sectionTitle>` section.
 * An entry starts at a `### ` heading or `- ` bullet line and ends at the next such line; only
 * its METADATA is matched for dates — never its body, so a body's "**Done 2026-…**" recap line
 * (or a prose cross-reference like "(done 2026-…)") cannot double-count. Metadata = the start
 * line plus, for `### ` headings only, continuation lines up to and including the first line
 * ending in `)` (capped at 3 lines) — wrapped headings carry their date on the second line,
 * while `- ` epitaphs are single-line by construction, so a bullet's own line is its whole
 * metadata (a following prose paragraph is body, never matched). Joining with a space keeps
 * "done\n2026-…" matchable. Entries without a parseable date are skipped. */
function entryDates(md: string, sectionTitle: string, dateRe: RegExp): string[] {
  const dates: string[] = [];
  let inSection = false;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) {
      inSection = line.slice(3).trim() === sectionTitle;
      continue;
    }
    if (!inSection) continue;
    if (!line.startsWith("### ") && !line.startsWith("- ")) continue;
    const meta: string[] = [line];
    let closed = line.endsWith(")");
    let j = i + 1;
    // Continuation is a heading-only concern (wrapped headings); bullets are single-line.
    while (line.startsWith("### ") && meta.length < 3 && j < lines.length && !closed) {
      const next = lines[j] ?? "";
      if (next.startsWith("### ") || next.startsWith("- ")) break; // The entry ends at the next start.
      meta.push(next);
      j++;
      closed = next.endsWith(")");
    }
    const m = meta.join(" ").match(dateRe);
    if (m && m[1]) dates.push(m[1]);
    i = j - 1; // The loop's ++ resumes at the first line not consumed as metadata.
  }
  return dates;
}

/** Aggregate fleet usage over exactly `days` local calendar days ending today, from the event
 * log (tick_end/merged) and the backlog history files (PLANS.md ## Done, BUGS.md ## Fixed). */
export function collectReport(root: string, days: number): ReportData {
  const now = new Date();
  // Local midnight of each day in the window; setDate arithmetic handles month/year edges.
  const dayAt = (offsetFromToday: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetFromToday);
  const from = formatDate(dayAt(days - 1));
  const to = formatDate(dayAt(0));

  const series: ReportDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    series.push({
      date: formatDate(dayAt(i)),
      tokensOut: 0,
      ticksByRole: {},
      commits: 0,
      costUsd: 0,
      featuresDone: 0,
      bugsFixed: 0,
    });
  }
  const byDate = new Map<string, ReportDay>();
  for (const d of series) byDate.set(d.date, d);

  for (const ev of readWindowEvents(root, from)) {
    if (typeof ev.ts !== "number") continue; // Unreachable: the reader filters on ts.
    const day = byDate.get(formatDate(new Date(ev.ts)));
    if (!day) continue; // Outside [from, to] — also guards future-dated events.
    if (ev.type === "tick_end") {
      const role = typeof ev.loop === "string" && ev.loop !== "" ? ev.loop : "?";
      day.ticksByRole[role] = (day.ticksByRole[role] ?? 0) + 1;
      day.tokensOut += typeof ev.tokens === "number" ? ev.tokens : 0;
      day.costUsd += typeof ev.costUsd === "number" ? ev.costUsd : 0;
    } else if (ev.type === "merged") {
      day.commits++;
    }
  }

  const countOn = (date: string, field: "featuresDone" | "bugsFixed"): void => {
    const day = byDate.get(date);
    if (day) day[field] += 1; // Out-of-window dates drop out here.
  };
  for (const d of entryDates(readMarkdown(path.join(root, "PLANS.md")), "Done", /done (\d{4}-\d{2}-\d{2})/))
    countOn(d, "featuresDone");
  for (const d of entryDates(readMarkdown(path.join(root, "BUGS.md")), "Fixed", /\b(?:fixed|closed|resolved) (\d{4}-\d{2}-\d{2})/))
    countOn(d, "bugsFixed");

  const totals = { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  for (const d of series) {
    totals.tokensOut += d.tokensOut;
    for (const n of Object.values(d.ticksByRole)) totals.ticks += n;
    totals.commits += d.commits;
    totals.costUsd += d.costUsd;
    totals.featuresDone += d.featuresDone;
    totals.bugsFixed += d.bugsFixed;
  }

  return { days, from, to, series, totals };
}

/** Format a token count for display: <1000 as-is, else one decimal + k/M suffix. */
function formatTokens(v: number): string {
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** Bar width for one day: up to 20 blocks scaled to the window's max tokensOut —
 * round(20·v/max), min 1 when v > 0. */
function barWidth(v: number, max: number): number {
  if (v <= 0) return 0;
  return Math.max(1, Math.round((20 * v) / max));
}

/** Render a report as Markdown — the pinned shape the CLI prints and the GUI tab (report 2/3)
 * and TUI pane (report 3/3) will reuse. Pure function of ReportData: no I/O, no clock reads. */
export function renderReportMarkdown(data: ReportData): string {
  const lines: string[] = [];
  lines.push("# tumwater usage report");
  lines.push("");
  lines.push(`Window: ${data.from} → ${data.to} (${data.days} days) · source: events.jsonl (rotated at 16 MB)`);
  lines.push("");
  const t = data.totals;
  lines.push(
    `**Totals:** ${formatTokens(t.tokensOut)} output tokens · ${t.ticks} ticks · ${t.commits} commits · $${t.costUsd.toFixed(2)} · ${t.featuresDone} features done · ${t.bugsFixed} bugs fixed`,
  );
  lines.push("");
  lines.push("| day | tokens out | ticks | commits | cost |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  const maxTokens = data.series.reduce((m, d) => Math.max(m, d.tokensOut), 0);
  for (const d of data.series) {
    const ticks = Object.values(d.ticksByRole).reduce((a, b) => a + b, 0);
    const w = maxTokens > 0 ? barWidth(d.tokensOut, maxTokens) : 0;
    const bar = w > 0 ? ` ${"█".repeat(w)}` : ""; // Zero days carry no bar (and no stray space).
    lines.push(`| ${d.date.slice(5)} | ${formatTokens(d.tokensOut)}${bar} | ${ticks} | ${d.commits} | $${d.costUsd.toFixed(2)} |`);
  }
  const byRole = new Map<string, number>();
  for (const d of data.series) {
    for (const [role, n] of Object.entries(d.ticksByRole)) byRole.set(role, (byRole.get(role) ?? 0) + n);
  }
  // Window totals per role: count desc, then name asc so identical counts render deterministically.
  const roles = [...byRole.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push("");
  lines.push(`**Ticks by role:** ${roles.length === 0 ? "-" : roles.map(([r, n]) => `${r} — ${n}`).join(" · ")}`);
  return lines.join("\n");
}
