import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyFallbackModel,
  changedConfigKeys,
  configForRole,
  customLoopNames,
  exampleConfigProblem,
  exampleDrift,
  fallbackPair,
  defaultConfig,
  isCustomRole,
  knownRoleIds,
  loadConfig,
  loadConfigCached,
  loadConfigSafe,
  reviewConfig,
  reviewRunConfig,
  REVIEW_TIMEOUT_S,
  seedConfig,
  saveConfig,
} from "../src/config.js";
import { exampleConfigPath } from "../src/paths.js";
import { show, validateConfig } from "../src/config-validation.js";
import { allRoleIds } from "../src/roles.js";
import { errorMessage } from "../src/text.js";
import { tmpdir } from "./util.js";

test("defaultConfig enables every role including director", () => {
  const config = defaultConfig();
  for (const id of allRoleIds()) {
    assert.equal(config.roles[id]?.enabled, true, `role ${id} should default enabled`);
  }
  assert.ok(config.maxConcurrent >= 1);
  // Merge queue 5/5: the batch cap defaults to 3 — the fleet's realistic concurrent-role count.
  assert.equal(config.landBatchMax, 3);
  // Land-queue speed 2b: two check suites at once, process-wide.
  assert.equal(config.maxConcurrentChecks, 2);
  assert.ok(config.idleBackoff.maxSeconds >= config.idleBackoff.initialSeconds);
});

test("defaultConfig gives the slow-clock roles their clocks and no other role one", () => {
  // Regression: feature tick 49 set this via `roles.steward.minTickIntervalSeconds = …`,
  // which does not compile under noUncheckedIndexedAccess — a broken build landed on main.
  const config = defaultConfig();
  assert.equal(configForRole(config, "steward").minTickIntervalSeconds, 21600);
  assert.equal(configForRole(config, "qa").minTickIntervalSeconds, 7200);
  assert.equal(configForRole(config, "telemetry").minTickIntervalSeconds, 7200);
  // The bookkeeping roles: readme batches landings into one sync per half hour, plan re-audits
  // at most hourly — in dogfood the two were 30% of all commits at the global 20 s clock.
  assert.equal(configForRole(config, "readme").minTickIntervalSeconds, 1800);
  assert.equal(configForRole(config, "plan").minTickIntervalSeconds, 3600);
  for (const id of allRoleIds()) {
    if (id === "steward" || id === "qa" || id === "telemetry" || id === "readme" || id === "plan") continue;
    // Every other role falls back to the global interval.
    assert.equal(
      configForRole(config, id).minTickIntervalSeconds,
      config.minTickIntervalSeconds,
      `role ${id} should inherit the global minTickIntervalSeconds`,
    );
  }
});

test("defaultConfig carries the thrash thresholds and validation guards them", () => {
  // AC5 (plans/refusal-and-thrash.md): the friction thresholds default to 40 turns / 30
  // minutes, and invalid values are rejected with actionable errors like every other knob.
  const config = defaultConfig();
  assert.equal(config.thrashTurns, 40);
  assert.equal(config.thrashMinutes, 30);
  assert.doesNotThrow(() => validateConfig(config));

  for (const [key, bad] of [
    ["thrashTurns", -1],
    ["thrashMinutes", -0.5],
    ["thrashTurns", "40"],
    ["thrashMinutes", null],
  ] as const) {
    // The "s" flag lets .* cross the newline between the error header and its bulleted
    // problems; without it the anchor matched only single-line messages.
    assert.match(
      validationError({ [key]: bad }),
      new RegExp(`^invalid tumwater\\.json:.*${key} must be a number of 0 or more \\(got ${JSON.stringify(bad)}\\)`, "s"),
      `${key}: ${bad} should be rejected with an actionable error`,
    );
  }
});

test("defaultConfig carries the daily cost budget cap and validation guards it", () => {
  // AC1 (plans/daily-cost-budget.md): an unattended fleet must not spend unbounded, so the
  // cap defaults to $50/day; 0 disables. Invalid values are rejected with actionable errors
  // like every other knob.
  const config = defaultConfig();
  assert.equal(config.maxDailyCostUsd, 50);
  assert.doesNotThrow(() => validateConfig({ maxDailyCostUsd: 0 }));

  for (const bad of [-1, "50", null]) {
    // The "s" flag lets .* cross the newline between the error header and its bulleted
    // problems; without it the anchor matched only single-line messages.
    assert.match(
      validationError({ maxDailyCostUsd: bad }),
      new RegExp(`^invalid tumwater\\.json:.*maxDailyCostUsd must be a number of 0 or more \\(0 disables\\) \\(got ${JSON.stringify(bad)}\\)`, "s"),
      `maxDailyCostUsd: ${bad} should be rejected with an actionable error`,
    );
  }

  // A typo'd key name would otherwise be silently ignored and the default used — a fleet
  // that meant to cap its spend would then spend unbounded. TOP_LEVEL_KEYS must fail it.
  assert.match(
    validationError({ maxDailyCostUss: 50 }),
    /unknown key "maxDailyCostUss" in tumwater\.json \(valid keys: .*maxDailyCostUsd.*\)/,
  );

  // plans/portability.md §5/7: agentBin is a known top-level key, must be a string, and a
  // blank value is rejected — it would silently fall back to "pi" instead of the binary
  // the operator named, the same silent-ignore class baseBranch's emptiness rule covers.
  assert.doesNotThrow(() => validateConfig({ agentBin: "/opt/pi/bin/pi" }));
  assert.match(
    validationError({ agentBin: 42 }),
    /agentBin must be a string \(got 42\)/,
  );
  assert.match(
    validationError({ agentBin: "  " }),
    /agentBin must not be empty \(got "  "\)/,
  );

  // loadConfig over an existing file lacking the key picks up the default without editing.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  const loaded = loadConfig(dir);
  assert.equal(loaded.model, "sonnet");
  assert.equal(loaded.maxDailyCostUsd, 50);
});

