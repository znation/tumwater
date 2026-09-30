import test from "node:test";
import assert from "node:assert/strict";
import {
  eventDayKey,
  eventRole,
  eventUsage,
  tickSpanMs,
  tickStartMap,
} from "../src/event-read.js";
import type { HarnessEvent } from "../src/events.js";
import { dayKey as dayKeyOracle } from "./oracles.js";

// The read side's per-event query conventions — eventRole, eventUsage, eventDayKey, and the
// tick_start↔tick_end pairing (tickStartMap/tickSpanMs) — are the rules the history rows, the
// usage report, and the failure digest all share. These tests pin those conventions directly:
// what a corrupt or absent field contributes, and what an unpaired tick end costs.

function ev(extra: Partial<HarnessEvent> & { ts?: number }): HarnessEvent {
  return { ts: 1000, loop: "feature", type: "tick_end", ...extra } as HarnessEvent;
}

test("eventRole answers '?' for absent, empty, and non-string loop fields", () => {
  assert.equal(eventRole({ ts: 1, type: "wake" } as HarnessEvent), "?"); // no loop at all
  assert.equal(eventRole(ev({ loop: "" })), "?"); // empty: not a real role grouping
  assert.equal(eventRole(ev({ loop: 42 as unknown as string })), "?"); // corrupt field
  assert.equal(eventRole(ev({ loop: "director" })), "director");
});

test("eventUsage coerces non-numeric or non-finite usage to 0 and passes real numbers through", () => {
  assert.deepEqual(eventUsage(ev({ tokens: 120, costUsd: 0.5 })), { tokens: 120, costUsd: 0.5 });
  // `unknown` through the index signature: absent, wrong-typed, NaN, and Infinity all read as 0,
  // so a corrupt line contributes nothing instead of poisoning a report's totals with NaN.
  assert.deepEqual(eventUsage(ev({})), { tokens: 0, costUsd: 0 });
  assert.deepEqual(eventUsage(ev({ tokens: "many" as unknown as number })), {
    tokens: 0,
    costUsd: 0,
  });
  assert.deepEqual(
    eventUsage(ev({ tokens: Number.NaN, costUsd: Number.POSITIVE_INFINITY })),
    { tokens: 0, costUsd: 0 },
  );
});

test("eventDayKey buckets by ts and answers null when ts is not a number", () => {
  // The expectation is a local-day oracle built from raw date parts (never datetime.ts), so a
  // drift in eventDayKey's keying fails the assertion instead of matching its own output.
  const ts = new Date().setHours(12, 0, 0, 0);
  assert.equal(eventDayKey(ev({ ts })), dayKeyOracle(ts));
  assert.equal(eventDayKey({ ts: "not a number" } as unknown as HarnessEvent), null);
  assert.equal(eventDayKey({} as HarnessEvent), null);
});

test("tickStartMap pairs only tick_start events by loop#tick", () => {
  const starts = tickStartMap([
    ev({ type: "tick_start", loop: "feature", tick: 7, ts: 100 }),
    ev({ type: "tick_end", loop: "feature", tick: 7, ts: 150 }), // not a start: ignored
    ev({ type: "tick_start", loop: "director", tick: 7, ts: 200 }), // same tick, other role
    ev({ type: "tick_start", loop: "feature", tick: 8, ts: 300 }),
  ]);
  assert.deepEqual(
    [...starts.entries()],
    [
      ["feature#7", 100],
      ["director#7", 200],
      ["feature#8", 300],
    ],
  );
});

test("tickSpanMs measures start→end, clamps negatives to 0, and reads an unpaired end as null", () => {
  const starts = tickStartMap([ev({ type: "tick_start", loop: "feature", tick: 1, ts: 500 })]);
  assert.equal(tickSpanMs(ev({ tick: 1, ts: 1750 }), starts), 1250);
  // A clock skew (end stamped before its start) must not price a negative span.
  assert.equal(tickSpanMs(ev({ tick: 1, ts: 400 }), starts), 0);
  // Rotation cut the start out of the window: no pairing, no invented cost.
  assert.equal(tickSpanMs(ev({ tick: 2, ts: 900 }), starts), null);
  assert.equal(tickSpanMs(ev({ tick: 1, ts: 600 }), tickStartMap([])), null);
});


