import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyConfigRequest,
  parseConfigKey,
  setConfigKey,
  setDailyBudgetUsd,
} from "../src/config/config-write.js";
import { customLoopNames, defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";
import { configRequestPath } from "../src/paths.js";
import { runningAsRoot, tmpdir } from "./repo-fixtures.js";

// Tests for src/config/config-write.ts — the harness-mediated write paths split out of src/config/config.ts
// (the budget setter behind both dashboards, and the director's config request file). Tests for
// src/config/config.ts itself live in test/config.test.ts and for src/config/config-validation.ts in
// test/config-validation.test.ts.

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
    const raw = readJson(path.join(dir, "tumwater.json")) as Record<string, unknown>;
    assert.equal(raw.maxDailyCostUsd, value);
    delete raw.maxDailyCostUsd;
    const { maxDailyCostUsd: _cap, ...rest } = loadConfig(dir) as unknown as Record<string, unknown> & {
      maxDailyCostUsd: number;
    };
    assert.deepEqual(raw, rest, `only the cap differs after setting ${value}`);
  }

  // Invalid values reject with an actionable message and leave the file untouched.
  // 1e24 is the BUGS.md 2026-10-02 regression: finite, so the old isFinite-only screen
  // admitted it, and a one-zero typo wrote an effectively uncapped budget.
  const before = fs.readFileSync(path.join(dir, "tumwater.json"), "utf8");
  for (const value of [Number.NaN, -1, Number.POSITIVE_INFINITY, 1e24, Number("9" + "0".repeat(24))]) {
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

// The write-side failure path: when the config directory cannot take a new file (disk full,
// permissions), the error surfaces as a string instead of throwing, the old file is left
// byte-for-byte intact, and the atomic writer's tmp file does not linger. Skipped under root,
// where chmod cannot stop the write (the success path already covers the ordinary case).
test("setDailyBudgetUsd reports a failed write and leaves the config untouched", (t) => {
  if (runningAsRoot()) {
    t.skip("chmod cannot stop a root process");
    return;
  }
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxDailyCostUsd = 7;
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");
  fs.chmodSync(dir, 0o555); // readable and searchable, not writable — the tmp write fails
  try {
    const r = setDailyBudgetUsd(dir, 25);
    assert.equal(r.ok, false, "a failed write is surfaced, never thrown");
    if (!r.ok) assert.ok(r.error.length > 0, "a non-empty error string for the UI to flash");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the old config is untouched");
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith("tumwater.json.tmp-")),
      [],
      "the failed write leaves no tmp remnant",
    );
  } finally {
    fs.chmodSync(dir, 0o755); // restore so temp-dir cleanup can remove it
  }
});

// The writeJsonAtomic arm specifically: the lock (under .tumwater/state) must still be
// acquirable while the repo root is not writable, so the failure lands in writeConfigMutation's
// atomic-write catch rather than the outer lock catch. Pre-creating the state dir makes the two
// separable — chmod on the root does not change the state dir's own permissions.
test("setDailyBudgetUsd surfaces an atomic-write failure after the lock is taken", (t) => {
  if (runningAsRoot()) {
    t.skip("chmod cannot stop a root process");
    return;
  }
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxDailyCostUsd = 7;
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");
  fs.mkdirSync(path.join(dir, ".tumwater", "state"), { recursive: true });
  fs.chmodSync(dir, 0o555); // root read-only; .tumwater/state stays writable, so the lock succeeds
  try {
    const r = setDailyBudgetUsd(dir, 25);
    assert.equal(r.ok, false, "the failed atomic write is surfaced, never thrown");
    if (!r.ok) assert.ok(r.error.length > 0, "a non-empty error string for the UI to flash");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the old config is untouched");
  } finally {
    fs.chmodSync(dir, 0o755); // restore so temp-dir cleanup can remove it
  }
});