test("loadConfig without a file returns defaults", () => {
  const dir = tmpdir();
  assert.deepEqual(loadConfig(dir), defaultConfig());
});

test("loadConfig merges partial files over defaults", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({
      model: "sonnet",
      idleBackoff: { maxSeconds: 60 },
      roles: { clean: { enabled: false }, perf: { enabled: true } },
    }),
  );
  const config = loadConfig(dir);
  assert.equal(config.model, "sonnet");
  assert.equal(config.idleBackoff.maxSeconds, 60);
  assert.equal(config.idleBackoff.factor, defaultConfig().idleBackoff.factor);
  assert.equal(config.roles.clean?.enabled, false);
  assert.equal(config.roles.improve?.enabled, true);
  assert.equal(config.roles.perf?.enabled, true);
});

test("loadConfig enables qa with its slow clock when the file omits it", () => {
  // This repo's tumwater.json lists every other role but not qa (or steward): per-role
  // defaults merge in for ids absent from the file, so enabling needs no config edit.
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ roles: { feature: { enabled: true } } }),
  );
  const config = loadConfig(dir);
  assert.equal(config.roles.qa?.enabled, true);
  assert.equal(configForRole(config, "qa").minTickIntervalSeconds, 7200);
});

test("saveConfig round-trips", () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.provider = "anthropic";
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir), config);
});

test("configForRole applies role overrides over top-level pi settings", () => {
  const config = defaultConfig();
  config.provider = "top-provider";
  config.model = "top-model";
  config.roles.feature = { enabled: true, model: "strong-model", thinking: "high" };
  const feature = configForRole(config, "feature");
  assert.equal(feature.provider, "top-provider");
  assert.equal(feature.model, "strong-model");
  assert.equal(feature.thinking, "high");
  const clean = configForRole(config, "clean");
  assert.equal(clean.model, "top-model");
  assert.equal(clean.thinking, undefined);
  assert.deepEqual(configForRole(config, "nonexistent"), config);
});

test("reviewConfig applies the review section's overrides over top-level pi settings", () => {
  const config = defaultConfig();
  config.provider = "top-provider";
  config.model = "top-model";
  config.review = { enabled: true, exemptPaths: [], model: "strong-model", thinking: "high" };
  const review = reviewConfig(config);
  assert.equal(review.provider, "top-provider");
  assert.equal(review.model, "strong-model");
  assert.equal(review.thinking, "high");

  // No overrides in the section → top-level values pass through unchanged.
  const plain = reviewConfig(defaultConfig());
  assert.equal(plain.provider, undefined);
  assert.equal(plain.model, undefined);
  assert.equal(plain.thinking, undefined);
});

test("reviewRunConfig gives the reviewer its own time budget over the reviewer wiring", () => {
  const config = defaultConfig();
  config.tickTimeoutSeconds = 54_000;
  config.review.model = "strong-model";
  const run = reviewRunConfig(config);
  assert.equal(run.tickTimeoutSeconds, REVIEW_TIMEOUT_S, "the tick's hours-long budget never reaches the reviewer");
  assert.equal(run.model, "strong-model", "the run keeps the reviewer's model wiring");
  assert.equal(run.quietTimeoutSeconds, config.quietTimeoutSeconds, "only the wall-clock budget changes");

  // A configured review.timeoutSeconds replaces the default; a smaller tick budget still wins.
  config.review.timeoutSeconds = 120;
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, 120);
  config.tickTimeoutSeconds = 60;
  assert.equal(reviewRunConfig(config).tickTimeoutSeconds, 60);
});

