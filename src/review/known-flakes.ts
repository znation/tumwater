/** The review gate's memory of its own flake warnings — split out of review-precheck.ts so the
 * "has this exact failure already passed on a re-run?" question lives on its own and can be
 * unit-tested over synthetic events. The gate re-runs a failed check once (BUGS.md 2026-09-23) and
 * logs `gate check failed then passed on retry — flaky: <headline>` when it passes; a later
 * repeat of that same headline is the flake firing again, not a verdict about whichever change
 * happened to hit it (BUGS.md 2026-10-06). The flake is matched by the shared failure-cluster
 * normalization so a duration, path, SHA, timestamp, or bare integer difference does not hide the
 * repeat. Only the gate's positive flake record is trusted: a check-failure rejection is not
 * evidence of flakiness — it is exactly the attribution this memory exists to avoid making
 * twice. */

import type { HarnessEvent } from "../events/events.js";
import { readEventsSince } from "../events/event-window.js";
import { increment } from "../collections.js";
import { normalizeClusterKey } from "../failure/failure-cluster.js";

/** How far back the gate looks for its own flake warnings. One local day: the example in
 * BUGS.md 2026-10-06 recorded a flake at 10:50 and rejected an unrelated change on the same
 * headline at 15:57, and a day is short enough that a retired flake stops excusing failures
 * while still covering a team's working span. Exported so the doctor's `flaky checks` check
 * and the gate share the one window and cannot drift. */
export const KNOWN_FLAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The exact prefix review-precheck.ts writes before a flake's failure headline. Exported so
 * the writer and reader cannot drift over the separator. */
export const FLAKY_WARNING_PREFIX = "gate check failed then passed on retry — flaky: ";

/** The normalized cluster keys of every flake warning in `events` — the shared extraction
 * both the gate's flakeKeys and the doctor's `flaky checks` check fold from the log, so the
 * prefix slice-offset and original cluster normalization live once and cannot drift. Non-
 * warning events and warnings whose message is not a string are ignored; `cutoffMs`, when
 * given, also drops events timestamped strictly before it. Pure over its inputs (no I/O, no
 * clock) so the matching rules have their own unit tests. */
function flakeWarningKeys(events: readonly HarnessEvent[], cutoffMs?: number): string[] {
  const keys: string[] = [];
  for (const e of events) {
    if (e.type !== "warning" || typeof e.message !== "string") continue;
    if (cutoffMs !== undefined && typeof e.ts === "number" && e.ts < cutoffMs) continue;
    const at = e.message.indexOf(FLAKY_WARNING_PREFIX);
    if (at < 0) continue;
    keys.push(normalizeClusterKey(e.message.slice(at + FLAKY_WARNING_PREFIX.length)));
  }
  return keys;
}

/** Each normalized flake headline in `events` with how often it was warned, most frequent first;
 * ties keep first-seen order. No cutoff: callers pass an already-windowed read. Pure. */
export function flakeCounts(events: readonly HarnessEvent[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const key of flakeWarningKeys(events)) increment(counts, key);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** A Set of the flakeWarningKeys at or after `now - windowMs` of the gate's own window. */
export function flakeKeys(
  events: readonly HarnessEvent[],
  now: number,
  windowMs: number = KNOWN_FLAKE_WINDOW_MS,
): Set<string> {
  return new Set(flakeWarningKeys(events, now - windowMs));
}

/** Whether `headline` matches a flake warning the gate logged within the last
 * KNOWN_FLAKE_WINDOW_MS, read from the live log and its one archived generation. */
export function isKnownFlake(root: string, headline: string): boolean {
  const { events } = readEventsSince(root, KNOWN_FLAKE_WINDOW_MS);
  return flakeKeys(events, Date.now()).has(normalizeClusterKey(headline));
}