// setConfigKey — `tumwater config set`'s engine: one top-level key, the value JSON-parsed
// when parseable and the literal string otherwise, the whole merged candidate validated
// before any write.
test("setConfigKey parses JSON values, keeps literal strings, and preserves other keys", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxConcurrent = 3;
  saveConfig(dir, base);

  // A JSON-parseable value keeps its parsed type: numbers stay numbers, quoted text strings.
  let r = setConfigKey(dir, "minTickIntervalSeconds", "45");
  assert.deepEqual(r, { ok: true, value: 45, oldValue: defaultConfig().minTickIntervalSeconds });
  let raw = readJson(path.join(dir, "tumwater.json")) as Record<string, unknown>;
  assert.strictEqual(raw.minTickIntervalSeconds, 45, "config set minTickIntervalSeconds=45 persists the parsed number 45");
  assert.strictEqual(raw.maxConcurrent, 3, "other keys preserved");

  r = setConfigKey(dir, "model", '"gpt-5"');
  assert.ok(r.ok && r.value === "gpt-5");

  // A non-JSON value lands as the literal string — `set model gpt-5` needs no quotes.
  r = setConfigKey(dir, "model", "gpt-5");
  assert.ok(r.ok && r.value === "gpt-5" && r.oldValue === "gpt-5");
  raw = readJson(path.join(dir, "tumwater.json")) as Record<string, unknown>;
  assert.strictEqual(raw.model, "gpt-5", "config set model gpt-5 (unquoted) persists the literal string gpt-5");
});

test("setConfigKey rejects an unknown key and a type-invalid value, leaving the file untouched", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  // An unknown key: the error names the valid keys (the same list checkKnownKeys enforces)
  // and points a typo at its real spelling, like the unknown-command error does.
  let r = setConfigKey(dir, "modle", "x");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /unknown config key "modle" \(valid top-level keys: .+\)/);
    assert.match(r.error, /— did you mean `model`\?/);
  }

  // A type-invalid value fails with validateConfig's own message.
  r = setConfigKey(dir, "minTickIntervalSeconds", '"45"');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /minTickIntervalSeconds must be a number of 0 or more/);

  // Both failures left tumwater.json byte-identical.
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("setConfigKey writes and clears quietHours; a malformed window fails untouched", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");

  // A valid window persists as the literal string (no JSON quotes needed).
  let r = setConfigKey(dir, "quietHours", "23:00-07:00");
  assert.ok(r.ok && r.value === "23:00-07:00");
  let raw = readJson(file) as Record<string, unknown>;
  assert.strictEqual(raw.quietHours, "23:00-07:00", "a valid quietHours persists as the literal string");

  // An empty string is the documented off.
  r = setConfigKey(dir, "quietHours", "");
  assert.ok(r.ok && r.value === "");
  raw = readJson(file) as Record<string, unknown>;
  assert.strictEqual(raw.quietHours, "", "an empty quietHours persists as the documented off value");

  // A malformed window fails with checkQuietHours's own actionable message, and the file is
  // byte-identical — the per-key validator screens it before writeConfigMutation runs.
  const before = fs.readFileSync(file, "utf8");
  r = setConfigKey(dir, "quietHours", "25:00-07:00");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /quietHours times must be 24-hour/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

// Harness-mediated config writes (plans/portability.md §3/7): the director leaves a request
// file in its worktree; applyConfigRequest validates, applies only customLoops, and deletes
// the request on EVERY path — so custom-loop management works with the config tracked,
// gitignored, or absent, and the file never reaches a commit.

function writeRequest(wt: string, value: unknown): void {
  fs.writeFileSync(configRequestPath(wt), typeof value === "string" ? value : JSON.stringify(value));
}

test("applyConfigRequest returns null when no request file exists", () => {
  const root = tmpdir();
  const wt = tmpdir();
  assert.equal(applyConfigRequest(root, wt), null);
});

test("applyConfigRequest applies a customLoops array to the live config and deletes the request", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customLoops: [{ name: "docs", task: "Keep the examples current." }] });
  const result = applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  // The loop is live (loadConfig re-reads the file) with defaults otherwise intact.
  assert.deepEqual(customLoopNames(loadConfig(root)), ["docs"]);
  assert.equal(loadConfig(root).maxDailyCostUsd, defaultConfig().maxDailyCostUsd);
  // The request file is gone — it can never be staged by commitAll.
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest replaces the whole array and strips orphaned roles entries", () => {
  const root = tmpdir();
  const wt = tmpdir();
  const config = defaultConfig();
  config.customLoops = [
    { name: "docs", task: "old task" },
    { name: "scrape", task: "old task" },
  ];
  config.roles.docs = { enabled: false };
  config.roles.scrape = { enabled: false };
  saveConfig(root, config);
  // The replacement array keeps only docs — scrape's roles entry must go with it, or
  // validateConfig would reject the orphaned id and the removal would never apply.
  writeRequest(wt, { customLoops: [{ name: "docs", task: "new task" }] });
  const result = applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  const loaded = loadConfig(root);
  assert.deepEqual(customLoopNames(loaded), ["docs"]);
  assert.equal(loaded.customLoops[0]!.task, "new task");
  assert.equal(loaded.roles.docs?.enabled, false, "a kept loop's roles entry survives");
  assert.ok(!("scrape" in loaded.roles), "a removed loop's roles entry is stripped");
});