function validationError(raw: unknown): string {
  try {
    validateConfig(raw);
  } catch (err) {
    return errorMessage(err);
  }
  throw new Error("validateConfig did not throw");
}

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
    'tickTimeoutSeconds must be a number greater than 0 (got "90m")',
    "logMaxBytes must be a number greater than 0 (got 0)",
    'piArgs must be an array of strings (got "--verbose")',
    "idleBackoff.factor must be a number of at least 1 (got 0)",
    'roles.clean.enabled must be true or false (got "false")',
    // AC3 (plans/steward-role.md): the per-role slow clock is validated like its siblings —
    // a negative interval would schedule ticks in the past and spin the loop.
    "roles.feature.minTickIntervalSeconds must be a number of 0 or more (got -5)",
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
  for (const key of ["provider", "model", "thinking"]) {
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
      new RegExp(`review\\.timeoutSeconds must be a number greater than 0 \\(got ${JSON.stringify(bad)}\\)`),
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
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ review: "on" }));
  assert.match(loadConfigSafe(dir).error ?? "", /review must be an object/);
});

test("validateConfig rejects unknown keys with the valid ones listed", () => {
  // A misspelled key would otherwise be silently ignored and the default used.
  const top = validationError({ tickTimeoutSecondss: 90 });
  assert.match(top, /unknown key "tickTimeoutSecondss" in tumwater\.json \(valid keys: .*tickTimeoutSeconds.*\)/);

  const backoff = validationError({ idleBackoff: { factorr: 2 } });
  assert.match(backoff, /unknown key "factorr" in idleBackoff \(valid keys: initialSeconds, factor, maxSeconds\)/);

  const roleEntry = validationError({ roles: { feature: { enabed: true } } });
  assert.match(
    roleEntry,
    /unknown key "enabed" in roles\.feature \(valid keys: enabled, instructions, provider, model, thinking, minTickIntervalSeconds\)/,
  );
});

test("validateConfig rejects unknown role ids (a typo would spawn a phantom erroring loop)", () => {
  const msg = validationError({ roles: { featuer: { enabled: true } } });
  assert.match(msg, /roles\.featuer is not a known role \(valid ids: .*feature.*\)/);
  // The valid-id list covers the whole catalog, including the director.
  for (const id of allRoleIds()) assert.ok(msg.includes(id), `error should list ${id}`);

  // loadConfig and the live-reload path surface the same actionable message.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ roles: { featuer: {} } }));
  assert.throws(() => loadConfig(dir), /roles\.featuer is not a known role/);
  assert.match(loadConfigSafe(dir).error ?? "", /roles\.featuer is not a known role/);
});

test("loadConfig rejects malformed JSON and invalid values with actionable messages", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ not json");
  assert.throws(() => loadConfig(dir), /tumwater\.json is not valid JSON/);

  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ maxConcurrent: 0 }));
  assert.throws(() => loadConfig(dir), /maxConcurrent must be an integer of at least 1 \(got 0\)/);
});

test("loadConfigSafe returns the config when valid and the error message otherwise", () => {
  const dir = tmpdir();
  // No file: defaults, no error.
  assert.deepEqual(loadConfigSafe(dir), { config: defaultConfig() });

  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  const ok = loadConfigSafe(dir);
  assert.equal(ok.error, undefined);
  assert.equal(ok.config?.model, "sonnet");

  // Broken JSON and invalid values surface as messages, never throws.
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ not json");
  const broken = loadConfigSafe(dir);
  assert.equal(broken.config, undefined);
  assert.match(broken.error ?? "", /not valid JSON/);

  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ maxConcurrent: 0 }));
  assert.match(loadConfigSafe(dir).error ?? "", /maxConcurrent must be an integer of at least 1/);
});

test("saveConfig refuses to persist invalid configs", () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.maxConcurrent = -1;
  assert.throws(() => saveConfig(dir, config), /maxConcurrent must be an integer of at least 1/);
  assert.ok(!fs.existsSync(path.join(dir, "tumwater.json")), "nothing written on invalid config");
});

// --- loadConfigCached: the stat-keyed cache behind every poll's config reload ---

test("an unchanged tumwater.json is served from the stat-keyed cache without re-reading", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // populates the cache
  let reads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      reads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // unchanged — no file I/O at all
    assert.equal(reads, 0);
    // Each call still gets its own config: mutating one result must not poison the cache.
    const cfg = loadConfigCached(dir).config!;
    cfg.maxConcurrent = 99;
    assert.ok(cfg.roles.plan, "plan is in the catalog — defaultConfig enables every role");
    cfg.roles.plan.enabled = false;
    assert.equal(loadConfigCached(dir).config?.maxConcurrent, defaultConfig().maxConcurrent);
    assert.equal(loadConfigCached(dir).config?.roles.plan?.enabled, true);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }
});

test("a same-size tumwater.json edit is picked up via mtime, not just size", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  assert.equal(loadConfigCached(dir).config?.model, "sonnet");
  // Replace the model value with different text of the EXACT same length: size alone cannot
  // detect the change, so mtime must be part of the cache key. utimes forces a distinct mtime
  // regardless of filesystem timestamp granularity (two fast writes could otherwise share one).
  const edited = JSON.stringify({ model: "opus-4" });
  assert.equal(edited.length, JSON.stringify({ model: "sonnet" }).length);
  fs.writeFileSync(path.join(dir, "tumwater.json"), edited);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, "tumwater.json"), t, t);
  assert.equal(loadConfigCached(dir).config?.model, "opus-4");
});

