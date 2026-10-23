/** Main's red time per local calendar day: how long main had no passing full check, from the
 * same `main_check` / `main_red_hold` event trail G1 uses (src/baseline/main-guardrails.ts).
 * Pure and synchronous over an event list and a `[fromMs, toMs)` window, so the usage
 * report's day and --since collectors both call it without reading the clock or the log
 * again. This is main's own wall-clock red time, not any role's, so the report carries it
 * only on the team scope. */
import { dayKey } from "../text/datetime.js";
import { isPassingMainCheck, isRedMain } from "../baseline/main-guardrails.js";
import type { HarnessEvent } from "../events/events.js";

/** Add a spell's ms, split across the local calendar days it spans, to `map` (a Map, so the
 * caller keeps the day-key order the walk produced). */
function addSpell(map: Map<string, number>, start: number, end: number): void {
  let cur = start;
  while (cur < end) {
    // The Date constructor's month/date fields cross the local midnight (and any DST shift
    // at it) exactly as dayAt does, so an hour cannot leak into the next day.
    const d = new Date(cur);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const segEnd = Math.min(end, nextMidnight);
    const ms = segEnd - cur;
    if (ms > 0) map.set(dayKey(cur), (map.get(dayKey(cur)) ?? 0) + ms);
    cur = segEnd;
  }
}

/** Main's red wall-clock time per local calendar day (`YYYY-MM-DD` → ms), over the window
 * `[fromMs, toMs)`. A red spell is G1's rule (isRedMain / isPassingMainCheck): it opens at a
 * red event while none is open (a further red while open keeps the earliest start) and closes
 * at the next passing full `main_check`; a spell still open at `toMs` runs to the window's
 * end. Every spell is split across local calendar days (dayKey) with midnight arithmetic, so
 * a DST shift cannot leak an hour into the next day; only nonzero daily entries are returned.
 * A spell already open before `fromMs` is not counted, because its opener lies outside the
 * window — the report measures main's own red time within the window it was asked for. */
export function mainRedMinutesByDay(
  events: readonly HarnessEvent[],
  fromMs: number,
  toMs: number,
): Map<string, number> {
  const map = new Map<string, number>();
  const inWindow = events
    .filter((e) => typeof e.ts === "number" && e.ts >= fromMs && e.ts < toMs)
    .sort((a, b) => a.ts - b.ts);
  let openStart: number | undefined;
  for (const e of inWindow) {
    const ts = e.ts;
    if (isRedMain(e)) {
      if (openStart === undefined) openStart = ts;
    } else if (isPassingMainCheck(e)) {
      if (openStart !== undefined) {
        addSpell(map, openStart, ts);
        openStart = undefined;
      }
    }
  }
  if (openStart !== undefined) addSpell(map, openStart, toMs);
  return map;
}
