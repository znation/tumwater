import test from "node:test";
import assert from "node:assert/strict";
import { checkMinRunInterval } from "../src/config/config-keys.js";

// src/config/config-keys.ts holds the per-key value validators the write surfaces run before a
// write. Its two siblings, `checkDailyBudgetUsd` and `checkQuietHours`, are already exercised
// end-to-end through `config set` and the GUI; `checkMinRunInterval` is the one with no test of
// its own. It is the single home of the rule that decides whether an interval value is acceptable:
// a finite number of 0 or more, at most MAX_DURATION_SECONDS (the ×1000 setTimeout bound the
// config duration rules share). Both write surfaces that name a min-run-interval key — the TUI
// interval editor and the dashboard role-interval endpoint — run it, and a value that fails is
// flashed to the user with the returned message, so that message wording is the observable
// contract. These drive the function in isolation and pin each branch as the exact string it
// returns, so a dropped rule or a wording drift is caught.

test("checkMinRunInterval: a finite number of 0 or more within the bound passes", () => {
  // 60, 0, and 1 are ordinary intervals; 2147483 is MAX_DURATION_SECONDS itself, the inclusive
  // upper bound. None trips the guard, so each returns null.
  assert.equal(checkMinRunInterval(60), null);
  assert.equal(checkMinRunInterval(0), null);
  assert.equal(checkMinRunInterval(1), null);
  assert.equal(checkMinRunInterval(2147483), null);
});

test("checkMinRunInterval: a value one past the bound is rejected naming the bound and the value", () => {
  // 2147484 is MAX_DURATION_SECONDS + 1, so `value > MAX_DURATION_SECONDS` trips and the message
  // names the default key, the bound, and the offending value.
  assert.equal(
    checkMinRunInterval(2147484),
    "minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got 2147484)",
  );
});

test("checkMinRunInterval: a negative number is rejected", () => {
  // -1 trips `value < 0`; a finite number spells itself out in the message, so the guard's
  // "0 or more" half is pinned here (the over-bound half is pinned above).
  assert.equal(
    checkMinRunInterval(-1),
    "minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got -1)",
  );
});

test("checkMinRunInterval: a non-finite number is rejected and spelled out", () => {
  // NaN and Infinity fail `!Number.isFinite`; `show()` spells a non-finite number with String()
  // rather than JSON.stringify, whose "null" would name a value the user never wrote.
  assert.equal(
    checkMinRunInterval(NaN),
    "minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got NaN)",
  );
  assert.equal(
    checkMinRunInterval(Infinity),
    "minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got Infinity)",
  );
});

test("checkMinRunInterval: a non-number is rejected naming the JSON-quoted value, or missing for undefined", () => {
  // "60" is a string, not a number: `show()` quotes it with JSON.stringify. null is not a
  // number and JSON.stringify reads "null"; undefined reads "missing" (the key is absent).
  assert.equal(
    checkMinRunInterval("60"),
    'minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got "60")',
  );
  assert.equal(
    checkMinRunInterval(null),
    "minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got null)",
  );
  assert.equal(
    checkMinRunInterval(undefined),
    "minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got missing)",
  );
});

test("checkMinRunInterval: an explicit key leads the message", () => {
  // A per-role override passes roles.<id>.minRunIntervalSeconds so a rejected entry names the
  // key actually set, matching what the dashboard endpoint and the TUI editor flash.
  assert.equal(
    checkMinRunInterval(-1, "roles.feature.minRunIntervalSeconds"),
    "roles.feature.minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got -1)",
  );
});
