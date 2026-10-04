/** Local date/time formatting and calendar-day arithmetic — the zero-padded clock and
 * calendar parts, local-midnight day math, and the report-window header every display and
 * report surface (transcript run separators, the status table's last-tick cell, daily-budget
 * day stamps, the usage report's and failure digest's per-day buckets and headers) render
 * through, so what counts as one day and how a timestamp prints cannot drift per consumer.
 * Split out of text.ts — which keeps the one-line text shaping — because calendar
 * arithmetic (dayAt's midnight truncation, month/year edges) is a different concern from
 * string cutting, with its own tests. Presentation only: depends on node built-ins alone. */

import { plural } from "./phrases.js";
import { EVENTS_LOG_BASENAME } from "./paths.js";

/** Zero-pad an integer to two digits — the clock and calendar components every local-time
 * display in the harness renders through (transcript run separators, the status table's last-
 * tick cell, the daily-budget day stamp), so zero-padding cannot drift per consumer. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Whole seconds between two epoch-ms instants, rounded to the nearest second: `secondsSince`
 * clamps at zero (an age never goes negative when the clock skews), `secondsUntil` clamps at
 * zero the same way for the future direction (a countdown never reads negative once its
 * deadline has passed). The one home of the clamp + rounding behind every elapsed age and
 * countdown — status-render.ts's lastTickCell, the queued-prompt age and deliver-in suffix,
 * and the fleet pause's auto-resume countdown all render through. The GUI page's browser
 * script keeps its own one-line twins (gui-client.ts's ageSec and its inline countdown
 * rounding — a separate runtime that cannot import TypeScript), pinned by its marked regions'
 * tests, so the copies cannot disagree on the clamp or the rounding. */
export function secondsSince(sinceMs: number, now: number): number {
  return Math.max(0, Math.round((now - sinceMs) / 1000));
}

/** `secondsSince` mirrored: whole seconds from `now` to a future epoch-ms instant, clamped at
 * zero once the instant has passed. */
export function secondsUntil(atMs: number, now: number): number {
  return Math.max(0, Math.round((atMs - now) / 1000));
}

/** Whole elapsed seconds since an epoch-ms instant, clamped at zero and rounded to the
 * nearest second — the age rule status-render.ts's lastTickCell ages its `HH:MM:SS · Ns ago`
 * stamp through (secondsSince against the real clock). */
export function elapsedSeconds(sinceMs: number): number {
  return secondsSince(sinceMs, Date.now());
}

/** Calendar date as `YYYY-MM-DD` in local time — shared by the transcript run separators,
 * the daily-budget day stamp (todayStamp), and the usage report's per-day buckets, which must
 * all agree on what counts as one day. */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Wall-clock time as zero-padded `HH:MM:SS` in local time — the clock half formatTimestamp
 * builds, and the direct rendering of the status table's last-tick cell (status-render.ts's
 * lastTickCell), doctor-checks's probe-at stamp, failure-report's state-change stamp, and
 * operator-intent's pause/deadline wording, so a local time of day reads the same shape at
 * every surface. */
export function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Epoch ms as a local calendar-day key (`YYYY-MM-DD`) — the epoch-ms form of formatDate:
 * the day-bucketing rule the event log's day key (eventDayKey), the windowed readers' window
 * keys, the daily-budget stamp, and the failure digest's cluster dates all render through, so
 * what counts as one day cannot drift per consumer (local, never UTC — the same rule
 * formatDate holds). */
export function dayKey(ms: number): string {
  return formatDate(new Date(ms));
}

/** Epoch ms as a local `YYYY-MM-DD HH:MM:SS` stamp — date and wall-clock time in one string,
 * built from one Date so the two halves cannot disagree across a midnight crossing. Shared by
 * the transcript's run separators, the history table's time cell, and the review-gate prompt's
 * rejection context, so a timestamp reads identically at every surface. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${formatDate(d)} ${formatTime(d)}`;
}

/** Local midnight of the day `offsetFromToday` days before `now` (0 = today): the day-count
 * arithmetic the usage report and the failure digest share, so their windows select the same
 * calendar days. The Date constructor handles month/year edges; `now` is passed explicitly so
 * every day in one window derives from the same instant. */
export function dayAt(offsetFromToday: number, now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetFromToday);
}

/** The inclusive day-key bounds of a trailing window of `days` local calendar days ending
 * today, derived from one captured `now` instant — the window rule both report collectors
 * (the usage report's collectReport and the failure digest's collectFailureReport) share, so
 * their windows select the same calendar days from the same instant. */
export function dayWindow(days: number, now: Date): { from: string; to: string } {
  return { from: formatDate(dayAt(days - 1, now)), to: formatDate(dayAt(0, now)) };
}

/** Compact whole-second duration: `45s`, `12m`, `3h`, or `2d` — the phrasing every relative
 * time renders through (ago labels, sleeping-remaining countdowns, `prompt --list`'s queued
 * age, the fleet pause's auto-resume countdown), so the s/m/h/d bucketing and rounding cannot
 * drift per consumer. A day or more reads days, not an hour count (`pause --for 90d`'s
 * countdown reads `90d`, not `2160h`). Lives here, beside the other time phrasing, so core
 * modules (which may not import src/ui) share the same bucketing too. */
export function humanSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** `N days`, singular at 1 — the window label both report headers render, so a one-day window
 * reads the same on either surface. Rendered through phrases.ts's plural, like every other
 * count-plus-noun phrase in the harness. */
export function dayLabel(days: number): string {
  return plural(days, "day");
}

/** The report header both renderers print: the window's day-key bounds, its length in days
 * (singular at 1), and the event log it was read from. The failure digest appends its own tick
 * count. The rotation phrase is a required argument — eventsRotationLabel() supplies it from
 * events.ts's EVENTS_MAX_BYTES, so this header cannot keep claiming "16 MB" after the actual
 * threshold moves (this module stays presentation-only, owning no log facts of its own). The
 * source filename is paths.ts's EVENTS_LOG_BASENAME, the same name the log's path is built
 * from — not a second copy that a rename would leave behind. */
export function reportWindow(from: string, to: string, days: number, rotation: string): string {
  return `Window: ${from} → ${to} (${dayLabel(days)}) · source: ${EVENTS_LOG_BASENAME} (${rotation})`;
}
