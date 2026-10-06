/** Quiet hours (plans: "Quiet hours … part 1/2, the gate"): a config-driven daily local-time
 * window — `"23:00-07:00"` — during which role loops start no new ticks, so an operator can
 * put the fleet on a nightly schedule once instead of typing `tumwater pause` every evening.
 * Extracted from the orchestrator's concerns the same way the pause gate is
 * (src/pause-gates.ts): the parsing, the membership decision, and the edge-triggered
 * quiet/awake events live here; the orchestrator owns only the wiring. The director is
 * exempt — a human steering outranks a schedule — exactly as under the budget gate and the
 * operator pause. In-flight ticks finish; the gate sits before eligibility, so a tick due
 * inside the window simply starts at window end. */

import { logEvent } from "./events.js";
import { gotSuffix, isNonBlankString } from "./text.js";

/** A parsed window: minutes since local midnight for each end. `startMin > endMin` is a
 * window that wraps midnight (23:00-07:00 spans 23:00 → 00:00 → 07:00). */
interface QuietHoursWindow {
  startMin: number;
  endMin: number;
}

/** One parse of a `quietHours` config value: `window` is null when the value means off
 * (absent, empty, or whitespace-only — the operator's way to disable the gate without
 * removing the key). Anything unparseable — a non-string, a malformed clock time, a missing
 * or extra dash, out-of-range fields, or `start === end` (a zero-length window would mean
 * either never or always; neither is what an operator writing `23:00-23:00` could mean, so
 * it is rejected rather than silently interpreted) — comes back as an actionable error
 * message for validateConfig and `config set` to surface verbatim. */
type ParsedQuietHours =
  | { ok: true; window: QuietHoursWindow | null }
  | { ok: false; error: string };

/** Parse one `quietHours` value: `"HH:MM-HH:MM"` in local time, 24-hour clock, a wrapping
 * window (`start > end`) is the overnight case the format exists for. */
export function parseQuietHours(value: unknown): ParsedQuietHours {
  if (value === undefined || value === null) return { ok: true, window: null };
  if (typeof value !== "string")
    return {
      ok: false,
      error: `quietHours must be a string like "23:00-07:00"${gotSuffix(value)}`,
    };
  if (value.trim() === "") return { ok: true, window: null }; // empty means off
  const parts = value.split("-");
  if (parts.length !== 2)
    return {
      ok: false,
      error: `quietHours must be "HH:MM-HH:MM" with exactly one dash, e.g. "23:00-07:00"${gotSuffix(value)}`,
    };
  const ends: number[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (!m)
      return {
        ok: false,
        error: `quietHours times must be 24-hour "HH:MM", e.g. "23:00"${gotSuffix(trimmed)}`,
      };
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours > 23 || minutes > 59)
      return {
        ok: false,
        error: `quietHours times must be 24-hour "HH:MM" — hours 00-23, minutes 00-59${gotSuffix(trimmed)}`,
      };
    ends.push(hours * 60 + minutes);
  }
  // parts.length === 2 above, so both ends are present (the non-null assertions are safe).
  const [startMin, endMin] = [ends[0]!, ends[1]!];
  if (startMin === endMin)
    return {
      ok: false,
      error: `quietHours start and end must differ — a zero-length window means nothing schedulable${gotSuffix(value)}`,
    };
  return { ok: true, window: { startMin, endMin } };
}

/** Is `date` (its LOCAL wall clock — the operator reads the schedule off their own clock)
 * inside the window? A wrapping window (`start > end`) spans across 00:00; a same-day
 * window (`start < end`) is the ordinary half-open `[start, end)` range, so 07:00:00.000
 * exits a 23:00-07:00 window and 23:00:00.000 enters it. */
export function inQuietHours(window: QuietHoursWindow, date: Date): boolean {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (window.startMin < window.endMin) {
    return minutes >= window.startMin && minutes < window.endMin;
  }
  return minutes >= window.startMin || minutes < window.endMin; // wraps midnight
}