test("a broken tumwater.json is not cached: every poll retries and a repair recovers", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // healthy baseline is cached
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ not json");
  let reads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      reads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    const broken = loadConfigCached(dir);
    assert.equal(broken.config, undefined);
    assert.match(broken.error ?? "", /not valid JSON/);
    // Still torn on the next poll: retried with a fresh read (nothing was cached), so a
    // repair is picked up immediately — a cached error would wedge last-known-good forever.
    assert.match(loadConfigCached(dir).error ?? "", /not valid JSON/);
    assert.equal(reads, 2);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "haiku" }));
  assert.equal(loadConfigCached(dir).config?.model, "haiku"); // repaired — fresh load
});

test("a vanished tumwater.json is reported missing, never as defaults, and its return reloads fresh", () => {
  // BUGS.md 2026-09-23: a landing's fast-forward deleted the live file and the hot-reload served
  // defaultConfig(), silently resetting the fleet. Missing is its own answer — no config, no
  // error — so the orchestrator can keep its last-known-good exactly as for a broken file.
  const dir = tmpdir();
  assert.deepEqual(loadConfigCached(dir), { missing: true }, "never present: missing too");
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet", maxConcurrent: 3 }));
  assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // healthy baseline is cached
  fs.rmSync(path.join(dir, "tumwater.json"));
  assert.deepEqual(loadConfigCached(dir), { missing: true });
  assert.deepEqual(loadConfigCached(dir), { missing: true }, "still missing on the next poll");
  // loadConfig keeps its first-run contract: an absent file is the bare defaults.
  assert.deepEqual(loadConfig(dir), defaultConfig());
  // The file returning is a fresh load (the stale cache entry was dropped with the vanish).
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet", maxConcurrent: 3 }));
  assert.equal(loadConfigCached(dir).config?.maxConcurrent, 3);
});

test("a tumwater.json deleted between the cache's stat and its read is an error, not defaults", () => {
  // The stat is loadConfigCached's one presence check: a deletion landing just after it (a git
  // checkout unlinking the file mid-poll) must not be re-checked into loadConfig's
  // missing-means-defaults answer — that would reset the fleet for one poll, the very bug.
  const dir = tmpdir();
  const file = path.join(dir, "tumwater.json");
  fs.writeFileSync(file, JSON.stringify({ model: "sonnet" }));
  const originalStatSync = fs.statSync.bind(fs);
  try {
    (fs as unknown as { statSync: unknown }).statSync = (...args: unknown[]) => {
      const st = (originalStatSync as (...a: unknown[]) => fs.Stats)(...args);
      if (args[0] === file) fs.rmSync(file); // Vanishes right after the stat saw it.
      return st;
    };
    const raced = loadConfigCached(dir);
    assert.equal(raced.config, undefined, "no defaults config for a file that was just there");
    assert.match(raced.error ?? "", /ENOENT/);
  } finally {
    (fs as unknown as { statSync: unknown }).statSync = originalStatSync;
  }
  assert.deepEqual(loadConfigCached(dir), { missing: true }, "the next poll sees it missing");
});

test("autoRestart defaults on and is validated as a boolean", () => {
  // Self-redeploy (src/redeploy.ts) is the opinionated default for a self-hosting fleet: the
  // alternative — a process that never reloads its own code — ran ten days stale in dogfood.
  assert.equal(defaultConfig().autoRestart, true);
  assert.throws(
    () => validateConfig({ autoRestart: "yes" }),
    /autoRestart must be true or false \(got "yes"\)/,
  );
  assert.doesNotThrow(() => validateConfig({ autoRestart: false }));
});

// --- User-defined loops (plans/user-defined-loops.md, PLANS.md "User-defined loops 1/3") ---

test("defaultConfig carries no customLoops and no longer exempts tumwater.json from review", () => {
  // Config changes no longer ride the commit path (plans/portability.md §3/7): the director's
  // request file is consumed before any diff exists, so the exemption has nothing left to
  // exempt — and removing it closes the mixed doc-plus-config diff it left unreviewed.
  assert.deepEqual(defaultConfig().customLoops, []);
  assert.ok(
    !defaultConfig().review.exemptPaths.includes("tumwater.json"),
    "tumwater.json has left the default review exemptions",
  );
});

