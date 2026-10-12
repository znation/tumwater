import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config/config-validation.js";
import { validationError } from "./fixtures/config-fixtures.js";

// validateConfig's `check` section (src/config/config-validation.ts): the gate's configurable
// verification command (plans/portability.md). Split from test/config-validation.test.ts
// (2026-10-11) so the section's silent-acceptance regression coverage has a home of its own.

// --- the `check` section: the gate's configurable verification command (plans/portability.md) ---
// validateConfig's check block had no direct tests: a regression there would silently accept a
// typo'd or wrongly-typed check section (the exact silent-ignore class the schema exists to
// catch), or crash on a non-object check.
test("validateConfig accepts a valid check section and its absence", () => {
  assert.doesNotThrow(() => validateConfig({ provider: "p", model: "m" })); // No check at all.
  assert.doesNotThrow(() =>
    validateConfig({ provider: "p", model: "m", check: { command: "cargo test" } }),
  );
  assert.doesNotThrow(() =>
    validateConfig({
      provider: "p",
      model: "m",
      check: { command: "cargo fmt --check && cargo test", cwd: "server", timeoutSeconds: 300 },
    }),
  );
});

test("validateConfig rejects a non-object check section", () => {
  // A string is the plausible typo (`"check": "cargo test"`); an array and null are named too.
  assert.match(
    validationError({ provider: "p", model: "m", check: "cargo test" }),
    /check must be an object \(got "cargo test"\)/,
  );
  assert.match(
    validationError({ provider: "p", model: "m", check: ["cargo test"] }),
    /check must be an object \(got \["cargo test"\]\)/,
  );
  assert.match(
    validationError({ provider: "p", model: "m", check: null }),
    /check must be an object \(got null\)/,
  );
});

test("validateConfig rejects a typo'd key inside check", () => {
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "cargo test", timeOut: 5 } }),
    /unknown key "timeOut" in check \(valid keys: command, gateCommand, cwd, timeoutSeconds\)/,
  );
});

// check.gateCommand (PLANS.md Land-queue speed 3e): the opt-in cheaper gate-only check. A string
// like command, but blank is accepted as "off" — falling back runs the FULL check at the gate,
// the stronger one, so an empty value can never make the gate silently weaker.
test("validateConfig accepts check.gateCommand, blank as off, and rejects a non-string one", () => {
  for (const gateCommand of ["npm test build-check", "", "  "]) {
    assert.doesNotThrow(() =>
      validateConfig({ provider: "p", model: "m", check: { command: "npm test", gateCommand } }),
    );
  }
  // An npm repo keeps the walk-up for the full check and names only the gate's.
  assert.doesNotThrow(() => validateConfig({ provider: "p", model: "m", check: { gateCommand: "x" } }));
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "npm test", gateCommand: 42 } }),
    /check\.gateCommand must be a string \(got 42\)/,
  );
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "npm test", gateCommand: ["a"] } }),
    /check\.gateCommand must be a string \(got \["a"\]\)/,
  );
});

test("validateConfig rejects a blank or non-string check.command", () => {
  // A blank command is the silent-ignore class: the operator named a check, so an empty value
  // must fail validation, not quietly fall back to npm detection.
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "   " } }),
    /check\.command must not be empty \(got "   "\)/,
  );
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: 42 } }),
    /check\.command must be a string \(got 42\)/,
  );
});

test("validateConfig rejects a wrongly-typed check.cwd and non-positive timeoutSeconds", () => {
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "x", cwd: 7 } }),
    /check\.cwd must be a string \(got 7\)/,
  );
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "x", timeoutSeconds: 0 } }),
    /check\.timeoutSeconds must be a number greater than 0, at most 2147483 \(got 0\)/,
  );
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "x", timeoutSeconds: -30 } }),
    /check\.timeoutSeconds must be a number greater than 0, at most 2147483 \(got -30\)/,
  );
});

test("validateConfig collects every check-section problem into one message", () => {
  const err = validationError({
    provider: "p",
    model: "m",
    check: { command: 5, cwd: 7, timeoutSeconds: -1, timoutSeconds: 2 },
  });
  assert.match(err, /unknown key "timoutSeconds" in check/);
  assert.match(err, /check\.command must be a string/);
  assert.match(err, /check\.cwd must be a string/);
  assert.match(err, /check\.timeoutSeconds must be a number greater than 0/);
  // All four named in one throw, so a single edit fixes them all — one bullet per problem.
  assert.equal(err.split("\n").filter((l) => l.trim().startsWith("-")).length, 4);
});

