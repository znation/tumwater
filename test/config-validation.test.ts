import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, loadConfigSafe, saveConfig } from "../src/config/config.js";
import { show } from "../src/config/config-field-checks.js";
import { validateConfig } from "../src/config/config-validation.js";
import { allRoleIds } from "../src/roles/roles.js";
import { validationError } from "./fixtures/config-fixtures.js";
import { tmpdir, writeConfig, writeMalformedJson } from "./fixtures/repo-fixtures.js";

// Tests for src/config/config-validation.ts — validateConfig's core rules (top-level keys,
// scalars, the model/agent selectors, review, roles) — plus the load and save paths that enforce
// it (loadConfig's actionable rejections, loadConfigSafe's message form, saveConfig's
// refuse-to-persist). The section-specific suites split from this file live in
// test/config-validation-check.test.ts (the `check` section), test/config-validation-limits.test.ts
// (budget/disk/duration/quiet-hours bounds), and test/config-validation-model.test.ts (the
// fallback and model-tier forms). The rest of src/config/config.ts's surface (defaults, per-role
// views, the read cache, customRoles, the example template) stays in test/config.test.ts.

test("show renders the offending value honestly and compactly", () => {
  // Regression: JSON.stringify(Infinity) is "null", so a huge numeric literal — which
  // JSON.parse turns into Infinity — was reported as `got null` even though the user wrote a
  // number. validateConfig rejects non-finite values, so this is the only place naming them.
  assert.equal(show(Number.POSITIVE_INFINITY), "Infinity");
  assert.equal(show(Number.NEGATIVE_INFINITY), "-Infinity");
  assert.equal(show(Number.NaN), "NaN");
  assert.match(validationError({ runTimeoutSeconds: Number.POSITIVE_INFINITY }), /\(got Infinity\)/);
  // An absent key and a present-but-short value keep their existing rendering.
  assert.equal(show(undefined), "missing");
  assert.equal(show("40"), '"40"');
  assert.equal(show(null), "null");
  // A very long value is cut to keep the problem list readable, and the cut is marked.
  const long = show("x".repeat(500));
  assert.ok(long.length <= 120, `long value should be capped, got ${long.length} chars`);
  assert.ok(long.endsWith("…"), `a truncated value should end in an ellipsis: ${long}`);
});

test("validateConfig accepts defaults and fully valid overrides", () => {
  assert.doesNotThrow(() => validateConfig(defaultConfig()));
  assert.doesNotThrow(() =>
    validateConfig({
      provider: "lmstudio",
      model: "qwen",
      thinking: "high",
      piArgs: ["--foo"],
      maxConcurrent: 2,
      minRunIntervalSeconds: 0,
      runTimeoutSeconds: 60,
      logMaxBytes: 1024,
      sessionRetentionDays: 3,
      idleBackoff: { initialSeconds: 5, factor: 1.5, maxSeconds: 60 },
      roles: { feature: { enabled: false, model: "big", instructions: "be careful" } },
    }),
  );
});

test("validateConfig accepts a valid quietHours window and rejects a malformed one", () => {
  // A valid window (same-day, wrapping, or the off values) passes; the empty string is the
  // documented off, not an error.
  for (const quietHours of ["23:00-07:00", "09:00-17:00", ""])
    assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), quietHours }));

  // Malformed values fail with parseQuietHours's message: the type, the format, and the
  // zero-length window each name what to fix.
  assert.match(validationError({ ...defaultConfig(), quietHours: 7 }), /quietHours must be a string/);
  assert.match(
    validationError({ ...defaultConfig(), quietHours: "25:00-07:00" }),
    /quietHours times must be 24-hour/,
  );
  assert.match(
    validationError({ ...defaultConfig(), quietHours: "23:00" }),
    /quietHours must be "HH:MM-HH:MM"/,
  );
  assert.match(
    validationError({ ...defaultConfig(), quietHours: "23:00-23:00" }),
    /zero-length/,
  );
});