test("loadConfig merges customLoops into roles after the built-ins in array order", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({
      customLoops: [
        { name: "docs-auditor", task: "Keep the docs current." },
        { name: "perf-hunter", task: "Hunt perf wins." },
      ],
    }),
  );
  const config = loadConfig(dir);
  assert.deepEqual(config.customLoops, [
    { name: "docs-auditor", task: "Keep the docs current." },
    { name: "perf-hunter", task: "Hunt perf wins." },
  ]);
  // Seeded into roles as enabled defaults, appended after every built-in in array order —
  // that single move is what makes runner creation and live enable/disable work unchanged.
  const ids = Object.keys(config.roles);
  assert.deepEqual(ids.slice(-2), ["docs-auditor", "perf-hunter"]);
  for (const id of allRoleIds())
    assert.ok(ids.indexOf(id) < ids.indexOf("docs-auditor"), `built-in ${id} precedes the customs`);
  assert.equal(config.roles["docs-auditor"]?.enabled, true);
  assert.equal(config.roles["perf-hunter"]?.enabled, true);
});

test("loadConfig defaults customLoops to [] when the key is absent", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), JSON.stringify({ model: "sonnet" }));
  assert.deepEqual(loadConfig(dir).customLoops, []);
  // Built-in behavior byte-identical when customLoops is absent.
  const ids = Object.keys(loadConfig(dir).roles);
  for (const id of allRoleIds()) assert.ok(ids.includes(id), `built-in ${id} still present`);
});

test("validateConfig rejects invalid customLoops entries with named errors", () => {
  // Bad name charset: uppercase, leading dash, and over-long names each fail on their own.
  for (const bad of ["Docs", "-lead", "a".repeat(33)]) {
    assert.match(
      validationError({ customLoops: [{ name: bad, task: "t" }] }),
      /customLoops\[0\]\.name "/,
      `bad name ${JSON.stringify(bad)}`,
    );
  }
  // A non-string name and a missing key are named too.
  assert.match(
    validationError({ customLoops: [{ name: 7, task: "t" }] }),
    /customLoops\[0\]\.name must be a string matching/,
  );
  assert.match(
    validationError({ customLoops: [{ task: "t" }] }),
    /customLoops\[0\]\.name must be a string matching.*\(got missing\)/,
  );

  // Collision with a built-in id (including the director) would shadow its prompt.
  for (const colliding of ["feature", "director"]) {
    assert.match(
      validationError({ customLoops: [{ name: colliding, task: "t" }] }),
      /collides with a built-in role id/,
    );
  }

  // Duplicate names within the list.
  assert.match(
    validationError({ customLoops: [{ name: "docs", task: "a" }, { name: "docs", task: "b" }] }),
    /customLoops\[1\]\.name "docs" is duplicated in customLoops/,
  );

  // Empty, whitespace-only, and over-long tasks. A blank-but-non-empty task is rejected the
  // same way an empty one is: it rides into every tick prefill as blank text.
  assert.match(validationError({ customLoops: [{ name: "docs", task: "" }] }), /customLoops\[0\]\.task must be a non-empty string \(got ""\)/);
  assert.match(
    validationError({ customLoops: [{ name: "docs", task: "   " }] }),
    /customLoops\[0\]\.task must be a non-empty string \(got "   "\)/,
  );
  const long = "x".repeat(4097);
  assert.match(
    validationError({ customLoops: [{ name: "docs", task: long }] }),
    /customLoops\[0\]\.task is 4097 chars — shorten it to at most 4096/,
  );

  // Container and key-shape violations, like every other section.
  assert.match(validationError({ customLoops: "on" }), /customLoops must be an array of \{ name, task \} entries/);
  assert.match(validationError({ customLoops: ["docs"] }), /customLoops\[0\] must be an object with keys name and task/);
  assert.match(
    validationError({ customLoops: [{ name: "docs", task: "t", model: "big" }] }),
    /unknown key "model" in customLoops\[0\] \(valid keys: name, task\)/,
  );

  // A fully valid entry passes — including the 4096-char boundary.
  assert.doesNotThrow(() =>
    validateConfig({ customLoops: [{ name: "docs-auditor", task: "x".repeat(4096) }] }),
  );
});

test("validateConfig accepts a custom id under roles only when listed in customLoops", () => {
  // The cross-check keeps saveConfig consistent with load-time merging: the file's `roles`
  // section may carry per-role settings for a custom exactly like for built-ins.
  assert.doesNotThrow(() =>
    validateConfig({
      customLoops: [{ name: "docs-auditor", task: "t" }],
      roles: { "docs-auditor": { enabled: false, instructions: "be careful" } },
    }),
  );
  // The same id WITHOUT a matching custom entry is still an unknown role.
  assert.match(
    validationError({ roles: { "docs-auditor": { enabled: true } } }),
    /roles\.docs-auditor is not a known role/,
  );
});

