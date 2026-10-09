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
import { normalizeClusterKey } from "../failure/failure-cluster.js";

/** How far back the gate looks for its own flake warnings. One local day: the example in
 * BUGS.md 2026-10-06 recorded a flake at 10:50 and rejected an unrelated change on the same
 * headline at 15:57, and a day is short enough that a retired flake stops excusing failures
 * while still covering a fleet's working span. */
const KNOWN_FLAKE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The exact prefix review-precheck.ts writes before a flake's failure headline. Exported so
 * the writer and reader cannot drift over the separator. */
export const FLAKY_WARNING_PREFIX = "gate check failed then passed on retry — flaky: ";

/** The normalized cluster keys of every flake warning in `events` at or after `now - windowMs`.
 * Pure over its inputs (no I/O, no clock) so the matching rules have their own unit tests.
 * Non-warning events, warnings whose message is not a string, and warnings older than the
 * window are ignored; a warning's headline is everything after the prefix. */
export function flakeKeys(
  events: readonly HarnessEvent[],
  now: number,
  windowMs: number = KNOWN_FLAKE_WINDOW_MS,
): Set<string> {
  const cutoff = now - windowMs;
  const keys = new Set<string>();
  for (const e of events) {
    if (e.type !== "warning" || typeof e.message !== "string") continue;
    if (typeof e.ts === "number" && e.ts < cutoff) continue;
    const at = e.message.indexOf(FLAKY_WARNING_PREFIX);
    if (at < 0) continue;
    keys.add(normalizeClusterKey(e.message.slice(at + FLAKY_WARNING_PREFIX.length)));
  }
  return keys;
}

/** Whether `headline` matches a flake warning the gate logged within the last
 * KNOWN_FLAKE_WINDOW_MS, read from the live log and its one archived generation. */
export function isKnownFlake(root: string, headline: string): boolean {
  const { events } = readEventsSince(root, KNOWN_FLAKE_WINDOW_MS);
  return flakeKeys(events, Date.now()).has(normalizeClusterKey(headline));
}
