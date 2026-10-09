import test from "node:test";
import assert from "node:assert/strict";
import {
  finiteNumber,
  isJsonObject,
  nonNegativeNumber,
  parseJsonObject,
  stringList,
} from "../src/files/json-object.js";

// src/files/json-object.ts is the one definition of "a JSON object at this position" for every
// consumer
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

// stringList is the one home of the "an event/record field is the list or it is nothing" read.
// Its job is to make the formatters safe: every returned element must be a string, so a
// corrupt array-shaped field can never reach a `.join()` as "[object Object]" or a
// truncateExample(...).trim() as an object.
test("stringList keeps only the string entries of a mixed array", () => {
  assert.deepEqual(stringList(["pi", { a: 1 }, "ink", 3, null, ["x"]]), ["pi", "ink"]);
  assert.deepEqual(stringList([]), []);
  assert.deepEqual(stringList(["b", "a", "b"]), ["b", "a", "b"], "order and duplicates are kept");
});

test("stringList reads a non-array field as the empty list", () => {
  for (const value of [{ a: 1 }, null, undefined, "ink", 3, true]) {
    assert.deepEqual(stringList(value), [], `${JSON.stringify(value)} is not a string list`);
  }
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

// finiteNumber and nonNegativeNumber are the one home of the "the field is a usable number or it
// is nothing" read, and their whole point is the poison values a lenient `typeof x === "number"`
// check lets through: NaN and ±Infinity make every comparison false (a NaN cost silently never
// trips the budget cap) and a negative amount runs an accumulator backwards. Consumers exercise
// the happy path, so pin the rejections at the helper itself — dropping Number.isFinite or the
// `>= 0` floor must fail here, not just shift a dashboard cell.
test("finiteNumber accepts any finite number, negative included, and rejects poison", () => {
  assert.equal(finiteNumber(0, -1), 0);
  assert.equal(finiteNumber(1.5, -1), 1.5);
  assert.equal(finiteNumber(-3, -1), -3, "negative is finite, so it passes: the floor is not here");
  for (const poison of [NaN, Infinity, -Infinity, "5", null, undefined, {}, [], true]) {
    assert.equal(finiteNumber(poison, 42), 42, `${String(poison)} is not a finite number`);
  }
  assert.equal(finiteNumber(undefined, null), null, "the fallback is returned as typed, not coerced");
  assert.equal(finiteNumber(undefined, Infinity), Infinity, "an Infinity fallback is a caller's sentinel");
});

test("nonNegativeNumber keeps zero and positives, rejects negatives and poison", () => {
  assert.equal(nonNegativeNumber(0, 9), 0, "zero is the boundary the >= 0 floor keeps");
  assert.equal(nonNegativeNumber(2.5, 9), 2.5);
  for (const poison of [-1, -0.0001, NaN, Infinity, -Infinity, "5", null, undefined, {}, []]) {
    assert.equal(nonNegativeNumber(poison, 9), 9, `${String(poison)} is not a non-negative number`);
  }
  assert.equal(nonNegativeNumber(undefined, null), null, "an absent field returns the caller's fallback");
});

// parseJsonObject is the line-oriented parsers' "read one JSON value or read it as no data"
// policy: a torn or partial line, or a syntactically valid scalar/null/array, must read as
// nothing rather than a truthy stand-in the caller then indexes.
test("parseJsonObject parses an object and reads every other JSON value as no data", () => {
  assert.deepEqual(parseJsonObject('{"role":"feature","ticks":3}'), { role: "feature", ticks: 3 });
  assert.deepEqual(parseJsonObject("  {\"a\":{\"b\":2}}  "), { a: { b: 2 } }, "surrounding whitespace is tolerated");
  for (const text of ["null", "[]", "[1,2]", '"x"', "5", "true", "", "not json", "{"]) {
    assert.equal(parseJsonObject(text), null, `\`${text}\` is not a JSON object`);
  }
});