test("a custom listed under roles with per-role settings has them applied like a built-in", () => {
  // The seeded `{ enabled: true }` default yields to the file's overlay — seeding customs
  // BEFORE the overlay loop is what makes this work (Refined 2026-09-12 correction).
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({
      customLoops: [
        { name: "docs-auditor", task: "Keep the docs current." },
        { name: "perf-hunter", task: "Hunt perf wins." },
      ],
      roles: {
        "docs-auditor": { enabled: false, instructions: "be careful", minTickIntervalSeconds: 90 },
      },
    }),
  );
  const config = loadConfig(dir);
  assert.equal(config.roles["docs-auditor"]?.enabled, false, "the file's overlay wins over the seeded default");
  // Per-role fields apply through configForRole exactly like for built-ins.
  const asSeen = configForRole(config, "docs-auditor");
  assert.equal(asSeen.minTickIntervalSeconds, 90);
  assert.equal(config.roles["docs-auditor"]?.instructions, "be careful");
  // A custom absent from `roles` stays enabled.
  assert.equal(config.roles["perf-hunter"]?.enabled, true);
});

test("loadConfigCached hands out independent customLoops arrays", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ customLoops: [{ name: "docs-auditor", task: "Keep the docs current." }] }),
  );
  const first = loadConfigCached(dir).config!;
  first.customLoops[0]!.task = "mutated";
  first.roles["docs-auditor"]!.enabled = false;
  // The next poll of an unchanged file must come back clean — cached-config mutation cannot
  // poison later polls (the same contract as piArgs/idleBackoff/review/roles).
  const second = loadConfigCached(dir).config!;
  assert.equal(second.customLoops[0]?.task, "Keep the docs current.");
  assert.equal(second.roles["docs-auditor"]?.enabled, true);
});

test("an invalid customLoops file keeps the fleet-visible contract: loadConfigSafe returns the error", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "tumwater.json"),
    JSON.stringify({ customLoops: [{ name: "feature", task: "t" }] }),
  );
  const broken = loadConfigSafe(dir);
  assert.equal(broken.config, undefined);
  assert.match(broken.error ?? "", /collides with a built-in role id/);
});

test("customLoopNames, isCustomRole, and knownRoleIds are the one source of truth for custom ids", () => {
  const config = defaultConfig();
  config.customLoops = [{ name: "docs-auditor", task: "t" }];
  assert.deepEqual(customLoopNames(config), ["docs-auditor"]);
  assert.equal(isCustomRole(config, "docs-auditor"), true);
  assert.equal(isCustomRole(config, "feature"), false);
  // Catalog first, customs appended — the same order as config.roles.
  assert.deepEqual(knownRoleIds(config), [...allRoleIds(), "docs-auditor"]);
  const empty = defaultConfig();
  assert.deepEqual(customLoopNames(empty), []);
  assert.deepEqual(knownRoleIds(empty), allRoleIds());
});

// --- The cost n/a fallback model (plans/fallback-model.md) ---

test("fallbackModel is an optional validated key, absent by default", () => {
  // Absent by default: the harness cannot know which model on a given machine is free, so a
  // fleet that names none keeps the pause behavior it had before this feature.
  assert.equal(defaultConfig().fallbackModel, undefined);
  assert.doesNotThrow(() => validateConfig({ fallbackModel: { provider: "omlx", model: "q" } }));
  assert.doesNotThrow(() => validateConfig({ fallbackModel: { model: "q" } }));

  // A typo'd key would be silently ignored — the fleet would pause where the operator meant
  // it to keep working — so the key list must fail it, like every other section.
  assert.match(
    validationError({ fallbackModell: { model: "q" } }),
    /unknown key "fallbackModell" in tumwater\.json \(valid keys: .*fallbackModel.*\)/,
  );
  assert.match(
    validationError({ fallbackModel: { modell: "q" } }),
    /unknown key "modell" in fallbackModel \(valid keys: provider, model, thinking\)/,
  );
  assert.match(validationError({ fallbackModel: "omlx" }), /fallbackModel must be an object/);
  assert.match(validationError({ fallbackModel: { model: 7 } }), /fallbackModel\.model must be a string/);
  // An empty string names nothing either: pi.ts skips it and fallbackPair drops it, so the
  // fallback would never engage despite the section passing the shape checks.
  assert.match(
    validationError({ fallbackModel: { provider: "" } }),
    /fallbackModel\.provider must not be empty \(got ""\)/,
  );
  // An empty object names nothing, so it would silently never engage — reject it outright.
  assert.match(validationError({ fallbackModel: {} }), /fallbackModel must name a provider or a model/);
});

test("fallbackPair resolves the fallback over the top-level values", () => {
  const config = defaultConfig();
  config.provider = "hf";
  config.model = "big-paid";
  config.thinking = "high";
  assert.equal(fallbackPair(config), null, "no fallback configured");

  // Each field falls back to the top-level value — the same precedence a role's overrides use.
  assert.deepEqual(fallbackPair({ ...config, fallbackModel: { model: "local-free" } }), {
    provider: "hf",
    model: "local-free",
    thinking: "high",
  });
  assert.deepEqual(
    fallbackPair({ ...config, fallbackModel: { provider: "omlx", model: "local-free", thinking: "off" } }),
    { provider: "omlx", model: "local-free", thinking: "off" },
  );
});

