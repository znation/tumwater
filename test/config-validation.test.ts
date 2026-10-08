import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, loadConfigSafe, saveConfig } from "../src/config/config.js";
import { show } from "../src/config/config-field-checks.js";
import { validateConfig } from "../src/config/config-validation.js";
import { allRoleIds } from "../src/roles/roles.js";
import { validationError } from "./config-fixtures.js";
import { tmpdir, writeConfig, writeMalformedJson } from "./repo-fixtures.js";

// Tests for src/config/config-validation.ts — validateConfig — plus the load and save paths that
// enforce it (loadConfig's actionable rejections, loadConfigSafe's message form, saveConfig's
// refuse-to-persist). The rest of src/config/config.ts's surface (defaults, per-role views, the read
// cache, customLoops, the example template) stays in test/config.test.ts.

test("show renders the offending value honestly and compactly", () => {
  // Regression: JSON.stringify(Infinity) is "null", so a huge numeric literal — which
  // JSON.parse turns into Infinity — was reported as `got null` even though the user wrote a
  // number. validateConfig rejects non-finite values, so this is the only place naming them.
  assert.equal(show(Number.POSITIVE_INFINITY), "Infinity");
  assert.equal(show(Number.NEGATIVE_INFINITY), "-Infinity");
  assert.equal(show(Number.NaN), "NaN");
  assert.match(validationError({ tickTimeoutSeconds: Number.POSITIVE_INFINITY }), /\(got Infinity\)/);
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
      minTickIntervalSeconds: 0,
      tickTimeoutSeconds: 60,
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
  // reaches pi — the fleet silently runs pi's default model. Reject the shape instead. Under
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
});

test("model-triple fields reject empty strings but instructions may be empty", () => {
  // pi.ts skips an empty provider/model/thinking when it builds its flags, so a blank value
  // is silently ignored and the fleet quietly uses pi's default — reject it instead. This
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
  // failing, so a typo would silently run every loop at the wrong reasoning depth. Reject it at
  // load, naming the accepted values, instead of handing it to pi.
  const bad = "hgih";
  const message = (prefix: string) =>
    new RegExp(`${prefix}thinking must be one of off, minimal, low, medium, high, xhigh, max \\(got "hgih"\\)`);
  // Every section that carries a model triple is covered by the one validator.
  assert.match(validationError({ thinking: bad }), message(""));
  assert.match(validationError({ roles: { feature: { thinking: bad } } }), message("roles\\.feature\\."));
  assert.match(validationError({ review: { thinking: bad } }), message("review\\."));
  assert.match(validationError({ fallbackModel: { model: "m", thinking: bad } }), message("fallbackModel\\."));
  // Whitespace padding is not the same value to pi, so it is not the same value here either.
  assert.match(validationError({ thinking: " high " }), /got " high "/);
  // Every accepted level passes, everywhere a triple is validated.
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.doesNotThrow(() => validateConfig({ thinking: level }), level);
    assert.doesNotThrow(() => validateConfig({ roles: { feature: { thinking: level } } }), level);
    assert.doesNotThrow(() => validateConfig({ review: { thinking: level } }), level);
    assert.doesNotThrow(() => validateConfig({ fallbackModel: { model: "m", thinking: level } }), level);
  }
});

test("role instructions are capped like a custom loop's task", () => {
  // Both strings ride into every tick's prefill, so both must be bounded: an unbounded
  // instructions string is a standing per-tick cost, not just a one-off prompt edit.
  const long = "x".repeat(4097);
  assert.match(
    validationError({ roles: { feature: { instructions: long } } }),
    /roles\.feature\.instructions is 4097 chars — shorten it to at most 4096/,
  );
  // The 4096-char boundary and the empty case both pass.
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instructions: "x".repeat(4096) } } }));
  assert.doesNotThrow(() => validateConfig({ roles: { feature: { instructions: "" } } }));
});

test("landBatchMax is validated like maxConcurrent: a positive integer", () => {
  // 0 would disable the drain, a fraction would slice an empty batch, a string is a typo —
  // all of them must fail the same validation their sibling does.
  assert.match(validationError({ landBatchMax: 0 }), /landBatchMax must be an integer of at least 1 \(got 0\)/);
  assert.match(validationError({ landBatchMax: -1 }), /landBatchMax must be an integer of at least 1 \(got -1\)/);
  assert.match(validationError({ landBatchMax: 2.5 }), /landBatchMax must be an integer of at least 1 \(got 2\.5\)/);
  assert.match(validationError({ landBatchMax: "3" }), /landBatchMax must be an integer of at least 1 \(got "3"\)/);
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), landBatchMax: 1 }));
  // A typo'd cap must not silently disable coalescing: unknown top-level keys fail validation.
  assert.match(validationError({ landBatchmax: 1 }), /landBatchmax/);
});

