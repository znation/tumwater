import test from "node:test";
import assert from "node:assert/strict";
import {
  checkReservedArgs,
  codexConfigKey,
  typeName,
} from "../src/config/config-field-checks.js";

// The generic field-check machinery behind validateConfig (src/config/config-field-checks.ts):
// the pure error-message rendering (typeName), the reserved-flag guard (checkReservedArgs), and
// codex's arity-aware `-c <key>=…` token parser (codexConfigKey). These have no direct test
// file — the suite reaches them only through config-validation's whole-file reports, which never
// exercise the parser's joined `-c=` spellings or the guard's skip rules as units.

test("typeName names the JSON top-level kinds", () => {
  assert.equal(typeName(null), "null");
  assert.equal(typeName([]), "an array");
  assert.equal(typeName("x"), "string");
  assert.equal(typeName(1), "number");
  assert.equal(typeName(true), "boolean");
  assert.equal(typeName({}), "object");
  assert.equal(typeName(undefined), "undefined");
});

test("checkReservedArgs flags only string args whose flag is reserved, naming each position", () => {
  const whyFor = (flag: string) => (flag === "--model" || flag === "--settings" ? "tumwater sets it" : undefined);

  const problems: string[] = [];
  checkReservedArgs(problems, ["--model", "x", "--other", 42, "--settings"], "backends.codex.args", whyFor);
  assert.deepEqual(problems, [
    'backends.codex.args[0] "--model" duplicates a flag tumwater sets — tumwater sets it',
    'backends.codex.args[4] "--settings" duplicates a flag tumwater sets — tumwater sets it',
  ], "a non-string arg and a non-reserved flag both pass");
});

test("checkReservedArgs matches the flag even when it carries its value as --flag=value", () => {
  const problems: string[] = [];
  checkReservedArgs(problems, ["--model=claude-sonnet-5-5"], "args", (flag) =>
    flag === "--model" ? "reserved" : undefined,
  );
  assert.deepEqual(problems, ['args[0] "--model=claude-sonnet-5-5" duplicates a flag tumwater sets — reserved']);
});

test("codexConfigKey reads the key from the joined -c and --config spellings", () => {
  // -c<key>=<value> (joined, codex's single-token form) and -c=<key>=<value>.
  assert.equal(codexConfigKey("-cmodel=x", undefined), "model");
  assert.equal(codexConfigKey("-c=model_reasoning_effort=high", undefined), "model_reasoning_effort");
  assert.equal(codexConfigKey("--config=web_search=on", undefined), "web_search");
  // The separate-token form: -c and --config pass the next element as the key-bearing token.
  assert.equal(codexConfigKey("-c", "model=x"), "model");
  assert.equal(codexConfigKey("--config", "sandbox_mode=read-only"), "sandbox_mode");
  // An empty key or an absent next token carries no key.
  assert.equal(codexConfigKey("-c", undefined), undefined);
  assert.equal(codexConfigKey("-c=", undefined), undefined);
  assert.equal(codexConfigKey("--config=", undefined), undefined);
});

test("codexConfigKey leaves non-key tokens alone", () => {
  assert.equal(codexConfigKey("--sandbox", "x"), undefined, "an unrelated flag reads no key");
  assert.equal(codexConfigKey("plain", undefined), undefined, "a bare token that is not -c is untouched");
  assert.equal(codexConfigKey("--configx=3", undefined), undefined, "-configx is not --config");
  assert.equal(codexConfigKey("-", undefined), undefined, "a lone dash is not -c");
});