test("applyFallbackModel installs the free pair and drops every model override", () => {
  const config = defaultConfig();
  config.provider = "hf";
  config.model = "big-paid";
  config.fallbackModel = { provider: "omlx", model: "local-free" };
  // A role pinned to its own paid model and a strong paid reviewer: both would keep spending
  // past the cap if the switch only replaced the top-level values.
  config.roles.feature = { enabled: true, provider: "hf", model: "even-bigger-paid", instructions: "keep me" };
  config.review = { ...config.review, provider: "hf", model: "reviewer-paid" };

  const fb = applyFallbackModel(config);
  assert.equal(configForRole(fb, "feature").provider, "omlx");
  assert.equal(configForRole(fb, "feature").model, "local-free");
  assert.equal(reviewConfig(fb).provider, "omlx");
  assert.equal(reviewConfig(fb).model, "local-free");
  // Only the model seams move: everything else the gate keeps re-evaluating against is intact.
  assert.equal(fb.roles.feature?.instructions, "keep me");
  assert.equal(fb.maxDailyCostUsd, config.maxDailyCostUsd);
  assert.deepEqual(fb.review.exemptPaths, config.review.exemptPaths);
  // The source config is untouched — the orchestrator keeps using it for the director.
  assert.equal(configForRole(config, "feature").model, "even-bigger-paid");
  // No fallback configured: the same object back, so the non-fallback path costs nothing.
  const plain = defaultConfig();
  assert.equal(applyFallbackModel(plain), plain);
});

test("loadConfig round-trips fallbackModel and owns its object", () => {
  const dir = tmpdir();
  const config = defaultConfig();
  config.fallbackModel = { provider: "omlx", model: "local-free" };
  saveConfig(dir, config);
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.fallbackModel, { provider: "omlx", model: "local-free" });
  // Two loads must not share the object: a caller mutating one result cannot poison the other
  // (the contract every other section already keeps).
  const again = loadConfigCached(dir).config;
  assert.notEqual(again?.fallbackModel, loaded.fallbackModel);
  assert.deepEqual(again?.fallbackModel, loaded.fallbackModel);
});

// --- changedConfigKeys (PLANS.md "Live config-change event") ---

test("changedConfigKeys reports added, removed, and changed top-level keys", () => {
  const prev = defaultConfig();
  const next = defaultConfig();
  next.provider = "huggingface"; // present in both, changed
  delete (next as { landBatchMax?: number }).landBatchMax; // removed
  (next as unknown as Record<string, unknown>).piArgs = ["--foo"]; // changed array
  assert.deepEqual(changedConfigKeys(prev, next), ["landBatchMax", "piArgs", "provider"]);
  // A key only in one object is still reported; unknown keys are surfaced rather than dropped.
  (prev as unknown as Record<string, unknown>).unknownKey = 1;
  assert.deepEqual(changedConfigKeys(prev, next), ["landBatchMax", "piArgs", "provider", "unknownKey"]);
});

test("changedConfigKeys reports a roles.<id> edit per role, never the whole roles map", () => {
  const prev = defaultConfig();
  const next = defaultConfig();
  next.roles.feature = { ...next.roles.feature!, model: "bigger" };
  assert.deepEqual(changedConfigKeys(prev, next), ["roles.feature"]);
  // Adding a custom loop names both `customLoops` and the affected role entry.
  const added = defaultConfig();
  added.customLoops.push({ name: "docs-auditor", task: "Keep docs current." });
  added.roles["docs-auditor"] = { enabled: true };
  assert.deepEqual(changedConfigKeys(prev, added), ["customLoops", "roles.docs-auditor"]);
  // Removing one reports the same two.
  assert.deepEqual(changedConfigKeys(added, prev), ["customLoops", "roles.docs-auditor"]);
});

test("changedConfigKeys ignores key order and reports nested section names", () => {
  const prev = defaultConfig();
  // A key-order-only rewrite of identical content reports nothing.
  const reordered = JSON.parse(JSON.stringify(prev)) as ReturnType<typeof defaultConfig>;
  const reorder = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reorder);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort().reverse())
        out[k] = reorder((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  assert.deepEqual(changedConfigKeys(prev, reorder(reordered) as never), []);
  // Sub-key edits of a section report the section name, not each leaf.
  const tuned = defaultConfig();
  tuned.idleBackoff = { ...tuned.idleBackoff, maxSeconds: 1 };
  tuned.review = { ...tuned.review, enabled: !tuned.review.enabled };
  tuned.roles.feature = { ...tuned.roles.feature!, thinking: "high" };
  assert.deepEqual(changedConfigKeys(prev, tuned), ["idleBackoff", "review", "roles.feature"]);
});

