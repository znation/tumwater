import test from "node:test";
import assert from "node:assert/strict";
import {
  deliverableAt,
  deliverableNow,
  notBeforeMarker,
  notBeforeMs,
  stripNotBeforeMarker,
} from "../src/inbox/prompt-not-before.js";

test("notBeforeMarker round-trips through notBeforeMs to the millisecond and strips to the body", () => {
  const at = 1_700_000_000_123;
  assert.equal(notBeforeMs(notBeforeMarker(at) + "body"), at);
  assert.equal(stripNotBeforeMarker(notBeforeMarker(at) + "body"), "body");
  const doubled = notBeforeMarker(at) + notBeforeMarker(at + 1) + "body";
  assert.equal(stripNotBeforeMarker(doubled), notBeforeMarker(at + 1) + "body");
});

test("a writer-shaped stamp that Date.parse rejects is neither deferred nor stripped", () => {
  const text = "tumwater:not-before 2030-13-45T25:61:00.000Z\n\nbody";
  assert.equal(notBeforeMs(text), null);
  assert.equal(stripNotBeforeMarker(text), text);
  assert.equal(deliverableNow(text, 0), true);
});

test("deliverableAt delivers at the stamp's own millisecond, not before", () => {
  assert.equal(deliverableAt(null, 0), true);
  assert.equal(deliverableAt(5, 5), true);
  assert.equal(deliverableAt(6, 5), false);
  assert.equal(deliverableNow(notBeforeMarker(5) + "x", 4), false);
  assert.equal(deliverableNow(notBeforeMarker(5) + "x", 5), true);
});