test("selector strings that parse to an empty provider or model half are rejected", () => {
  // piArgs skips an empty value when it builds its flags, and fallbackPair drops an empty
  // half, so a selector like "/id" or "p/" passes the non-empty-string rule yet never
  // reaches pi — the team silently runs pi's default model. Reject the shape instead. Under
  // a legacy provider in scope a "/" is ordinary id text, so the parse there cannot produce
  // an empty half and those selectors stay valid.
  assert.match(validationError({ model: "/id" }), /model "\/id" parses to an empty provider half/);
  assert.match(validationError({ model: "p/" }), /model "p\/" parses to an empty model half/);
  assert.match(validationError({ fallback: "/id" }), /fallback "\/id" parses to an empty provider half/);
  assert.match(validationError({ fallback: "p/" }), /fallback "p\/" parses to an empty model half/);
  assert.match(
    validationError({ roles: { feature: { model: "p/" } } }),
    /roles\.feature\.model "p\/" parses to an empty model half/,
  );
  assert.match(
    validationError({ review: { model: "/id" } }),
    /review\.model "\/id" parses to an empty provider half/,
  );
  // With a provider in scope the whole string is the id: a slash in it is ordinary text.
  assert.doesNotThrow(() => validateConfig({ provider: "huggingface", model: "a/b" }));
  assert.doesNotThrow(() =>
    validateConfig({ provider: "huggingface", roles: { feature: { model: "a/b" } } }),
  );
  // A thinking suffix does not hide an empty half.
  assert.match(validationError({ model: "p/:low" }), /model "p\/:low" parses to an empty model half/);
  // A tier-map entry is a selector too — config-views' topTierSelector parses it with
  // parseModelSelector — so its empty halves are checked like any other selector string.
  assert.match(
    validationError({ model: { default: "p/" } }),
    /model\.default "p\/" parses to an empty model half/,
  );
  assert.match(
    validationError({ model: { small: "/id" } }),
    /model\.small "\/id" parses to an empty provider half/,
  );
  // The `fallback` map's entries are pure selectors (fallbackSelectorFields), so the same
  // check applies; a "pause" entry names no model and stays valid.
  assert.match(
    validationError({ fallback: { default: "p/" } }),
    /fallback\.default "p\/" parses to an empty model half/,
  );
  assert.doesNotThrow(() => validateConfig({ fallback: { default: "pause" } }));
});

test("model-triple fields reject empty strings but instructions may be empty", () => {
  // pi-args.ts skips an empty provider/model/thinking when it builds its flags, so a blank value
  // is silently ignored and the team quietly uses pi's default — reject it instead. This
  // covers the top level and the per-role overrides; review and fallbackModel have their own
  // tests above.
  for (const key of ["provider", "model"]) {
    assert.match(
      validationError({ [key]: "" }),
      new RegExp(`${key} must not be empty \\(got ""\\)`),
      `top-level ${key}`,
    );
    assert.match(
      validationError({ roles: { feature: { [key]: "  " } } }),
      new RegExp(`roles\\.feature\\.${key} must not be empty`),
      `roles.feature.${key}`,
    );
    assert.doesNotThrow(() => validateConfig({ [key]: "set" }));
  }
  // thinking shares the empty rule (top level and per-role) but not the any-string rule — its
  // value is checked against pi's accepted levels in its own test below.
  assert.match(validationError({ thinking: "" }), /thinking must not be empty \(got ""\)/);
  assert.match(
    validationError({ roles: { feature: { thinking: "  " } } }),
    /roles\.feature\.thinking must not be empty/,
  );
  // An empty instructions string is a deliberate "no extra instructions", not a typo.
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instructions: "" } } }));
});

test("thinking values are checked against pi's accepted levels", () => {
  // pi WARNS and falls back to its own default on an unrecognized --thinking level rather than
  // failing, so a typo would silently run every role at the wrong reasoning depth. Reject it at
  // load, naming the accepted values, instead of handing it to pi.
  const bad = "hgih";
  const message = (prefix: string) =>
    new RegExp(`${prefix}thinking must be one of off, minimal, low, medium, high, xhigh, max \\(got "hgih"\\)`);
  // Every section that carries a model triple is covered by the one validator.
  assert.match(validationError({ thinking: bad }), message(""));
  assert.match(validationError({ roles: { feature: { thinking: bad } } }), message("roles\\.feature\\."));
  assert.match(validationError({ review: { thinking: bad } }), message("review\\."));
  assert.match(validationError({ fallbackModel: { model: "m", thinking: bad } }), message("fallbackModel\\."));
  // The near miss is named across every triple section the one validator builds.
  const hint = /did you mean `high`\?$/;
  assert.match(validationError({ thinking: bad }), hint);
  assert.match(validationError({ roles: { feature: { thinking: bad } } }), hint);
  assert.match(validationError({ review: { thinking: bad } }), hint);
  assert.match(validationError({ fallbackModel: { model: "m", thinking: bad } }), hint);
  // Whitespace padding is not the same value to pi, so it is not the same value here either.
  assert.match(validationError({ thinking: " high " }), /got " high "/);
  assert.doesNotMatch(validationError({ thinking: " high " }), /did you mean/);
  assert.match(validationError({ thinking: "bogus" }), /got "bogus"/);
  assert.doesNotMatch(validationError({ thinking: "bogus" }), /did you mean/);
  // Every accepted level passes, everywhere a triple is validated.
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.doesNotThrow(() => validateConfig({ thinking: level }), level);
    assert.doesNotThrow(() => validateConfig({ roles: { feature: { thinking: level } } }), level);
    assert.doesNotThrow(() => validateConfig({ review: { thinking: level } }), level);
    assert.doesNotThrow(() => validateConfig({ fallbackModel: { model: "m", thinking: level } }), level);
  }
});

