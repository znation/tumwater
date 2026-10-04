/** An event-log fixture builder, under the shared test-fake catalog (test/fakes/,
 * PLANS.md 2026-10-04): typed constructors for the harness events the digest and history
 * fixes had to improvise by hand (`tick_end`/`tick_start`/`review_verdict`/`build_check`
 * literals with `as HarnessEvent` casts, each file spelling the defaults slightly
 * differently) plus a one-call writer that stamps them into a scratch repo's
 * `.tumwater/log/events.jsonl` via log-fixtures's `writeEvents`. The builders default to
 * the shape the real writers stamp (feature loop, tick 1, changed); overrides pass through.
 * Node built-ins only.
 */
import type { HarnessEvent } from "../../src/events.js";
import { writeEvents } from "../log-fixtures.js";

/** A `tick_end` event with the shape tick-finalize stamps: the feature loop, tick 1,
 * `changed`. Overrides pass through (`tickEnd({ result: "error", error: "pi unreachable" })`). */
export function tickEnd(over: Partial<HarnessEvent> = {}): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_end", tick: 1, result: "changed", ...over } as HarnessEvent;
}

/** A `tick_start` event, the pairing half tickRows reads durations from. */
export function tickStart(over: Partial<HarnessEvent> = {}): HarnessEvent {
  return { ts: 0, loop: "feature", type: "tick_start", tick: 1, ...over } as HarnessEvent;
}

/** An approved `review_verdict` event over `head` (40 hex chars expected), with the
 * reviewer run's duration when given. */
export function reviewVerdict(head: string, over: Partial<HarnessEvent> = {}): HarnessEvent {
  return { ts: 0, loop: "harness", type: "review_verdict", head, ...over } as HarnessEvent;
}

/** A `build_check` event: scope `gate`, status `passed`, the check's script and duration. */
export function buildCheck(
  over: Partial<HarnessEvent> & { scope: string; status: string; script: string; durationMs: number },
): HarnessEvent {
  return { ts: 0, loop: "harness", type: "build_check", ...over } as HarnessEvent;
}

/** Write `events` as a well-formed harness event log under `root`'s .tumwater/log/
 * events.jsonl — the one call the CLI/report tests need to seed a scratch repo's log. */
export function writeEventLog(root: string, events: readonly HarnessEvent[]): void {
  writeEvents(root, [...events]);
}