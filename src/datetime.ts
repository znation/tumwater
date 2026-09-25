/** Local date/time formatting and calendar-day arithmetic — the zero-padded clock and
 * calendar parts, local-midnight day math, and the report-window header every display and
 * report surface (transcript run separators, the status table's last-tick cell, daily-budget
 * day stamps, the usage report's and failure digest's per-day buckets and headers) render
 * through, so what counts as one day and how a timestamp prints cannot drift per consumer.
 * Split out of text.ts — which keeps the one-line text shaping — because calendar
 * arithmetic (dayAt's midnight truncation, month/year edges) is a different concern from
 * string cutting, with its own tests. Presentation only: depends on node built-ins alone. */

/** Zero-pad an integer to two digits — the clock and calendar components every local-time
 * display in the harness renders through (transcript run separators, the status table's last-
 * tick cell, the daily-budget day stamp), so zero-padding cannot drift per consumer. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar date as `YYYY-MM-DD` in local time — shared by the transcript run separators,
 * the daily-budget day stamp (todayStamp), and the usage report's per-day buckets, which must
 * all agree on what counts as one day. */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Wall-clock time as zero-padded `HH:MM:SS` in local time — shared by the transcript run
 * separators and the status table's last-tick cell. */
export function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local midnight of the day `offsetFromToday` days before `now` (0 = today): the day-count
 * arithmetic the usage report and the failure digest share, so their windows select the same
 * calendar days. The Date constructor handles month/year edges; `now` is passed explicitly so
 * every day in one window derives from the same instant. */
export function dayAt(offsetFromToday: number, now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetFromToday);
}

/** `N days`, singular at 1 — the window label both report headers render, so a one-day window
 * reads the same on either surface. */
export function dayLabel(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** The report header both renderers print: the window's day-key bounds, its length in days
 * (singular at 1), and the event log it was read from. The failure digest appends its own tick
 * count. */
export function reportWindow(from: string, to: string, days: number): string {
  return `Window: ${from} → ${to} (${dayLabel(days)}) · source: events.jsonl (rotated at 16 MB)`;
}
