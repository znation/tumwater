import test from "node:test";
import assert from "node:assert/strict";
import { checkFallbackList, checkRetiredSelector } from "../src/config/config-selector-checks.js";

// src/config/config-selector-checks.ts holds the model-selector and fallback-chain checks
// validateConfig runs on each model-choosing section. test/config-validation.test.ts and
// test/config-validation-model.test.ts pin the `checkSelectorValue` half-rules and the
// empty-selector-half, id-names-backend, and bare-claude-id branches end-to-end through
// validateConfig, but the two branches below are the ones that have never been pinned: a
// `fallback` list's element rules (checkFallbackList) and a provider/model id named on the
// `claude` backend (checkRetiredSelector) — the rules that keep a mispriced fallback element
// from passing validation silently. These drive the two functions in isolation and pin each
// branch as the exact problem string it pushes, so a wording drift or a dropped rule is caught.

test("checkFallbackList: an empty fallback list is rejected as a whole", () => {
  const problems: string[] = [];
  checkFallbackList("fallback", [], problems);
  // One problem, naming the empty list and the edit.
  assert.deepEqual(problems, [
    `fallback list must not be empty — name at least one model id`,
  ]);
});

test("checkFallbackList: a blank-string element is not a model id", () => {
  const problems: string[] = [];
  // A zero-length string is non-blank-false, so it is not a model id and not an object step.
  // The element index is 0 (the array is [""], not [undefined]).
  checkFallbackList("fallback", [""], problems);
  assert.deepEqual(problems, [
    `fallback list element 0 must be a non-empty model id or a step object (got "")`,
  ]);
});

test("checkFallbackList: a non-string element is not a model id or step", () => {
  const problems: string[] = [];
  // The number 5 is neither a non-blank string nor an object step.
  checkFallbackList("fallback", [5], problems);
  assert.deepEqual(problems, [
    `fallback list element 0 must be a non-empty model id or a step object (got 5)`,
  ]);
});

test("checkFallbackList: a \"pause\" element is refused because a list is tried element by element", () => {
  const problems: string[] = [];
  checkFallbackList("fallback", ["pause"], problems);
  assert.deepEqual(problems, [
    `fallback list element 0 is "pause" — "pause" is only valid as a whole-tier value`,
  ]);
});

test("checkFallbackList: a clean provider/model id element passes the element rules", () => {
  const problems: string[] = [];
  // "omlx/a" parses to both halves and names no backend, so on the default "pi" backend it
  // trips neither the element rule nor the retired-spelling rule: nothing is pushed.
  checkFallbackList("fallback", ["omlx/a"], problems);
  assert.deepEqual(problems, []);
});

test("checkRetiredSelector: a provider/model id on the claude backend is a mis-price", () => {
  const problems: string[] = [];
  // "omlx/llama3.1" carries a slash, so it is a provider/model id; on the claude backend pi
  // would run it as a paid claude model. This is the branch no other test pins.
  checkRetiredSelector("model", "omlx/llama3.1", "claude", problems);
  assert.deepEqual(problems, [
    `model "omlx/llama3.1" is a provider/model id but the backend is claude, which would run it as a paid claude model — add backend: "pi" beside it`,
  ]);
});

test("checkRetiredSelector: a bare (no-slash) selector on the claude backend is not a mis-price", () => {
  const problems: string[] = [];
  // "llama3.1" has no slash, so it is not a provider/model id; only that shape is the mis-price
  // risk, and a bare id on claude is a legitimate claude id. (It does not start with "claude-",
  // so the bare-claude-id branch does not fire either.) Nothing is pushed.
  checkRetiredSelector("model", "llama3.1", "claude", problems);
  assert.deepEqual(problems, []);
});
