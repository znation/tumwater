/** Main's red time per local calendar day: how long main had no passing full check, from the
 * same `main_check` / `main_red_hold` event trail G1 uses (src/baseline/main-guardrails.ts).
 * Pure and synchronous over an event list and a `[fromMs, toMs)` window, so the usage
 * report's day and --since collectors both call it without reading the clock or the log
 * again. This is main's own wall-clock red time, not any role's, so the report carries it
 * only on the team scope. */
import { dayKey } from "../text/datetime.js";
import { isPassingMainCheck, isRedMain } from "../baseline/main-guardrails.js";
import { addTo, getOrCreate } from "../collections.js";
import { shortSha } from "../text/format.js";
import { roleLabel } from "../roles/role-labels.js";
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

/** Main's red failing tests per local calendar day (`YYYY-MM-DD` → test → count), over the
 * window `[fromMs, toMs)`: for each in-window event (`typeof e.ts === "number"` and `fromMs
 * <= e.ts < toMs`) that G1 accepts as red (`isRedMain`) — a `main_check` that ran the full
 * check and failed, or a `main_red_hold` — count each `failingTests` element that is a string
 * once into that event's day (`dayKey`). A passing check is not red, and a red event that
 * carries no `failingTests` (a hold whose red named none, or a torn non-array `failingTests`;
 * a non-string element contributes nothing) records nothing, so the loose event log can never
 * emit `undefined` as a key. Shares `isRedMain` and `dayKey` with
 * `mainRedMinutesByDay`, so the two cannot disagree about which events are main's red ones.
 * This is main's own failing tests, not any role's, so the report carries it only on the team
 * scope. */
export function mainRedFailingTestsByDay(
  events: readonly HarnessEvent[],
  fromMs: number,
  toMs: number,
): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (typeof e.ts !== "number" || e.ts < fromMs || e.ts >= toMs) continue;
    if (!isRedMain(e)) continue;
    if (!Array.isArray(e.failingTests)) continue;
    const record = getOrCreate(map, dayKey(e.ts), () => ({}));
    for (const t of e.failingTests) {
      if (typeof t === "string") addTo(record, t, 1);
    }
  }
  return map;
}

/** Main's red culprits per local calendar day (`YYYY-MM-DD` → label → count), over the window
 * `[fromMs, toMs)`: for each in-window event (`typeof e.ts === "number"` and `fromMs <= e.ts
 * < toMs`) that is a `main_culprit` whose `commit` is a non-empty string, label it
 * `<roleLabel(runner)> <shortSha(commit)>` when `runner` is a non-empty string, else
 * `merge <shortSha(commit)>`, and count it once into that event's day (`dayKey`). This is the
 * live `mainred` alert's own event (`src/status/status-polls.ts`'s `MainCheckStatus.red
 * .culprit`), so the report names the very merge the watch blamed, not just the tests it
 * named. A `main_culprit` with no `commit` or an empty/non-string one contributes nothing, so
 * the loose event log can never emit `undefined` as a key. Shares `dayKey` with the sibling
 * walks (`mainRedMinutesByDay`, `mainRedFailingTestsByDay`), so the three cannot disagree
 * about which day an event lands on. This is main's own blame, not any role's, so the report
 * carries it only on the team scope. */
export function mainRedCulpritsByDay(
  events: readonly HarnessEvent[],
  fromMs: number,
  toMs: number,
): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (typeof e.ts !== "number" || e.ts < fromMs || e.ts >= toMs) continue;
    if (e.type !== "main_culprit") continue;
    if (typeof e.commit !== "string" || e.commit.length === 0) continue;
    const label =
      typeof e.runner === "string" && e.runner.length > 0
        ? `${roleLabel(e.runner)} ${shortSha(e.commit)}`
        : `merge ${shortSha(e.commit)}`;
    const record = getOrCreate(map, dayKey(e.ts), () => ({}));
    addTo(record, label, 1);
  }
  return map;
}
