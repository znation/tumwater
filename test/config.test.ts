import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  changedConfigKeys,
  customLoopNames,
  defaultConfig,
  isCustomRole,
  knownRoleIds,
  knownRoleIdsCached,
  loadConfig,
  loadConfigCached,
  loadConfigSafe,
  saveConfig,
} from "../src/config/config.js";
import { exampleConfigProblem, exampleDrift, seedConfig } from "../src/config/config-example.js";
import { configForRole } from "../src/config/config-views.js";
import { exampleConfigPath } from "../src/paths.js";
import { validateConfig } from "../src/config/config-validation.js";
import { allRoleIds } from "../src/roles.js";
import { errorMessage } from "../src/text.js";
import { backdate } from "./backdate.js";
import { withCountedReads } from "./fs-faults.js";
import { tmpdir, writeConfig, writeMalformedJson } from "./repo-fixtures.js";

// The longest tick a hosted model legitimately took and still landed work (BUGS.md 2026-09-29:
// telemetry at 185 minutes). A shipped default at or below it re-kills every such tick and
// restarts the same long task from scratch — the 2026-09-22 meltdown shape.
const LONGEST_LEGITIMATE_TICK_S = 185 * 60;

test("the shipped tick budget clears the longest legitimate observed tick", () => {
  assert.ok(
    defaultConfig().tickTimeoutSeconds > LONGEST_LEGITIMATE_TICK_S,
    `tickTimeoutSeconds ${defaultConfig().tickTimeoutSeconds}s must exceed the longest legitimate tick (${LONGEST_LEGITIMATE_TICK_S}s)`,
  );
});

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
      // The message names the MAX_SAFE_INTEGER upper bound too (BUGS.md 2026-10-02).
      new RegExp(`^invalid tumwater\\.json:.*maxDailyCostUsd must be a number of 0 or more, at most ${Number.MAX_SAFE_INTEGER} \\(0 disables\\) \\(got ${JSON.stringify(bad)}\\)`, "s"),
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
  writeConfig(dir, { model: "sonnet" });
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
      // Above the default initialSeconds, so the merged shape stays valid — a max BELOW
      // the default initial is loadConfig's rejection, tested separately below.
      idleBackoff: { maxSeconds: 7200 },
      roles: { clean: { enabled: false }, perf: { enabled: true } },
    }),
  );
  const config = loadConfig(dir);
  assert.equal(config.model, "sonnet");
  assert.equal(config.idleBackoff.maxSeconds, 7200);
  assert.equal(config.idleBackoff.factor, defaultConfig().idleBackoff.factor);
  assert.equal(config.roles.clean?.enabled, false);
  assert.equal(config.roles.improve?.enabled, true);
  assert.equal(config.roles.perf?.enabled, true);
});