test("applyConfigRequest ignores disallowed keys with their names, and still applies customLoops", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, {
    customLoops: [{ name: "docs", task: "Keep the examples current." }],
    maxDailyCostUsd: 1,
    roles: { director: { enabled: false } },
  });
  const result = applyConfigRequest(root, wt);
  // applied names ride with ignored so the caller can warn without losing the good half.
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, ["maxDailyCostUsd", "roles"]);
  assert.equal(result?.error, undefined);
  const loaded = loadConfig(root);
  assert.deepEqual(customLoopNames(loaded), ["docs"]);
  // The ignored keys changed nothing: the permitted-key filter drops them before the merge.
  assert.equal(loaded.maxDailyCostUsd, defaultConfig().maxDailyCostUsd);
  assert.equal(loaded.roles.director?.enabled, true);
});

test("applyConfigRequest rejects an invalid candidate: nothing written, previous config live, request deleted", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customLoops: [{ name: "Docs", task: "uppercase name" }] });
  const result = applyConfigRequest(root, wt);
  assert.ok(result && result.error, "a validation failure surfaces as an error string");
  assert.match(result.error, /customLoops\[0\]\.name/);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(loadConfig(root), defaultConfig());
  // Deleted anyway — a malformed request must not retry forever.
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest survives structurally malformed requests without throwing", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  // Regression: a null entry must reach validateConfig as a named problem, never crash on a
  // premature `.name` dereference.
  writeRequest(wt, { customLoops: [null] });
  let result = applyConfigRequest(root, wt);
  assert.ok(result && result.error && /customLoops\[0\]/.test(result.error), JSON.stringify(result));
  assert.deepEqual(loadConfig(root), defaultConfig());
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, "not json at all");
  result = applyConfigRequest(root, wt);
  assert.ok(result && result.error, "unparseable JSON surfaces as an error string");
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, { customLoops: "everything" });
  result = applyConfigRequest(root, wt);
  assert.ok(result && result.error && /must be an array/.test(result.error), JSON.stringify(result));
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, ["an array, not an object"]);
  result = applyConfigRequest(root, wt);
  assert.ok(result && result.error && /must be a JSON object/.test(result.error), JSON.stringify(result));
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

// The one failure the delete-on-every-path rule cannot absorb: the unlink itself fails (a
// permissions surprise on the worktree directory — the same shape as a full disk or an
// externally locked file). The application stands (its write already happened), the failure is
// surfaced as the error string (the caller logs it; the file would otherwise survive into
// commitAll's `git add -A` and reach a review gate), and the file is still there for a retry.
// Skipped under root, where chmod cannot stop the unlink (the success path already covers it).
test("a request whose unlink fails is still applied, with the failed deletion surfaced as the error", (t) => {
  if (runningAsRoot()) {
    t.skip("chmod cannot stop a root process");
    return;
  }
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customLoops: [{ name: "docs", task: "Keep the examples current." }] });
  fs.chmodSync(wt, 0o555); // readable and searchable — the read succeeds, the unlink cannot
  try {
    const result = applyConfigRequest(root, wt);
    assert.ok(result, "a present request file is never read as null");
    assert.deepEqual(result.applied, ["docs"], "the write happened before the failed cleanup");
    assert.deepEqual(customLoopNames(loadConfig(root)), ["docs"], "the loop is live");
    assert.match(result.error ?? "", /could not be deleted/);
    assert.ok(fs.existsSync(configRequestPath(wt)), "the undeletable request is still on disk");
  } finally {
    fs.chmodSync(wt, 0o755); // restore so temp-dir cleanup can remove it
  }
});