test("role instructions are capped like a custom role's task", () => {
  // Both strings ride into every run's prefill, so both must be bounded: an unbounded
  // instructions string is a standing per-run cost, not just a one-off prompt edit.
  const long = "x".repeat(4097);
  assert.match(
    validationError({ roles: { feature: { instructions: long } } }),
    /roles\.feature\.instructions is 4097 chars — shorten it to at most 4096/,
  );
  // The 4096-char boundary and the empty case both pass.
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instructions: "x".repeat(4096) } } }));
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instructions: "" } } }));
});

test("mergeBatchMax is validated like maxConcurrent: a positive integer", () => {
  // 0 would disable the drain, a fraction would slice an empty batch, a string is a typo —
  // all of them must fail the same validation their sibling does.
  assert.match(validationError({ mergeBatchMax: 0 }), /mergeBatchMax must be an integer of at least 1 \(got 0\)/);
  assert.match(validationError({ mergeBatchMax: -1 }), /mergeBatchMax must be an integer of at least 1 \(got -1\)/);
  assert.match(validationError({ mergeBatchMax: 2.5 }), /mergeBatchMax must be an integer of at least 1 \(got 2\.5\)/);
  assert.match(validationError({ mergeBatchMax: "3" }), /mergeBatchMax must be an integer of at least 1 \(got "3"\)/);
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), mergeBatchMax: 1 }));
  // A typo'd cap must not silently disable coalescing: unknown top-level keys fail validation.
  assert.match(validationError({ mergeBatchmax: 1 }), /mergeBatchmax/);
});

test("maxConcurrentChecks is validated like maxConcurrent: a positive integer", () => {
  // 0 would let no check ever start (every gate and merge would wait forever), a negative
  // or fractional cap means nothing, and a string is a typo — each fails naming the key.
  for (const [bad, shown] of [[0, "0"], [-1, "-1"], [1.5, "1\\.5"], ["2", '"2"']] as const) {
    assert.match(
      validationError({ maxConcurrentChecks: bad }),
      new RegExp(`maxConcurrentChecks must be an integer of at least 1 \\(got ${shown}\\)`),
    );
  }
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), maxConcurrentChecks: 1 }));
});

test("maxConcurrentPerProvider is an optional map of positive integers under non-empty keys", () => {
  // Absent passes (the default), and unknown provider names are NOT errors (doctor warns).
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig() }));
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), maxConcurrentPerProvider: { omlx: 3, claude: 6 } }));
  // 0, -1, a fraction and a non-object each fail naming the dotted key.
  for (const [bad, shown] of [[0, "0"], [-1, "-1"], [1.5, "1\\.5"]] as const) {
    assert.match(
      validationError({ maxConcurrentPerProvider: { omlx: bad } }),
      new RegExp(`maxConcurrentPerProvider\\.omlx must be an integer of at least 1 \\(got ${shown}\\)`),
    );
  }
  assert.match(validationError({ maxConcurrentPerProvider: [] }), /maxConcurrentPerProvider must be an object mapping provider names to concurrency caps/);
  assert.match(validationError({ maxConcurrentPerProvider: { "": 2 } }), /maxConcurrentPerProvider\.<empty> — a provider key must not be empty/);
});

test("claudeWindowReserve is an optional map of window types to fractions above 0 and at most 1", () => {
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), claudeWindowReserve: { seven_day: 0.8, five_hour: 1 } }));
  for (const [bad, shown] of [[0, "0"], [1.5, "1\\.5"], ["0.8", '"0\\.8"']] as const) {
    assert.match(
      validationError({ claudeWindowReserve: { seven_day: bad } }),
      new RegExp(`claudeWindowReserve\\.seven_day must be a fraction above 0 and at most 1 \\(got ${shown}\\)`),
    );
  }
  assert.match(validationError({ claudeWindowReserve: [] }), /claudeWindowReserve must be an object/);
});

test("backends.claude.windowReserve takes the same fraction rule and refuses the other backends", () => {
  assert.doesNotThrow(() => validateConfig({ backends: { claude: { windowReserve: { seven_day: 0.8, five_hour: 1 } } } }));
  for (const [bad, shown] of [[0, "0"], [1.5, "1\\.5"], ["0.8", '"0\\\.8"']] as const) {
    assert.match(
      validationError({ backends: { claude: { windowReserve: { seven_day: bad } } } }),
      new RegExp(`backends\\.claude\\.windowReserve\\.seven_day must be a fraction above 0 and at most 1 \\(got ${shown}\\)`),
    );
  }
  assert.match(validationError({ backends: { claude: { windowReserve: [] } } }), /backends\.claude\.windowReserve must be an object/);
  // claude only today: pi and opencode still refuse windowReserve as an unknown key.
  assert.match(
    validationError({ backends: { pi: { windowReserve: { seven_day: 0.8 } } } }),
    /unknown key "windowReserve" in backends\.pi \(valid keys: bin, args\)/,
  );
  assert.match(
    validationError({ backends: { opencode: { windowReserve: { seven_day: 0.8 } } } }),
    /unknown key "windowReserve" in backends\.opencode \(valid keys: bin, args\)/,
  );
});

