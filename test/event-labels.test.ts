import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPE_LABELS, RUN_RESULT_LABELS, eventTypeLabel } from "../src/events/event-labels.js";

test("every label is a lowercase phrase without underscores", () => {
  for (const [code, label] of [...Object.entries(EVENT_TYPE_LABELS), ...Object.entries(RUN_RESULT_LABELS)]) {
    assert.match(label, /^[a-z][^_]*$/, code);
  }
});

test("event types and result codes are disjoint", () => {
  for (const key of Object.keys(RUN_RESULT_LABELS)) assert.ok(!Object.hasOwn(EVENT_TYPE_LABELS, key), key);
});

test("eventTypeLabel serves both families and falls back to spaced words", () => {
  assert.equal(eventTypeLabel("run_end"), "run finished");
  assert.equal(eventTypeLabel("no_change"), "no change");
  assert.equal(eventTypeLabel("some_new_type"), "some new type");
  assert.equal(eventTypeLabel("constructor"), "constructor");
});

test("issue_filed labels as a lowercase phrase", () => {
  assert.equal(EVENT_TYPE_LABELS.issue_filed, "issue filed");
  assert.equal(eventTypeLabel("issue_filed"), "issue filed");
});