test("maxConcurrentChecks is validated like maxConcurrent: a positive integer", () => {
  // 0 would let no check ever start (every gate and landing would wait forever), a negative
  // or fractional cap means nothing, and a string is a typo — each fails naming the key.
  for (const [bad, shown] of [[0, "0"], [-1, "-1"], [1.5, "1\\.5"], ["2", '"2"']] as const) {
    assert.match(
      validationError({ maxConcurrentChecks: bad }),
      new RegExp(`maxConcurrentChecks must be an integer of at least 1 \\(got ${shown}\\)`),
    );
  }
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), maxConcurrentChecks: 1 }));
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
    tickTimeoutSeconds: "90m",
    logMaxBytes: 0,
    piArgs: "--verbose",
    idleBackoff: { factor: 0 },
    roles: { clean: { enabled: "false" }, feature: { minTickIntervalSeconds: -5 } },
  });
  assert.match(msg, /^invalid tumwater\.json:/);
  for (const field of [
    "maxConcurrent must be an integer of at least 1 (got -3)",
    'tickTimeoutSeconds must be a number greater than 0, at most 2147483 (got "90m")',
    "logMaxBytes must be a number greater than 0 (got 0)",
    'piArgs must be an array of strings (got "--verbose")',
    "idleBackoff.factor must be a number of at least 1 (got 0)",
    'roles.clean.enabled must be true or false (got "false")',
    // AC3 (plans/steward-role.md): the per-role slow clock is validated like its siblings —
    // a negative interval would schedule ticks in the past and spin the loop.
    "roles.feature.minTickIntervalSeconds must be a number of 0 or more, at most 2147483 (got -5)",
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

test("validateConfig rejects piArgs entries that repeat a harness-managed flag", () => {
  // pi.ts appends config.piArgs AFTER its own flags and pi's parser is last-wins, so a
  // repeated flag silently overrides the harness: `--mode text` makes every tick's stream
  // unparseable and `--model` spends on a model tumwater.json never named. Reject the
  // collision and point at the setting that owns it.
  assert.match(
    validationError({ piArgs: ["--append-system-prompt", "x", "--mode", "text"] }),
    /piArgs\[2\] "--mode" duplicates a flag the harness sets — the harness requires pi's json output mode/,
  );
  assert.match(
    validationError({ piArgs: ["--model", "other"] }),
    /piArgs\[0\] "--model" duplicates a flag the harness sets — set the top-level or per-role `model` instead/,
  );
  assert.match(
    validationError({ piArgs: ["-n", "sneaky"] }),
    /piArgs\[0\] "-n" duplicates a flag the harness sets — the harness names the session/,
  );
  // Non-conflicting extras still pass, including pi's own append-system-prompt and tool flags.
  assert.doesNotThrow(() =>
    validateConfig({ piArgs: ["--append-system-prompt", "be terse", "--no-skills"] }),
  );
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

  // A typo'd key inside the section would otherwise be silently ignored: a fleet that meant
  // to point its reviewers at a strong model would review with the default and never know.
  assert.match(
    validationError({ review: { modle: "strong" } }),
    /unknown key "modle" in review \(valid keys: enabled, exemptPaths, provider, model, thinking, timeoutSeconds\)/,
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
    // pi.ts skips an empty value when it builds its flags, so an empty override would be
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
  // stopping the fleet.
  const dir = tmpdir();
  writeConfig(dir, { review: "on" });
  assert.match(loadConfigSafe(dir).error ?? "", /review must be an object/);
});

test("validateConfig rejects unknown keys with the valid ones listed", () => {
  // A misspelled key would otherwise be silently ignored and the default used.
  const top = validationError({ tickTimeoutSecondss: 90 });
  assert.match(top, /unknown key "tickTimeoutSecondss" in tumwater\.json \(valid keys: .*tickTimeoutSeconds.*\)/);
  // The near miss gets the shared did-you-mean, same as `tumwater config set`.
  assert.match(top, /— did you mean `tickTimeoutSeconds`\?/);

  const backoff = validationError({ idleBackoff: { factorr: 2 } });
  assert.match(backoff, /unknown key "factorr" in idleBackoff \(valid keys: initialSeconds, factor, maxSeconds\)/);
  assert.match(backoff, /— did you mean `factor`\?/);

  const roleEntry = validationError({ roles: { feature: { enabed: true } } });
  assert.match(
    roleEntry,
    /unknown key "enabed" in roles\.feature \(valid keys: enabled, instructions, provider, model, thinking, minTickIntervalSeconds\)/,
  );
  assert.match(roleEntry, /— did you mean `enabled`\?/);

  // A key with no near miss stays a bare valid-keys list (no spurious suggestion).
  const far = validationError({ completelyUnrelated: 1 });
  assert.doesNotMatch(far, /did you mean/);
});

test("validateConfig rejects unknown role ids (a typo would spawn a phantom erroring loop)", () => {
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
  // (`{"tickTimeoutSeconds": 1e300}`) multiplied to Infinity ms in src/pi/pi.ts — and node's
  // setTimeout/setInterval clamp a delay that does not fit in a signed 32-bit integer down
  // to 1ms (verified: a setTimeout(1e300*1000) fired ~2ms later), killing every pi run the
  // moment it started. All seconds fields that feed a ×1000 duration share one bound:
  // 2147483 seconds × 1000 stays inside setTimeout's 2^31−1 ms range.
  const MAX_DURATION_SECONDS = 2147483;
  const tooBig = 1e300;
  assert.match(
    validationError({ ...defaultConfig(), tickTimeoutSeconds: tooBig }),
    new RegExp(`tickTimeoutSeconds must be a number greater than 0, at most ${MAX_DURATION_SECONDS}`),
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
    validationError({ ...defaultConfig(), minTickIntervalSeconds: tooBig }),
    new RegExp(`minTickIntervalSeconds must be a number of 0 or more, at most ${MAX_DURATION_SECONDS}`),
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
  assert.equal(validateConfig({ ...defaultConfig(), tickTimeoutSeconds: MAX_DURATION_SECONDS }), undefined);
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
  // A malformed window passes the parser's message through, prefixed with key and id.
  assert.match(
    validationError({ ...defaultConfig(), quietHoursPerRole: { qa: "25:00-07:00" } }),
    /quietHoursPerRole\.qa: quietHours times must be 24-hour "HH:MM" — hours 00-23, minutes 00-59/,
  );
  // A zero-length window is malformed the same way.
  assert.match(
    validationError({ ...defaultConfig(), quietHoursPerRole: { qa: "23:00-23:00" } }),
    /quietHoursPerRole\.qa: quietHours start and end must differ/,
  );
});

test("the fallback selector string is validated like its fallbackModel object form", () => {
  // A non-empty string: empty would silently never engage, the same silent-ignore class
  // fallbackModel's object form already rejects. A string may also be a map by tier —
  // plans/model-tiers.md — whose values are selector strings or "pause".
  assert.match(
    validationError({ fallback: "" }),
    /fallback must be a selector string or a map by tier \(got ""\)/,
  );
  assert.match(
    validationError({ fallback: 3 }),
    /fallback must be a selector string or a map by tier \(got 3\)/,
  );
  assert.doesNotThrow(() => validateConfig({ fallback: "omlx/local-free" }));
  assert.doesNotThrow(() => validateConfig({ fallback: "omlx/local-free:low" }));
  assert.doesNotThrow(() =>
    validateConfig({ fallback: { default: "omlx/local-free", strong: "pause" } }),
  );
  assert.match(
    validationError({ fallback: { medium: "omlx/local-free" } }),
    /unknown key "medium" in fallback \(valid keys: small, default, strong\)/,
  );
  assert.match(
    validationError({ fallback: { default: "" } }),
    /fallback\.default must be a non-empty selector string or "pause" \(got ""\)/,
  );
  assert.match(
    validationError({ fallback: "pause" }),
    /fallback "pause" is only valid as a tier map value/,
  );
  // Setting both forms is an error naming both keys — which one wins is not a question the
  // file should ever pose.
  const both = validationError({ fallback: "omlx/local-free", fallbackModel: { model: "m" } });
  assert.match(both, /fallback and fallbackModel both name the budget fallback/);
  assert.match(both, /fallbackModel/);
});

// --- Model tiers (plans/model-tiers.md part 3/8) --------------------------------------------

test("validateConfig guards the tier-map and tier-name forms of model", () => {
  // A well-formed map passes.
  assert.doesNotThrow(() =>
    validateConfig({ model: { default: "prov/a", strong: "prov/b:high", small: "prov/c" } }),
  );
  // Map keys are exactly the three tiers.
  assert.match(
    validationError({ model: { medium: "prov/a" } }),
    /unknown key "medium" in model \(valid keys: small, default, strong\)/,
  );
  // Map values are non-empty selector strings.
  assert.match(
    validationError({ model: { default: "" } }),
    /model\.default must be a non-empty selector string \(got ""\)/,
  );
  // A map cannot coexist with the legacy top-level provider.
  assert.match(
    validationError({ provider: "prov", model: { default: "a" } }),
    /model as a map by tier cannot coexist with the legacy top-level provider/,
  );
  // Tier names are valid only as roles.<id>.model / review.model values.
  assert.match(
    validationError({ model: "strong" }),
    /model must name a selector — tier names are valid only as roles\.<id>\.model or review\.model values/,
  );
  assert.doesNotThrow(() => validateConfig({ roles: { plan: { enabled: true, model: "strong" } } }));
  assert.doesNotThrow(() =>
    validateConfig({ model: { default: "prov/a" }, review: { enabled: true, model: "default" } }),
  );
  // A tier-name override without a model map is legal but inert (it resolves to pi's default).
  // A non-string model keeps an actionable message.
  assert.match(
    validationError({ roles: { plan: { enabled: true, model: 7 } } }),
    /roles\.plan\.model must be a selector string or a tier name \(small, default, strong\) \(got 7\)/,
  );
});