test("a file holding both reserve spellings is a load error naming both", () => {
  const err = validationError({
    claudeWindowReserve: { seven_day: 0.8 },
    backends: { claude: { windowReserve: { seven_day: 0.8 } } },
  });
  assert.match(
    err,
    /claudeWindowReserve and backends\.claude\.windowReserve set the same value — keep one/,
  );
});

test("worktreeSlots is validated like maxConcurrent: a positive integer", () => {
  // 0 would leave the pool with no slots at all and every lease waiting forever, a negative
  // or fractional cap means nothing, and a string is a typo — each fails naming the key.
  for (const [bad, shown] of [[0, "0"], [-1, "-1"], [1.5, "1\\.5"], ["2", '"2"']] as const) {
    assert.match(
      validationError({ worktreeSlots: bad }),
      new RegExp(`worktreeSlots must be an integer of at least 1 \\(got ${shown}\\)`),
    );
  }
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), worktreeSlots: 1 }));
});

test("validateConfig rejects a backoff max below the initial it would clamp away, naming both values", () => {
  // Both keys named by the caller.
  assert.match(
    validationError({ ...defaultConfig(), idleBackoff: { initialSeconds: 300, factor: 2, maxSeconds: 60 } }),
    /idleBackoff\.maxSeconds \(60\) must be ≥ idleBackoff\.initialSeconds \(300\) — every idle wait is clamped to the smaller/,
  );
  // Only max named: on the merged config (defaultConfig fills the initial) the default
  // participates — the shape load and save both gate.
  assert.match(
    validationError({ ...defaultConfig(), idleBackoff: { ...defaultConfig().idleBackoff, maxSeconds: 60 } }),
    /idleBackoff\.maxSeconds \(60\) must be ≥ idleBackoff\.initialSeconds \(120\)/,
  );
  // On a raw partial file only one side is known, so the per-key rules judge it alone —
  // the cross-field rule fires after the merge, not on the file's own incomplete shape.
  assert.doesNotThrow(() => validateConfig({ idleBackoff: { maxSeconds: 60 } }));
  assert.doesNotThrow(() => validateConfig({ idleBackoff: { initialSeconds: 3600 } }));
  // A non-numeric side is the per-key rules' problem, not this one's.
  assert.match(validationError({ idleBackoff: { initialSeconds: "x", maxSeconds: 60 } }), /initialSeconds must be/);
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), idleBackoff: { ...defaultConfig().idleBackoff, maxSeconds: 3600 } }));
});

test("validateConfig reports every invalid value in one error", () => {
  const msg = validationError({
    maxConcurrent: -3,
    runTimeoutSeconds: "90m",
    logMaxBytes: 0,
    piArgs: "--verbose",
    idleBackoff: { factor: 0 },
    roles: { clean: { enabled: "false" }, feature: { minRunIntervalSeconds: -5 } },
  });
  assert.match(msg, /^invalid tumwater\.json:/);
  for (const field of [
    "maxConcurrent must be an integer of at least 1 (got -3)",
    'runTimeoutSeconds must be a number greater than 0, at most 2147483 (got "90m")',
    "logMaxBytes must be a number greater than 0 (got 0)",
    'piArgs must be an array of strings (got "--verbose")',
    "idleBackoff.factor must be a number of at least 1 (got 0)",
    'roles.clean.enabled must be true or false (got "false")',
    // AC3 (plans/steward-role.md): the per-role slow clock is validated like its siblings —
    // a negative interval would schedule runs in the past and spin the loop.
    "roles.feature.minRunIntervalSeconds must be a number of 0 or more, at most 2147483 (got -5)",
  ]) {
    assert.ok(msg.includes(field), `error message should mention: ${field}`);
  }
});

test("validateConfig rejects non-object top levels and bad containers", () => {
  for (const raw of [null, 42, "hi", [1]]) {
    assert.match(validationError(raw), /tumwater\.json must be a JSON object/);
  }
  assert.match(validationError({ roles: "oops" }), /roles must be an object mapping role ids to settings/);
  assert.match(validationError({ idleBackoff: 5 }), /idleBackoff must be an object/);
  assert.match(validationError({ roles: { clean: "nope" } }), /roles\.clean must be an object/);
});