/** The previous poll's in-window boolean, so each window entry/exit logs exactly one event
 * instead of once per ~2s poll. In memory only: a restart mid-window logs one
 * `quiet_hours_started` on the first poll after it, and the config keeps gating regardless. */
export interface QuietHoursGateState {
  prevIn: boolean;
}

/** A fresh gate state: outside the window (the default for a fleet without quiet hours), so
 * the first poll of an unset window logs nothing. */
export function newQuietHoursGateState(): QuietHoursGateState {
  return { prevIn: false };
}

/** Poll the quiet-hours gate for one orchestrator cycle — the pause gate's scheduled sibling
 * (src/pause-gates.ts pollPauseGates): parse the config value fresh (a live edit applies on
 * the next poll), decide membership for `now`, and log exactly one `quiet_hours_started` /
 * `quiet_hours_ended` event (`loop: "harness"`, with the effective window string) per
 * crossing. An unset/off window is simply "outside", so nothing is ever logged for it.
 * Returns whether the fleet is inside the window right now. */
export function pollQuietHoursGate(
  root: string,
  quietHours: unknown,
  state: QuietHoursGateState,
  now: Date,
): boolean {
  const parsed = parseQuietHours(quietHours);
  const inNow = parsed.ok && parsed.window !== null && inQuietHours(parsed.window, now);
  if (inNow !== state.prevIn) {
    state.prevIn = inNow;
    logEvent(root, {
      loop: "harness",
      type: inNow ? "quiet_hours_started" : "quiet_hours_ended",
      window: typeof quietHours === "string" ? quietHours : undefined,
    });
  }
  return inNow;
}

/** Per-role quiet hours (PLANS.md, `quietHoursPerRole`): is `role`'s own window holding at
 * `now`? The membership decision reuses the fleet window's own parser and predicate, so a
 * per-role window means exactly what the same string means fleet-wide (wrapping included).
 * An absent key, a non-string, or an unparseable value reads as off here — validation is
 * config-validation.ts's job, not this helper's, and a malformed value must never hold a
 * loop the operator did not schedule. Stateless: unlike the fleet-wide gate there is no
 * edge-triggered event — a per-role hold is an anonymous verdict recomputed per poll,
 * exactly like `capPaused`'s set (role-cap-gates.ts). */
export function roleQuietHold(
  perRole: Record<string, string> | undefined,
  role: string,
  now: Date,
): boolean {
  const value = perRole?.[role];
  if (!isNonBlankString(value)) return false;
  const parsed = parseQuietHours(value);
  return parsed.ok && parsed.window !== null && inQuietHours(parsed.window, now);
}

/** The window's end time exactly as the operator wrote it — the text after the dash, trimmed —
 * for the surfaces that say "quiet until <end>" (badges.ts's quietBadge, fleet-alerts' quiet
 * alert). parseQuietHours enforces exactly one dash, so reading the end back out of the string
 * is well-defined and preserves the operator's spelling instead of reformatting parsed
 * minutes. The GUI page's client-side script re-derives the same text from the payload's raw
 * quietHours field (gui-client-fleet.ts), since browser code cannot import this module. */
export function quietWindowEnd(quietHours: string): string {
  return quietHours.split("-")[1]?.trim() ?? "";
}

/** What the dashboards show for one `quietHours` config value at `now` (plans: "Quiet hours
 * … part 2/2, observability"): the operator's own window string while it parses to a real
 * window (trimmed — the schedule as written, not a canonical reformat), null when unset,
 * empty (off), or malformed — a value the gate is not holding must never be advertised as
 * one it is — and whether the local wall clock sits inside that window right now, decided
 * by the same inQuietHours predicate the scheduler's gate uses so the dashboards and the
 * hold cannot disagree. Part 1/2's pollQuietHoursGate logs the crossings; this renders the
 * standing state. */
export function quietHoursStatus(
  value: unknown,
  now: Date,
): { window: string | null; inWindow: boolean } {
  const parsed = parseQuietHours(value);
  if (!parsed.ok || parsed.window === null) return { window: null, inWindow: false };
  return {
    window: typeof value === "string" ? value.trim() : null,
    inWindow: inQuietHours(parsed.window, now),
  };
}