test("changedConfigKeys skips maxConcurrent and sessionRetentionDays, which have their own events", () => {
  const prev = defaultConfig();
  const next = defaultConfig();
  next.maxConcurrent = prev.maxConcurrent + 1;
  next.sessionRetentionDays = prev.sessionRetentionDays + 1;
  assert.deepEqual(changedConfigKeys(prev, next), []);
});


test("seedConfig overlays a valid tumwater.example.json on the defaults", () => {
  const root = tmpdir();
  fs.writeFileSync(
    exampleConfigPath(root),
    JSON.stringify({ minTickIntervalSeconds: 45, review: { enabled: false } }),
  );
  const seeded = seedConfig(root);
  const base = defaultConfig();
  assert.equal(seeded.minTickIntervalSeconds, 45);
  // The template's partial review section merges over the default's, like loadConfig's would.
  assert.deepEqual(seeded.review, { ...base.review, enabled: false });
  // Untouched keys keep the defaults: the template is a baseline, not a whole config.
  assert.equal(seeded.maxConcurrent, base.maxConcurrent);
  assert.deepEqual(Object.keys(seeded.roles), Object.keys(base.roles));
});

test("seedConfig falls back to the defaults with no example, a malformed one, or an invalid one", () => {
  const none = seedConfig(tmpdir());
  assert.deepEqual(none, defaultConfig());

  const malformed = tmpdir();
  fs.writeFileSync(exampleConfigPath(malformed), "{ not json");
  // Seeding never throws — init must not die on a bad template.
  assert.deepEqual(seedConfig(malformed), defaultConfig());

  const invalid = tmpdir();
  fs.writeFileSync(
    exampleConfigPath(invalid),
    JSON.stringify({ minTickIntervalSeconds: -5 }),
  );
  assert.deepEqual(seedConfig(invalid), defaultConfig());
});

test("exampleConfigProblem names a broken template and stays null on a usable one", () => {
  // Absent template: nothing to serve, no problem to report.
  assert.equal(exampleConfigProblem(tmpdir()), null);

  const valid = tmpdir();
  fs.writeFileSync(exampleConfigPath(valid), JSON.stringify({ minTickIntervalSeconds: 45 }));
  assert.equal(exampleConfigProblem(valid), null);

  // A parse failure must name the example file, not leave a bare syntax error for the
  // operator to attribute to the wrong file.
  const malformed = tmpdir();
  fs.writeFileSync(exampleConfigPath(malformed), "{ not json");
  assert.match(exampleConfigProblem(malformed) ?? "", /tumwater\.example\.json is not valid JSON/);

  // A validation failure carries the full problem list under the example's name — the same
  // wording loadConfig throws for tumwater.json, relabeled so it cannot be misread.
  const invalid = tmpdir();
  fs.writeFileSync(exampleConfigPath(invalid), JSON.stringify({ minTickIntervalSeconds: -5 }));
  const problem = exampleConfigProblem(invalid) ?? "";
  assert.match(problem, /invalid tumwater\.example\.json/);
  assert.match(problem, /minTickIntervalSeconds/);

  // A non-object template reads as invalid, not as "must be a JSON object" twice over.
  const nonObject = tmpdir();
  fs.writeFileSync(exampleConfigPath(nonObject), "[1]");
  assert.match(exampleConfigProblem(nonObject) ?? "", /tumwater\.example\.json must be a JSON object/);
});

test("exampleDrift names template keys the local config lacks, and nothing else", () => {
  const root = tmpdir();
  fs.writeFileSync(
    exampleConfigPath(root),
    JSON.stringify({ minTickIntervalSeconds: 45, landBatchMax: 2 }),
  );
  // No local file yet: nothing to compare, so no drift.
  assert.deepEqual(exampleDrift(root), []);

  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify({ landBatchMax: 3 }));
  // Whole-key comparison: a key present in both files is the local file's business even when
  // the values differ; only keys the template sets and the file lacks are drift.
  assert.deepEqual(exampleDrift(root), ["minTickIntervalSeconds"]);

  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({ minTickIntervalSeconds: 20, landBatchMax: 3 }),
  );
  assert.deepEqual(exampleDrift(root), []);

  // Unparseable files and non-objects on either side are silence, not a crash.
  fs.writeFileSync(path.join(root, "tumwater.json"), "{ broken");
  assert.deepEqual(exampleDrift(root), []);
  fs.writeFileSync(path.join(root, "tumwater.json"), "[1]");
  assert.deepEqual(exampleDrift(root), []);
  fs.writeFileSync(exampleConfigPath(root), "{ broken");
  assert.deepEqual(exampleDrift(root), []);
  assert.deepEqual(exampleDrift(tmpdir()), []);
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
    /check\.timeoutSeconds must be a number greater than 0 \(got 0\)/,
  );
  assert.match(
    validationError({ provider: "p", model: "m", check: { command: "x", timeoutSeconds: -30 } }),
    /check\.timeoutSeconds must be a number greater than 0 \(got -30\)/,
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