test("validateConfig rejects blank string-array entries and names their position", () => {
  // A blank `piArgs` entry is handed straight to pi's CLI, where its args parser reads any
  // non-flag token — "" included — as an empty user message; a blank `review.exemptPaths`
  // pattern is skipped by isExemptPath, so it silently matches nothing. Both are typos with
  // no valid meaning, so they fail fast instead of being inert.
  assert.match(
    validationError({ piArgs: ["--verbose", ""] }),
    /piArgs\[1\] must not be blank \(got ""\)/,
  );
  assert.match(
    validationError({ piArgs: ["  "] }),
    /piArgs\[0\] must not be blank \(got "  "\)/,
  );
  assert.match(
    validationError({ review: { exemptPaths: ["*.md", ""] } }),
    /review\.exemptPaths\[1\] must not be blank \(got ""\)/,
  );
  // The valid shapes still pass: empty arrays and non-blank entries.
  assert.doesNotThrow(() => validateConfig({ piArgs: [], review: { exemptPaths: [] } }));
  assert.doesNotThrow(() => validateConfig({ piArgs: ["--no-skills", "--verbose"] }));
});

test("validateConfig accepts a reserved agent id and rejects an unknown or blank one", () => {
  // The schema reserves BACKEND_IDS; an unknown id would silently fall back to pi at run time
  // (src/agent/run-agent.ts), running the wrong backend against a named one.
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), backend: "pi" }));
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), backend: "claude" }));
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), backend: "opencode" }));
  assert.match(
    validationError({ ...defaultConfig(), backend: "codex" }),
    /backend must name a backend \(pi, claude, opencode; got "codex"\)/,
  );
  assert.doesNotMatch(validationError({ ...defaultConfig(), backend: "codex" }), /did you mean/);
  assert.match(
    validationError({ ...defaultConfig(), backend: "claue" }),
    /backend must name a backend \(pi, claude, opencode; got "claue"\) — did you mean `claude`\?$/,
  );
  assert.match(validationError({ ...defaultConfig(), backend: "" }), /backend must not be empty/);
});

test("validateConfig rejects piArgs entries that repeat a harness-managed flag", () => {
  // pi-args.ts appends config.piArgs AFTER its own flags and pi's parser is last-wins, so a
  // repeated flag silently overrides the harness: `--mode text` makes every run's stream
  // unparseable and `--model` spends on a model tumwater.json never named. Reject the
  // collision and point at the setting that owns it.
  assert.match(
    validationError({ piArgs: ["--append-system-prompt", "x", "--mode", "text"] }),
    /piArgs\[2\] "--mode" duplicates a flag tumwater sets — tumwater requires pi's json output mode/,
  );
  assert.match(
    validationError({ piArgs: ["--model", "other"] }),
    /piArgs\[0\] "--model" duplicates a flag tumwater sets — set the top-level or per-role `model` instead/,
  );
  assert.match(
    validationError({ piArgs: ["-n", "sneaky"] }),
    /piArgs\[0\] "-n" duplicates a flag tumwater sets — tumwater names the session/,
  );
  // The `--flag=value` spelling repeats the same flag: pi's parser reads `--model=x` as
  // `--model x`, so the screen must match the flag before the `=` — exactly as the agents and
  // claude screens do. Missing this let `piArgs: ["--model=other"]` pass validation and then
  // be appended last, silently overriding the model tumwater.json named.
  assert.match(
    validationError({ piArgs: ["--model=other"] }),
    /piArgs\[0\] "--model=other" duplicates a flag tumwater sets — set the top-level or per-role `model` instead/,
  );
  assert.match(
    validationError({ piArgs: ["--provider=other"] }),
    /piArgs\[0\] "--provider=other" duplicates a flag tumwater sets/,
  );
  // --no-extensions is harness-owned (pi-args.ts), so a piArgs entry cannot re-enable pi's
  // discovered extensions and smuggle an operator MCP server back into a team run.
  assert.match(
    validationError({ piArgs: ["--no-extensions"] }),
    /piArgs\[0\] "--no-extensions" duplicates a flag tumwater sets — tumwater skips pi's discovered extensions itself/,
  );
  // Non-conflicting extras still pass, including pi's own append-system-prompt and tool flags.
  assert.doesNotThrow(() =>
    validateConfig({ piArgs: ["--append-system-prompt", "be terse", "--no-skills"] }),
  );
});

