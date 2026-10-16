import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { validationError } from "./fixtures/config-fixtures.js";

// validateConfig's numeric and window limits (src/config/config-validation.ts): the budget caps,
// the disk-floor and idle-reclaim thresholds, the duration-second timer bounds, and the quiet
// hours windows (fleet-wide and per-role). Split from test/config-validation.test.ts
// (2026-10-11) so the value rules that silently accept a bad bound read on their own.

test("validateConfig accepts a well-formed maxDailyCostUsdPerRole map and rejects bad ones", () => {
  // Absent key: the pre-feature shape, still valid.
  assert.doesNotThrow(() => validateConfig(defaultConfig()));
  // Built-in ids, a customLoops name, and the disabled 0 are all valid.
  assert.doesNotThrow(() =>
    validateConfig({
      ...defaultConfig(),
      maxDailyCostUsdPerRole: { organize: 0.5, coverage: 0 },
      customLoops: [{ name: "sniff", task: "Run the linter and fix what it names." }],
    }),
  );
  assert.doesNotThrow(() =>
    validateConfig({
      ...defaultConfig(),
      maxDailyCostUsdPerRole: { sniff: 1 },
      customLoops: [{ name: "sniff", task: "Run the linter and fix what it names." }],
    }),
  );

  // A non-object value names the expected shape.
  assert.match(
    validationError({ ...defaultConfig(), maxDailyCostUsdPerRole: 5 }),
    /maxDailyCostUsdPerRole must be an object mapping role ids to USD caps \(got 5\)/,
  );
  // An unknown id is the roles.<id> idiom — a typo must fail fast, never silently no-op a cap.
  assert.match(
    validationError({ ...defaultConfig(), maxDailyCostUsdPerRole: { organiz: 1 } }),
    /maxDailyCostUsdPerRole\.organiz is not a known role \(valid ids: /,
  );
  // The value shapes: negative, non-numeric, and non-finite each fail with the wording
  // (which also carries the MAX_SAFE_INTEGER bound, so the old bare-wording assertions
  // were updated when the bound was added). checkNumberField places the got-value in
  // its own parenthetical after the rule's what-text.
  const perRoleWhat = `maxDailyCostUsdPerRole\\.organize must be a number of 0 or more, at most ${Number.MAX_SAFE_INTEGER} \\(0 disables\\)`;
  assert.match(
    validationError({ ...defaultConfig(), maxDailyCostUsdPerRole: { organize: -1 } }),
    new RegExp(perRoleWhat + ` \\(got -1\\)`),
  );
  assert.match(
    validationError({ ...defaultConfig(), maxDailyCostUsdPerRole: { organize: "1" } }),
    new RegExp(perRoleWhat + ` \\(got "1"\\)`),
  );
  assert.match(
    validationError({ ...defaultConfig(), maxDailyCostUsdPerRole: { organize: Number.POSITIVE_INFINITY } }),
    new RegExp(perRoleWhat + ` \\(got Infinity\\)`),
  );
});

test("maxDailyCostUsdPerRole rejects a finite-but-unrepresentable cap past MAX_SAFE_INTEGER", () => {
  // BUGS.md 2026-10-02: the per-role sibling of the fixed maxDailyCostUsd gap — 1e24 is
  // finite, so the old non-finite/negative rule admitted it, and a one-zero typo in a
  // per-role cap wrote an effectively uncapped budget for that role.
  assert.match(
    validationError({ ...defaultConfig(), maxDailyCostUsdPerRole: { organize: 1e24 } }),
    new RegExp(
      `maxDailyCostUsdPerRole\\.organize must be a number of 0 or more, at most ${Number.MAX_SAFE_INTEGER} \\(0 disables\\) \\(got 1e\\+24\\)`,
    ),
  );
  assert.equal(
    validateConfig({ ...defaultConfig(), maxDailyCostUsdPerRole: { organize: Number.MAX_SAFE_INTEGER } }),
    undefined,
  );
});

test("diskHoldGB accepts 0 or a positive number and rejects a negative or non-number", () => {
  // plans/disk-floor.md part 1/4: 0 disables the hold, so only a negative value or a
  // non-number is a problem.
  assert.equal(validateConfig({ ...defaultConfig(), diskHoldGB: 0 }), undefined);
  assert.equal(validateConfig({ ...defaultConfig(), diskHoldGB: 5 }), undefined);
  assert.match(
    validationError({ ...defaultConfig(), diskHoldGB: -1 }),
    /diskHoldGB must be a number of 0 or more \(got -1\)/,
  );
  assert.match(
    validationError({ ...defaultConfig(), diskHoldGB: "10" }),
    /diskHoldGB must be a number of 0 or more \(got "10"\)/,
  );
});

test("diskReclaimGB accepts 0 or a number at least diskHoldGB and rejects a lower one", () => {
  // plans/disk-floor.md part 2/4: 0 disables pressure reclaim; a nonzero threshold below the
  // hold floor would trigger only after the hold already engaged.
  assert.equal(validateConfig({ ...defaultConfig(), diskHoldGB: 10, diskReclaimGB: 0 }), undefined);
  assert.equal(validateConfig({ ...defaultConfig(), diskHoldGB: 10, diskReclaimGB: 10 }), undefined);
  assert.equal(validateConfig({ ...defaultConfig(), diskHoldGB: 10, diskReclaimGB: 40 }), undefined);
  assert.match(
    validationError({ ...defaultConfig(), diskHoldGB: 10, diskReclaimGB: 5 }),
    /diskReclaimGB \(5\) must be at least diskHoldGB \(10\) unless it is 0/,
  );
  assert.match(
    validationError({ ...defaultConfig(), diskReclaimGB: -1 }),
    /diskReclaimGB must be a number of 0 or more \(got -1\)/,
  );
});

test("worktreeIdleReclaimHours accepts 0 or a positive number and rejects a negative one", () => {
  // plans/disk-floor.md part 3/4: 0 disables idle reclaim; a negative value is meaningless.
  assert.equal(validateConfig({ ...defaultConfig(), worktreeIdleReclaimHours: 0 }), undefined);
  assert.equal(validateConfig({ ...defaultConfig(), worktreeIdleReclaimHours: 24 }), undefined);
  assert.match(
    validationError({ ...defaultConfig(), worktreeIdleReclaimHours: -1 }),
    /worktreeIdleReclaimHours must be a number of 0 or more \(got -1\)/,
  );
});

test("maxDailyCostUsd rejects a finite-but-unrepresentable cap past MAX_SAFE_INTEGER", () => {
  // BUGS.md 2026-10-02: 1e24 is finite, so the old NON_NEGATIVE_OR_DISABLED rule admitted
  // it, and `config set`/the GUI's /api/config-set wrote an effectively uncapped budget
  // from a one-zero typo — the same boundary the TUI's parseBudgetInput and
  // checkDailyBudgetUsd now enforce.
  assert.match(
    validationError({ ...defaultConfig(), maxDailyCostUsd: 1e24 }),
    new RegExp(
      `maxDailyCostUsd must be a number of 0 or more, at most ${Number.MAX_SAFE_INTEGER} \\(0 disables\\)`,
    ),
  );
  assert.equal(validateConfig({ ...defaultConfig(), maxDailyCostUsd: Number.MAX_SAFE_INTEGER }), undefined);
});

test("duration-seconds fields reject values whose milliseconds overflow node's timer range", () => {
  // BUGS.md 2026-10-03: the seconds rules admitted any finite number, so a one-zero typo
  // (`{"runTimeoutSeconds": 1e300}`) multiplied to Infinity ms in src/agent/run-agent.ts — and
  // node's setTimeout/setInterval clamp a delay that does not fit in a signed 32-bit integer
  // down to 1ms (verified: a setTimeout(1e300*1000) fired ~2ms later), killing every pi run the
  // moment it started. All seconds fields that feed a ×1000 duration share one bound:
  // 2147483 seconds × 1000 stays inside setTimeout's 2^31−1 ms range.
  const MAX_DURATION_SECONDS = 2147483;
  const tooBig = 1e300;
  assert.match(
    validationError({ ...defaultConfig(), runTimeoutSeconds: tooBig }),
    new RegExp(`runTimeoutSeconds must be a number greater than 0, at most ${MAX_DURATION_SECONDS}`),
  );
  assert.match(
    validationError({ ...defaultConfig(), quietTimeoutSeconds: tooBig }),
    new RegExp(`quietTimeoutSeconds must be a number of 0 or more, at most ${MAX_DURATION_SECONDS} \\(0 disables\\)`),
  );
  assert.match(
    validationError({ ...defaultConfig(), toolCallStallSeconds: tooBig }),
    new RegExp(`toolCallStallSeconds must be a number of 0 or more, at most ${MAX_DURATION_SECONDS} \\(0 disables\\)`),
  );
  assert.match(
    validationError({ ...defaultConfig(), minRunIntervalSeconds: tooBig }),
    new RegExp(`minRunIntervalSeconds must be a number of 0 or more, at most ${MAX_DURATION_SECONDS}`),
  );
  assert.match(
    validationError({ ...defaultConfig(), check: { command: "npm test", timeoutSeconds: tooBig } }),
    new RegExp(`check\\.timeoutSeconds must be a number greater than 0, at most ${MAX_DURATION_SECONDS}`),
  );
  assert.match(
    validationError({ ...defaultConfig(), review: { timeoutSeconds: tooBig } }),
    new RegExp(`review\\.timeoutSeconds must be a number greater than 0, at most ${MAX_DURATION_SECONDS}`),
  );
  assert.match(
    validationError({ ...defaultConfig(), idleBackoff: { initialSeconds: tooBig } }),
    new RegExp(`idleBackoff\\.initialSeconds must be a number of 0 or more, at most ${MAX_DURATION_SECONDS}`),
  );
  // The bound itself is representable: every default sits far inside it.
  assert.equal(validateConfig({ ...defaultConfig(), runTimeoutSeconds: MAX_DURATION_SECONDS }), undefined);
  assert.equal(validateConfig({ ...defaultConfig() }), undefined);
});

// Per-role quiet hours (PLANS.md quietHoursPerRole): the same known-role gate as the caps,
// each value a quiet-hours window (empty string = off).
test("validateConfig accepts a well-formed quietHoursPerRole map and rejects bad ones", () => {
  // Absent key: the pre-feature shape, still valid.
  assert.doesNotThrow(() => validateConfig(defaultConfig()));
  // Built-in ids, a customLoops name, and the off value are all valid.
  assert.doesNotThrow(() =>
    validateConfig({
      ...defaultConfig(),
      quietHoursPerRole: { qa: "23:00-07:00", organize: "", coverage: "10:00-12:00" },
      customLoops: [{ name: "sniff", task: "Run the linter and fix what it names." }],
    }),
  );
  // A non-object names the key and shows the value.
  assert.match(
    validationError({ ...defaultConfig(), quietHoursPerRole: "23:00-07:00" }),
    /quietHoursPerRole must be an object mapping role ids to "HH:MM-HH:MM" windows \(got "23:00-07:00"\)/,
  );
  // An unknown role id names the key and the offending id (a typo would silently no-op).
  assert.match(
    validationError({ ...defaultConfig(), quietHoursPerRole: { qa2: "23:00-07:00" } }),
    /quietHoursPerRole\.qa2 is not a known role \(valid ids: /,
  );
  // A non-string value names the key, the id, and the value.
  assert.match(
    validationError({ ...defaultConfig(), quietHoursPerRole: { qa: 7 } }),
    /quietHoursPerRole\.qa must be a "HH:MM-HH:MM" string like "23:00-07:00" \(an empty string means off\) \(got 7\)/,
  );
  // A malformed window passes the parser's message through, named with key and id.
  assert.match(
    validationError({ ...defaultConfig(), quietHoursPerRole: { qa: "25:00-07:00" } }),
    /quietHoursPerRole\.qa times must be 24-hour "HH:MM" — hours 00-23, minutes 00-59/,
  );
  // A zero-length window is malformed the same way.
  assert.match(
    validationError({ ...defaultConfig(), quietHoursPerRole: { qa: "23:00-23:00" } }),
    /quietHoursPerRole\.qa start and end must differ/,
  );
});