test("loadConfig rejects a backoff max below the initial it would clamp away, naming both values", () => {
  // Judged on the MERGED config (the shape saveConfig gates, so load and save agree): a
  // file naming only maxSeconds is measured against the default initialSeconds it merges
  // with — the same wait scheduleBackoff would silently clamp at runtime.
  const dir = tmpdir();
  writeConfig(dir, { idleBackoff: { maxSeconds: 60 } });
  assert.throws(
    () => loadConfig(dir),
    /idleBackoff\.maxSeconds \(60\) must be ≥ idleBackoff\.initialSeconds \(120\)/,
  );
  // And when the file names both keys itself.
  writeConfig(dir, { idleBackoff: { initialSeconds: 300, maxSeconds: 60 } });
  assert.throws(
    () => loadConfig(dir),
    /idleBackoff\.maxSeconds \(60\) must be ≥ idleBackoff\.initialSeconds \(300\)/,
  );
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

// config-views.ts's derived views (configForRole, reviewConfig, reviewRunConfig,
// fallbackPair, applyFallbackModel) have their own topic file: test/config-views.test.ts.

function validationError(raw: unknown): string {
  try {
    validateConfig(raw);
  } catch (err) {
    return errorMessage(err);
  }
  throw new Error("validateConfig did not throw");
}

// --- loadConfigCached: the stat-keyed cache behind every poll's config reload ---

test("an unchanged tumwater.json is served from the stat-keyed cache without re-reading", () => {
  const dir = tmpdir();
  writeConfig(dir, { model: "sonnet" });
  assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // populates the cache
  withCountedReads((reads) => {
    assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // unchanged — no file I/O at all
    assert.equal(reads(), 0);
    // Each call still gets its own config: mutating one result must not poison the cache.
    const cfg = loadConfigCached(dir).config!;
    cfg.maxConcurrent = 99;
    assert.ok(cfg.roles.plan, "plan is in the catalog — defaultConfig enables every role");
    cfg.roles.plan.enabled = false;
    assert.equal(loadConfigCached(dir).config?.maxConcurrent, defaultConfig().maxConcurrent);
    assert.equal(loadConfigCached(dir).config?.roles.plan?.enabled, true);
  });
});

test("a same-size tumwater.json edit is picked up via mtime, not just size", () => {
  const dir = tmpdir();
  writeConfig(dir, { model: "sonnet" });
  assert.equal(loadConfigCached(dir).config?.model, "sonnet");
  // Replace the model value with different text of the EXACT same length: size alone cannot
  // detect the change, so mtime must be part of the cache key. utimes forces a distinct mtime
  // regardless of filesystem timestamp granularity (two fast writes could otherwise share one).
  const edited = JSON.stringify({ model: "opus-4" });
  assert.equal(edited.length, JSON.stringify({ model: "sonnet" }).length);
  fs.writeFileSync(path.join(dir, "tumwater.json"), edited);
  backdate(path.join(dir, "tumwater.json"), -5000);
  assert.equal(loadConfigCached(dir).config?.model, "opus-4");
});

test("a broken tumwater.json is not cached: every poll retries and a repair recovers", () => {
  const dir = tmpdir();
  writeConfig(dir, { model: "sonnet" });
  assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // healthy baseline is cached
  writeMalformedJson(path.join(dir, "tumwater.json"));
  const reads = withCountedReads(() => {
    const broken = loadConfigCached(dir);
    assert.equal(broken.config, undefined);
    assert.match(broken.error ?? "", /not valid JSON/);
    // Still torn on the next poll: retried with a fresh read (nothing was cached), so a
    // repair is picked up immediately — a cached error would wedge last-known-good forever.
    assert.match(loadConfigCached(dir).error ?? "", /not valid JSON/);
  });
  assert.equal(reads, 2);
  writeConfig(dir, { model: "haiku" });
  assert.equal(loadConfigCached(dir).config?.model, "haiku"); // repaired — fresh load
});

test("a vanished tumwater.json is reported missing, never as defaults, and its return reloads fresh", () => {
  // BUGS.md 2026-09-23: a landing's fast-forward deleted the live file and the hot-reload served
  // defaultConfig(), silently resetting the fleet. Missing is its own answer — no config, no
  // error — so the orchestrator can keep its last-known-good exactly as for a broken file.
  const dir = tmpdir();
  assert.deepEqual(loadConfigCached(dir), { missing: true }, "never present: missing too");
  writeConfig(dir, { model: "sonnet", maxConcurrent: 3 });
  assert.equal(loadConfigCached(dir).config?.model, "sonnet"); // healthy baseline is cached
  fs.rmSync(path.join(dir, "tumwater.json"));
  assert.deepEqual(loadConfigCached(dir), { missing: true });
  assert.deepEqual(loadConfigCached(dir), { missing: true }, "still missing on the next poll");
  // loadConfig keeps its first-run contract: an absent file is the bare defaults.
  assert.deepEqual(loadConfig(dir), defaultConfig());
  // The file returning is a fresh load (the stale cache entry was dropped with the vanish).
  writeConfig(dir, { model: "sonnet", maxConcurrent: 3 });
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
  writeConfig(dir, { model: "sonnet" });
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

test("knownRoleIdsCached is the one home of the read-only fallback rule", () => {
  // No config: the built-in catalog, without touching loadConfigCached's cache contract.
  assert.deepEqual(knownRoleIdsCached(tmpdir()), allRoleIds());
  // A config with customs: catalog plus the user-defined loops.
  const withCustom = tmpdir();
  writeConfig(withCustom, { customLoops: [{ name: "docs-auditor", task: "t" }] });
  assert.deepEqual(knownRoleIdsCached(withCustom), [...allRoleIds(), "docs-auditor"]);
  // A transiently broken tumwater.json must not take a read-only view down: it falls back to
  // the built-in catalog rather than refusing every id.
  const broken = tmpdir();
  fs.writeFileSync(path.join(broken, "tumwater.json"), "{");
  assert.deepEqual(knownRoleIdsCached(broken), allRoleIds());
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
  writeMalformedJson(exampleConfigPath(malformed));
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
  writeMalformedJson(exampleConfigPath(malformed));
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

  writeConfig(root, { landBatchMax: 3 });
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