test("validateConfig validates the backends section: entry shapes and reserved flags", () => {
  // Valid shapes: an entry may set bin, args, or both; the empty map is the default.
  assert.doesNotThrow(() => validateConfig(defaultConfig()));
  assert.doesNotThrow(() => validateConfig({ backends: {} }));
  assert.doesNotThrow(() => validateConfig({ backends: { pi: { bin: "/opt/pi" } } }));
  assert.doesNotThrow(() => validateConfig({ backends: { claude: { args: ["--debug"] } } }));
  assert.doesNotThrow(() =>
    validateConfig({ backends: { claude: { bin: "claude", args: ["--debug", "--extra"] } } }),
  );
  // opencode's reserved set is enforced like claude's. `--title` is now harness-set
  // (finding 6) and part of HARNESS_OPENCODE_FLAGS, so it is refused; a non-conflicting extra
  // passes.
  assert.match(
    validationError({ backends: { opencode: { args: ["--title=x"] } } }),
    /backends\.opencode\.args\[0\] "--title=x" duplicates a flag tumwater sets/,
  );
  assert.match(
    validationError({ backends: { opencode: { args: ["--model", "x"] } } }),
    /backends\.opencode\.args\[0\] "--model" duplicates a flag tumwater sets/,
  );
  assert.doesNotThrow(() => validateConfig({ backends: { claude: { configDir: "/team/claude" } } }));
  assert.doesNotThrow(() => validateConfig({ backends: { claude: { configDir: "~/.claude-team" } } }));
  // A relative config dir is refused: claude would resolve it against the run's cwd.
  assert.match(
    validationError({ backends: { claude: { configDir: "rel/claude" } } }),
    /backends\.claude\.configDir must be an absolute path after ~ expansion \(got "rel\/claude"\)/,
  );
  assert.match(
    validationError({ backends: { claude: { configDir: "" } } }),
    /backends\.claude\.configDir must not be empty/,
  );

  // Shape errors, each naming where the problem is.
  assert.match(validationError({ backends: "pi" }), /backends must be an object/);
  assert.match(validationError({ backends: { pi: "pi" } }), /backends\.pi must be an object with optional bin and args/);
  // configDir is claude-only: on pi or opencode it would be a silently inert key, so it is
  // refused and the valid set shown is the shared one (bin, args).
  assert.match(
    validationError({ backends: { pi: { configDir: "/team/pi" } } }),
    /unknown key "configDir" in backends\.pi \(valid keys: bin, args\)/,
  );
  assert.match(
    validationError({ backends: { opencode: { configDir: "/team/opencode" } } }),
    /unknown key "configDir" in backends\.opencode \(valid keys: bin, args\)/,
  );
  assert.match(
    validationError({ backends: { pi: { binary: "pi" } } }),
    /unknown key "binary" in backends\.pi \(valid keys: bin, args\)/,
  );
  assert.match(
    validationError({ backends: { pi: { bin: "" } } }),
    /backends\.pi\.bin must not be empty \(got ""\)/,
  );
  assert.match(
    validationError({ backends: { pi: { args: "--verbose" } } }),
    /backends\.pi\.args must be an array of strings/,
  );
  assert.match(
    validationError({ backends: { pi: { args: ["--verbose", ""] } } }),
    /backends\.pi\.args\[1\] must not be blank/,
  );

  // Reserved flags: claude's harness-managed set and pi's (via its legacy alias shape) both
  // refuse a passthrough that would be appended last and silently win.
  assert.match(
    validationError({ backends: { claude: { args: ["--model", "x"] } } }),
    /backends\.claude\.args\[0\] "--model" duplicates a flag tumwater sets/,
  );
  assert.match(
    validationError({ backends: { claude: { args: ["--effort=low"] } } }),
    /backends\.claude\.args\[0\] "--effort=low" duplicates a flag tumwater sets/,
  );
  // The flags claudeArgs appends after the model are reserved too: an overdrawn
  // `--append-system-prompt-file` would replace the harness's AGENTS.md on the last-wins parse.
  assert.match(
    validationError({ backends: { claude: { args: ["--append-system-prompt-file", "/evil"] } } }),
    /backends\.claude\.args\[0\] "--append-system-prompt-file" duplicates a flag tumwater sets/,
  );
  assert.match(
    validationError({ backends: { pi: { args: ["--mode", "text"] } } }),
    /backends\.pi\.args\[0\] "--mode" duplicates a flag tumwater sets/,
  );
  // A non-conflicting extra passes for both backends.
  assert.doesNotThrow(() =>
    validateConfig({ backends: { claude: { args: ["--verbose-extra"] }, pi: { args: ["--no-skills"] } } }),
  );
});

test("a file may not spell one pi field both ways: agentBin/backends.pi.bin and piArgs/backends.pi.args", () => {
  // The alias rule is a property of the file's own keys, so it fires on load (the raw
  // pass) — the merged config always carries a default piArgs, which is why validateConfig's
  // own rawFile flag gates it rather than the merged pass.
  const both = tmpdir();
  writeConfig(both, { agentBin: "/opt/pi", backends: { pi: { bin: "/other/pi" } } });
  assert.throws(() => loadConfig(both), /agentBin and backends\.pi\.bin set the same value/);
  const bothArgs = tmpdir();
  writeConfig(bothArgs, { piArgs: ["--a"], backends: { pi: { args: ["--b"] } } });
  assert.throws(() => loadConfig(bothArgs), /piArgs and backends\.pi\.args set the same value/);
  // One spelling alone loads fine, and the legacy pair still resolves through the helper.
  const legacy = tmpdir();
  writeConfig(legacy, { agentBin: "/opt/pi", piArgs: ["--a"] });
  assert.doesNotThrow(() => loadConfig(legacy));
});

