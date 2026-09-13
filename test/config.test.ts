import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  configForRole,
  customLoopNames,
  defaultConfig,
  isCustomRole,
  knownRoleIds,
  loadConfig,
  loadConfigCached,
  loadConfigSafe,
  reviewConfig,
  saveConfig,
  setDailyBudgetUsd,
} from "../src/config.js";
import { validateConfig } from "../src/config-validation.js";
import { allRoleIds } from "../src/roles.js";
import { errorMessage } from "../src/text.js";
import { tmpdir } from "./util.js";

test("defaultConfig enables every role including director", () => {
  const config = defaultConfig();
  for (const id of allRoleIds()) {
    assert.equal(config.roles[id]?.enabled, true, `role ${id} should default enabled`);
  }
  assert.ok(config.maxConcurrent >= 1);
  assert.ok(config.idleBackoff.maxSeconds >= config.idleBackoff.initialSeconds);
});

test("defaultConfig gives the slow-clock roles their clocks and no other role one", () => {
  // Regression: feature tick 49 set this via `roles.steward.minTickIntervalSeconds = …`,
  // which does not compile under noUncheckedIndexedAccess — a broken build landed on main.
  const config = defaultConfig();
  assert.equal(configForRole(config, "steward").minTickIntervalSeconds, 21600);
  assert.equal(configForRole(config, "qa").minTickIntervalSeconds, 7200);
  // The bookkeeping roles: readme batches landings into one sync per half hour, plan re-audits
  // at most hourly — in dogfood the two were 30% of all commits at the global 20 s clock.
  assert.equal(configForRole(config, "readme").minTickIntervalSeconds, 1800);
  assert.equal(configForRole(config, "plan").minTickIntervalSeconds, 3600);
  for (const id of allRoleIds()) {
    if (id === "steward" || id === "qa" || id === "readme" || id === "plan") continue;
    // Every other role falls back to the global interval.
    assert.equal(
      configForRole(config, id).minTickIntervalSeconds,
      config.minTickIntervalSeconds,
      `role ${id} should inherit the global minTickIntervalSeconds`,
    );
  }
});

test("defaultConfig carries the thrash thresholds and validation guards them", () => {
  // AC5 (plans/refusal-and-thrash.md): the friction thresholds default to 40 turns / 60
  // minutes, and invalid values are rejected with actionable errors like every other knob.
  const config = defaultConfig();
  assert.equal(config.thrashTurns, 40);
  assert.equal(config.thrashMinutes, 60);
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

function validationError(raw: unknown): string {
  try {
    validateConfig(raw);
  } catch (err) {
    return errorMessage(err);
  }
  throw new Error("validateConfig did not throw");
}

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
    /unknown key "modle" in review \(valid keys: enabled, exemptPaths, provider, model, thinking\)/,
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
  }

  // A fully valid section still passes.
  assert.doesNotThrow(() =>
    validateConfig({ review: { enabled: false, exemptPaths: ["*.md"], provider: "p", model: "m", thinking: "high" } }),
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

// setDailyBudgetUsd — the shared setter behind the TUI's Ctrl+B editor and the GUI's
// /api/budget endpoint: fresh read-modify-write of ONE key, atomic (tmp + rename), errors as
// strings so both surfaces can flash them without try/catch plumbing.
test("setDailyBudgetUsd persists only the cap, atomically, and rejects invalid values", () => {
  const dir = tmpdir();
  // Start from a config with distinctive values in other keys so preservation is observable.
  const base = defaultConfig();
  base.maxConcurrent = 3;
  base.roles.clean!.instructions = "keep it tidy";
  saveConfig(dir, base);

  // Valid whole / fractional / zero caps persist and preserve every other key (0 disables).
  for (const value of [25, 12.34, 0]) {
    assert.deepEqual(setDailyBudgetUsd(dir, value), { ok: true }, `cap ${value}`);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "tumwater.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.maxDailyCostUsd, value);
    delete raw.maxDailyCostUsd;
    const { maxDailyCostUsd: _cap, ...rest } = loadConfig(dir) as unknown as Record<string, unknown> & {
      maxDailyCostUsd: number;
    };
    assert.deepEqual(raw, rest, `only the cap differs after setting ${value}`);
  }

  // Invalid values reject with an actionable message and leave the file untouched.
  const before = fs.readFileSync(path.join(dir, "tumwater.json"), "utf8");
  for (const value of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const r = setDailyBudgetUsd(dir, value);
    assert.equal(r.ok, false, String(value));
    if (!r.ok) assert.match(r.error, /number of 0 or more/);
  }
  assert.equal(fs.readFileSync(path.join(dir, "tumwater.json"), "utf8"), before, "rejected values change nothing");

  // No tmp remnant from any write (successes and the rejected ones).
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith("tumwater.json.tmp-")),
    [],
    "no tmp file left behind",
  );

  // A broken config is surfaced as an error, never overwritten with defaults + the new cap.
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ still editing");
  const r = setDailyBudgetUsd(dir, 10);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, "tumwater.json"), "utf8"), "{ still editing");
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

test("defaultConfig carries no customLoops and exempts tumwater.json from review", () => {
  // Only the director can ever produce a diff touching tumwater.json, so exempting it means
  // user-directed config changes skip model review — validateConfig is the safety net.
  assert.deepEqual(defaultConfig().customLoops, []);
  assert.ok(
    defaultConfig().review.exemptPaths.includes("tumwater.json"),
    "the tracked config file joins the default review exemptions",
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

  // Empty and over-long tasks.
  assert.match(validationError({ customLoops: [{ name: "docs", task: "" }] }), /customLoops\[0\]\.task must be a non-empty string \(got ""\)/);
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