// The ??= precedence: a request that failed validation AND could not be deleted reports the
// validation problem — the reason the caller acts on — never the cleanup noise.
test("a validation failure outranks a failed deletion in the surfaced error", (t) => {
  if (runningAsRoot()) {
    t.skip("chmod cannot stop a root process");
    return;
  }
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customLoops: [{ name: "Docs", task: "uppercase name" }] });
  fs.chmodSync(wt, 0o555);
  try {
    const result = applyConfigRequest(root, wt);
    assert.ok(result);
    assert.deepEqual(result.applied, []);
    assert.match(result.error ?? "", /customLoops\[0\]\.name/);
    assert.doesNotMatch(result.error ?? "", /could not be deleted/);
  } finally {
    fs.chmodSync(wt, 0o755);
  }
  assert.ok(fs.existsSync(configRequestPath(wt)), "still undeletable after the failure");
});

// Dotted per-role keys (parseConfigKey via setConfigKey): `<map>.<role>` and
// `roles.<id>.<field>` MERGE one entry into the existing map/section, so steering one role
// never requires re-typing the others; bare keys keep their whole-value semantics.
test("setConfigKey merges one dotted map entry, preserving the other roles' entries", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxDailyCostUsdPerRole = { qa: 2 };
  base.quietHoursPerRole = { qa: "23:00-07:00" };
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // A dotted dollar-cap entry merges: qa's value stays byte-identical in the file.
  const before = fs.readFileSync(file, "utf8");
  let r = setConfigKey(dir, "maxDailyCostUsdPerRole.feature", "1.5");
  assert.ok(r.ok && r.value === 1.5 && r.oldValue === undefined, JSON.stringify(r));
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(raw.maxDailyCostUsdPerRole, { qa: 2, feature: 1.5 }, "merge, not replace");
  assert.ok(before.includes('"qa": 2') && fs.readFileSync(file, "utf8").includes('"qa": 2'), "qa's entry survives verbatim");

  // A second write to the same dotted key reports the previous value.
  r = setConfigKey(dir, "maxDailyCostUsdPerRole.feature", "3");
  assert.ok(r.ok && r.value === 3 && r.oldValue === 1.5, JSON.stringify(r));

  // quietHoursPerRole.<role> merges too, and an invalid window fails untouched.
  r = setConfigKey(dir, "quietHoursPerRole.clean", "01:00-06:00");
  assert.ok(r.ok && r.value === "01:00-06:00");
  assert.deepEqual(
    (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>).quietHoursPerRole,
    { qa: "23:00-07:00", clean: "01:00-06:00" },
  );
  const untouched = fs.readFileSync(file, "utf8");
  r = setConfigKey(dir, "quietHoursPerRole.clean", "25:00-07:00");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /quietHours times must be 24-hour/);
  assert.equal(fs.readFileSync(file, "utf8"), untouched, "a rejected dotted value changes nothing");

  // A non-numeric dollar cap fails with checkDailyBudgetUsd's message, before the write.
  r = setConfigKey(dir, "maxDailyCostUsdPerRole.feature", '"lots"');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /number of 0 or more/);
  assert.equal(fs.readFileSync(file, "utf8"), untouched);
});