test("validateConfig rejects exemption patterns that can never match a repo-relative path", () => {
  // isExemptPath matches repo-relative git paths, so an absolute pattern, a "./" prefix, a
  // ".." segment, or a trailing "/" matches nothing — the diff it was meant to exempt is
  // reviewed anyway and the operator never learns the pattern was inert, the same silent
  // failure the blank-entry check above closes. Each message names the position and the fix.
  assert.match(
    validationError({ review: { exemptPaths: ["/docs/**"] } }),
    /review\.exemptPaths\[0\] must be repo-relative/,
  );
  assert.match(
    validationError({ review: { exemptPaths: ["*.md", "./src/**"] } }),
    /review\.exemptPaths\[1\] must be repo-relative/,
  );
  assert.match(
    validationError({ review: { exemptPaths: ["docs/../secrets.md"] } }),
    /review\.exemptPaths\[0\] must not contain a "\.\." segment/,
  );
  assert.match(
    validationError({ review: { exemptPaths: ["docs/"] } }),
    /review\.exemptPaths\[0\] must name files, not a directory/,
  );
  // The shapes that do match stay valid: basename, full-path, and ** globs.
  assert.doesNotThrow(() =>
    validateConfig({ review: { exemptPaths: ["*.md", "docs/**", "tumwater.json", "**/*.test.ts"] } }),
  );
});

