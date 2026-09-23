import test from "node:test";
import assert from "node:assert/strict";
import { isJsonObject } from "../src/json-object.js";

// json-object.ts is the one definition of "a JSON object at this position" for every consumer
// that parses untrusted JSON — the state/marker/info files, the harness event log, pi's stdout
// log lines, an HTTP request body, tumwater.json's sections, a model's cost map, the qa coverage
// ledger. The three-part check (typeof object, not null, not an array) is easy to spell out
// slightly differently at one site while the others accept the same torn/foreign value, so these
// tests pin the whole contract at the single source: everything JSON.parse can yield at a
// position, plus the narrowing behavior the callers lean on.

test("a plain object is a JSON object, narrowed to an indexable record", () => {
  const value: unknown = JSON.parse('{"role":"feature","ticks":3}');
  assert.equal(isJsonObject(value), true);
  // The narrowing must make property access usable without an added cast — the reason the
  // guard exists rather than each caller re-spelling the three-part check.
  if (isJsonObject(value)) {
    const record: Record<string, unknown> = value;
    assert.equal(record["role"], "feature");
    assert.equal(record["missing"], undefined, "indexing a narrowed record is safe, never a throw");
  }
});

test("JSON null is not a JSON object (JSON.parse(\"null\") succeeds)", () => {
  // A bare typeof x === "object" passes for null, and indexing it throws — this clause is
  // part of the definition, not an extra.
  assert.equal(isJsonObject(null), false);
  assert.equal(isJsonObject(JSON.parse("null")), false);
});

test("an array is not a JSON object (an array is an object in JS)", () => {
  assert.equal(isJsonObject([]), false);
  assert.equal(isJsonObject([1, 2]), false);
  assert.equal(isJsonObject(JSON.parse("[1,2]")), false);
  assert.equal(isJsonObject(JSON.parse('[{"a":1}]')), false);
});

test("scalar values are not JSON objects", () => {
  assert.equal(isJsonObject(undefined), false);
  assert.equal(isJsonObject("role"), false);
  assert.equal(isJsonObject(42), false);
  assert.equal(isJsonObject(0), false);
  assert.equal(isJsonObject(true), false);
  assert.equal(isJsonObject(false), false);
});

test("a nested empty object is still a JSON object", () => {
  // Consumers index the parsed value before knowing its shape (e.g. a config section that is
  // expected to hold fields but may be `{}`), so emptiness must not change the verdict.
  assert.equal(isJsonObject({}), true);
  assert.equal(isJsonObject(JSON.parse("{}")), true);
});

test("non-plain host objects behave as the typeof check reads them", () => {
  // JSON.parse can never yield a Date, Map, or function, so these never reach a guard in the
  // harness — but the contract is the three-part check, and pinning what it does with host
  // objects keeps a future refactor (e.g. adding a prototype check) a deliberate decision
  // rather than an accidental consumer break.
  assert.equal(isJsonObject(new Date()), true, "a Date is an object, not null, not an array");
  assert.equal(isJsonObject(new Map()), true, "a Map is an object, not null, not an array");
  assert.equal(isJsonObject(() => {}), false, "a function is typeof \"function\", so the guard rejects it");
});