test("setConfigKey merges one roles.<id>.<field> entry; bad fields and role ids fail", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.roles.qa!.model = "m-qa";
  base.roles.qa!.instructions = "test things";
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");

  // The field write merges: the entry's other fields survive.
  let r = setConfigKey(dir, "roles.qa.model", "m-new");
  assert.ok(r.ok && r.value === "m-new" && r.oldValue === "m-qa", JSON.stringify(r));
  const roles = (JSON.parse(fs.readFileSync(file, "utf8")) as { roles: Record<string, Record<string, unknown>> }).roles;
  assert.equal(roles.qa!.model, "m-new");
  assert.equal(roles.qa!.instructions, "test things", "the entry's other fields preserved");

  // A field outside ROLE_ENTRY_KEYS fails with the nearest-key suggestion, file untouched.
  const before = fs.readFileSync(file, "utf8");
  r = setConfigKey(dir, "roles.qa.colour", "x");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /unknown role field "colour" for roles\.qa/);
    assert.match(r.error, /did you mean `model`|did you mean `provider`|valid fields:/);
  }

  // A typo'd role id is left for validateConfig's known-roles message.
  r = setConfigKey(dir, "roles.qqq.model", "x");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /roles\.qqq|unknown role/i);
  assert.equal(fs.readFileSync(file, "utf8"), before, "both failures left the file byte-identical");

  // A type-invalid field value fails with validateConfig's own message.
  r = setConfigKey(dir, "roles.qa.minTickIntervalSeconds", '"fast"');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /minTickIntervalSeconds must be a number of 0 or more/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("parseConfigKey rejects dotted shapes outside the per-role maps and roles entries", () => {
  // A bare key stays top-level; the dotted forms parse; anything else is an error naming
  // the supported dotted shapes.
  assert.deepEqual(parseConfigKey("model"), { kind: "top", key: "model" });
  assert.deepEqual(parseConfigKey("maxDailyCostUsdPerRole.feature"), {
    kind: "map",
    map: "maxDailyCostUsdPerRole",
    role: "feature",
  });
  assert.deepEqual(parseConfigKey("quietHoursPerRole.qa"), { kind: "map", map: "quietHoursPerRole", role: "qa" });
  assert.deepEqual(parseConfigKey("roles.qa.model"), { kind: "role", id: "qa", field: "model" });
  for (const key of ["review.enabled", "roles.qa", "roles.", "maxDailyCostUsdPerRole.", "roles.qa.model.x"]) {
    const parsed = parseConfigKey(key);
    assert.equal(parsed.kind, "error", key);
    if (parsed.kind === "error") assert.match(parsed.error, /dotted keys/);
  }
  // A typo'd head gets the shared did-you-mean; a valid head with a wrong shape does not
  // (the typo there is the shape, so suggesting the head back would mislead).
  const mapTypo = parseConfigKey("maxDailyCostUsdPerRoll.feature");
  assert.equal(mapTypo.kind, "error");
  if (mapTypo.kind === "error") assert.match(mapTypo.error, /— did you mean `maxDailyCostUsdPerRole`\?/);
  const headTypo = parseConfigKey("modle.small");
  assert.equal(headTypo.kind, "error");
  if (headTypo.kind === "error") assert.match(headTypo.error, /— did you mean `model`\?/);
  const wrongShape = parseConfigKey("roles.qa");
  assert.equal(wrongShape.kind, "error");
  if (wrongShape.kind === "error") assert.doesNotMatch(wrongShape.error, /did you mean/);
});

// Model tiers part 8/8 — `model.<tier>` merges one entry of the tier map, the way
// `roles.<id>.<field>` merges one role entry. A string `model` is shorthand for
// `{ default: <string> }`, so the first dotted set promotes it without losing the string.
test("setConfigKey merges model.<tier> into the model map, promoting a string model", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.model = "old-model";
  saveConfig(dir, base);

  let r = setConfigKey(dir, "model.strong", "strong-model");
  assert.ok(r.ok);
  let raw = readJson(path.join(dir, "tumwater.json")) as { model: Record<string, string> };
  assert.deepEqual(raw.model, { default: "old-model", strong: "strong-model" });

  // A second tier merges without re-typing the entries already present.
  r = setConfigKey(dir, "model.small", "small-model");
  assert.ok(r.ok);
  raw = readJson(path.join(dir, "tumwater.json")) as { model: Record<string, string> };
  assert.deepEqual(raw.model, { default: "old-model", strong: "strong-model", small: "small-model" });

  // Re-setting one tier replaces only that entry.
  r = setConfigKey(dir, "model.strong", "strong-2");
  assert.ok(r.ok);
  raw = readJson(path.join(dir, "tumwater.json")) as { model: Record<string, string> };
  assert.deepEqual(raw.model, { default: "old-model", strong: "strong-2", small: "small-model" });
});

test("setConfigKey rejects an unknown tier and a non-string tier model, leaving the file untouched", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  const unknown = setConfigKey(dir, "model.turbo", "x");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /unknown model tier "turbo"/);

  const notString = setConfigKey(dir, "model.strong", '""');
  assert.equal(notString.ok, false);
  if (!notString.ok) assert.match(notString.error, /model\.strong must be a model selector string/);

  assert.equal(fs.readFileSync(file, "utf8"), before, "rejected tier sets change nothing");
});

// The new-form writers emit `model` and `fallback`; the legacy keys stay accepted to FIX an
// existing value but are never introduced into a config that lacks them.
test("setConfigKey never adds legacy provider or fallbackModel to a config that lacks them", () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");

  for (const key of ["provider", "fallbackModel"]) {
    const r = setConfigKey(dir, key, "x");
    assert.equal(r.ok, false, key);
    if (!r.ok) assert.match(r.error, /writer never adds legacy/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before, "a refused legacy add changes nothing");
});