test("validateConfig guards the review section like its sibling sections", () => {
  // A non-object review (a hand-edited tumwater.json) fails with an actionable message
  // instead of crashing deep in the gate — the same guard idleBackoff and roles get. The
  // message names what was found so one edit fixes it.
  for (const bad of ["on", 1, null, [".md"]]) {
    const shown = JSON.stringify(bad);
    assert.match(
      validationError({ review: bad }),
      new RegExp(`review must be an object \\(got ${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
      `review: ${shown}`,
    );
  }

  // A typo'd key inside the section would otherwise be silently ignored: a team that meant
  // to point its reviewers at a strong model would review with the default and never know.
  assert.match(
    validationError({ review: { modle: "strong" } }),
    /unknown key "modle" in review \(valid keys: enabled, exemptPaths, afterMerge, provider, model, backend, thinking, timeoutSeconds\)/,
  );

  // Inner values are type-checked like their siblings elsewhere in the file.
  assert.match(validationError({ review: { enabled: "yes" } }), /review\.enabled must be true or false \(got "yes"\)/);
  assert.match(
    validationError({ review: { exemptPaths: "*.md" } }),
    /review\.exemptPaths must be an array of strings \(got "\*\.md"\)/,
  );
  assert.match(validationError({ review: { exemptPaths: ["*.md", 3] } }), /review\.exemptPaths must be an array of strings/);
  for (const key of ["provider", "thinking"]) {
    assert.match(
      validationError({ review: { [key]: 7 } }),
      new RegExp(`review\\.${key} must be a string \\(got 7\\)`),
    );
    // pi-args.ts skips an empty value when it builds its flags, so an empty override would be
    // silently ignored and the reviewers would quietly use the top-level model.
    assert.match(
      validationError({ review: { [key]: "" } }),
      new RegExp(`review\\.${key} must not be empty \\(got ""\\)`),
    );
  }

  // The reviewer's time budget is a positive number of seconds: 0 or a negative would kill
  // every review at spawn, and a string would be NaN — each named by its key.
  for (const bad of [0, -30, "900"]) {
    assert.match(
      validationError({ review: { timeoutSeconds: bad } }),
      new RegExp(`review\\.timeoutSeconds must be a number greater than 0, at most 2147483 \\(got ${JSON.stringify(bad)}\\)`),
      `review.timeoutSeconds: ${JSON.stringify(bad)}`,
    );
  }

  // A fully valid section still passes.
  assert.doesNotThrow(() =>
    validateConfig({
      review: { enabled: false, exemptPaths: ["*.md"], provider: "p", model: "m", thinking: "high", timeoutSeconds: 600 },
    }),
  );

  // The live-reload path (the orchestrator's config poll) surfaces the same message without
  // stopping the team.
  const dir = tmpdir();
  writeConfig(dir, { review: "on" });
  assert.match(loadConfigSafe(dir).error ?? "", /review must be an object/);
});

test("validateConfig rejects unknown keys with the valid ones listed", () => {
  // A misspelled key would otherwise be silently ignored and the default used.
  const top = validationError({ runTimeoutSecondss: 90 });
  assert.match(top, /unknown key "runTimeoutSecondss" in tumwater\.json \(valid keys: .*runTimeoutSeconds.*\)/);
  // The near miss gets the shared did-you-mean, same as `tumwater config set`.
  assert.match(top, /— did you mean `runTimeoutSeconds`\?/);

  const backoff = validationError({ idleBackoff: { factorr: 2 } });
  assert.match(backoff, /unknown key "factorr" in idleBackoff \(valid keys: initialSeconds, factor, maxSeconds\)/);
  assert.match(backoff, /— did you mean `factor`\?/);

  const roleEntry = validationError({ roles: { feature: { enabed: true } } });
  assert.match(
    roleEntry,
    /unknown key "enabed" in roles\.feature \(valid keys: enabled, instructions, provider, model, backend, thinking, minRunIntervalSeconds, instances\)/,
  );
  assert.match(roleEntry, /— did you mean `enabled`\?/);

  // A key with no near miss stays a bare valid-keys list (no spurious suggestion).
  const far = validationError({ completelyUnrelated: 1 });
  assert.doesNotMatch(far, /did you mean/);
});

test("validateConfig bounds the per-role instances field to feature/bugfix and 1-8", () => {
  // Accepted: both allowed roles, at the ends and inside the range.
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instances: 3 }, bugfix: { instances: 2 } } }));
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instances: 1 } } }));
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instances: 8 } } }));

  // Rejected values: zero, above the cap, and a non-integer.
  for (const bad of [0, 9, 1.5]) {
    assert.match(
      validationError({ roles: { feature: { instances: bad } } }),
      /roles\.feature\.instances must be an integer from 1 to 8/,
    );
  }

  // Only feature and bugfix may split; the message names both and the offending value.
  const plan = validationError({ roles: { plan: { instances: 2 } } });
  assert.match(plan, /roles\.plan\.instances is only valid for feature and bugfix \(got 2\)/);
});

test("validateConfig rejects unknown role ids (a typo would spawn a phantom erroring role)", () => {
  const msg = validationError({ roles: { featuer: { enabled: true } } });
  assert.match(msg, /roles\.featuer is not a known role \(valid ids: .*feature.*\)/);
  assert.match(msg, /— did you mean `feature`\?/);
  // The valid-id list covers the whole catalog, including the director.
  for (const id of allRoleIds()) assert.ok(msg.includes(id), `error should list ${id}`);

  // loadConfig and the live-reload path surface the same actionable message.
  const dir = tmpdir();
  writeConfig(dir, { roles: { featuer: {} } });
  assert.throws(() => loadConfig(dir), /roles\.featuer is not a known role/);
  assert.match(loadConfigSafe(dir).error ?? "", /roles\.featuer is not a known role/);
});

test("loadConfig rejects malformed JSON and invalid values with actionable messages", () => {
  const dir = tmpdir();
  writeMalformedJson(path.join(dir, "tumwater.json"));
  assert.throws(() => loadConfig(dir), /tumwater\.json is not valid JSON/);

  writeConfig(dir, { maxConcurrent: 0 });
  assert.throws(() => loadConfig(dir), /maxConcurrent must be an integer of at least 1 \(got 0\)/);
});

test("loadConfigSafe returns the config when valid and the error message otherwise", () => {
  const dir = tmpdir();
  // No file: defaults, no error.
  assert.deepEqual(loadConfigSafe(dir), { config: defaultConfig() });

  writeConfig(dir, { model: "sonnet" });
  const ok = loadConfigSafe(dir);
  assert.equal(ok.error, undefined);
  assert.equal(ok.config?.model, "sonnet");

  // Broken JSON and invalid values surface as messages, never throws.
  writeMalformedJson(path.join(dir, "tumwater.json"));
  const broken = loadConfigSafe(dir);
  assert.equal(broken.config, undefined);
  assert.match(broken.error ?? "", /not valid JSON/);

  writeConfig(dir, { maxConcurrent: 0 });
  assert.match(loadConfigSafe(dir).error ?? "", /maxConcurrent must be an integer of at least 1/);
});

test("saveConfig refuses to persist invalid configs", () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.maxConcurrent = -1;
  assert.throws(() => saveConfig(dir, config), /maxConcurrent must be an integer of at least 1/);
  assert.ok(!fs.existsSync(path.join(dir, "tumwater.json")), "nothing written on invalid config");
});


test("validateConfig refuses a custom role named tumwater, naming why", () => {
  assert.match(
    validationError({ customRoles: [{ name: "tumwater", task: "Do something." }] }),
    /customRoles\[0\]\.name "tumwater" is reserved: .*indistinguishable/,
  );
});

test("a fallback step's backend and model are checked together", () => {
  const err = (step: unknown) => validationError({ ...defaultConfig(), fallback: { default: [step] } });
  assert.match(err({ backend: "nope", model: "a/b" }), /fallback\.default\[0\]\.backend must name a backend/);
  assert.match(err({ backend: "claude", model: "a/b" }), /fallback\.default\[0\]\.model "a\/b" has a "\/"/);
  assert.match(err({ backend: "pi", model: "plain" }), /fallback\.default\[0\]\.model "plain" has no provider/);
});