// A broken on-disk config takes the legacy-key closure's load catch: it cannot decide the key
// is "absent", so the refusal comes from writeConfigMutation's own load error rather than the
// misleading "writer never adds legacy" message.
test("setConfigKey reports the load error, not a legacy-add refusal, on a broken config", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "tumwater.json"), "{ still editing");
  for (const key of ["provider", "fallbackModel"]) {
    const r = setConfigKey(dir, key, "x");
    assert.equal(r.ok, false, key);
    if (!r.ok) {
      assert.match(r.error, /not valid JSON/, key);
      assert.doesNotMatch(r.error, /writer never adds legacy/, key);
    }
  }
});

test("setConfigKey updates legacy provider on a config that already has it", () => {
  const dir = tmpdir();
  const base = defaultConfig();
  base.provider = "old-provider";
  saveConfig(dir, base);

  const r = setConfigKey(dir, "provider", "new-provider");
  assert.ok(r.ok);
  const raw = readJson(path.join(dir, "tumwater.json")) as { provider: string };
  assert.equal(raw.provider, "new-provider");
});

// parseConfigKey's new `model.<tier>` shape (the get/set key), separate from the write path.
test("parseConfigKey names model.<tier> and rejects a bogus tier", () => {
  assert.deepEqual(parseConfigKey("model.strong"), { kind: "tier", map: "model", tier: "strong" });
  assert.deepEqual(parseConfigKey("model.default"), { kind: "tier", map: "model", tier: "default" });
  const bad = parseConfigKey("model.turbo");
  assert.equal(bad.kind, "error");
  if (bad.kind === "error") {
    assert.match(bad.error, /unknown model tier "turbo"/);
    assert.doesNotMatch(bad.error, /did you mean/); // no near miss in the tier list
  }
  // A near miss gets the shared did-you-mean hint every sibling unknown-X site appends.
  const typo = parseConfigKey("model.stong");
  assert.equal(typo.kind, "error");
  if (typo.kind === "error") assert.match(typo.error, /did you mean `strong`/);
});

// The cross-process read-modify-write race (BUGS.md 2026-10-07): `tumwater config set` (CLI),
// a standalone dashboard server, and the running fleet are separate processes. Without a lock,
// two writers each load the same snapshot and the later whole-file write drops the earlier one.
// The child holds the config lock while it snapshots, waits to see whether the parent's write
// lands (an unlocked writer's does; a locked one's waits), then writes its own key from the
// snapshot. The fix serializes the parent's read→write, so both keys survive.
test("a concurrent config write cannot drop another process's update", async () => {
  const dir = tmpdir();
  saveConfig(dir, defaultConfig());
  const stateDir = path.join(dir, ".tumwater", "state");
  const lock = path.join(stateDir, "config.lock");
  const ready = path.join(dir, "child-ready");
  const configFile = path.join(dir, "tumwater.json");
  const lockModule = fileURLToPath(new URL("../src/concurrency/lock.js", import.meta.url));
  const child = spawn(process.execPath, [
    "-e",
    `const fs = require("node:fs");
     fs.mkdirSync(${JSON.stringify(stateDir)}, { recursive: true });
     import(${JSON.stringify(lockModule)}).then(({ withSyncLock }) => withSyncLock(${JSON.stringify(lock)}, () => {
       const snapshot = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8"));
       fs.writeFileSync(${JSON.stringify(ready)}, "1");
       const parentSet = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8")).maxDailyCostUsd === 42; } catch { return false; } };
       const deadline = Date.now() + 1500;
       while (Date.now() < deadline && !parentSet()) {
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
       }
       snapshot.quietHours = "22:00-06:00";
       fs.writeFileSync(${JSON.stringify(configFile)}, JSON.stringify(snapshot, null, 2) + "\\n");
     }));`,
  ]);
  child.stderr?.resume();
  const childExit = new Promise((resolve) => child.on("exit", resolve));
  try {
    for (let i = 0; !fs.existsSync(ready); i++) {
      if (i > 500) throw new Error("the holder child never took the config lock");
      await new Promise((r) => setTimeout(r, 10));
    }
    const result = setConfigKey(dir, "maxDailyCostUsd", "42");
    assert.ok(result.ok, result.ok ? "" : result.error);
    await childExit;
    const cfg = readJson(configFile) as { maxDailyCostUsd?: number; quietHours?: string };
    assert.equal(cfg.maxDailyCostUsd, 42, "the parent's update survives");
    assert.equal(cfg.quietHours, "22:00-06:00", "the child's update survives");
  } finally {
    child.kill();
    await childExit;
  }
});
