import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyConfigRequest, setDailyBudgetUsd } from "../src/config-write.js";
import { customLoopNames, defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import { configRequestPath } from "../src/paths.js";
import { tmpdir } from "./util.js";

// Tests for src/config-write.ts — the harness-mediated write paths split out of src/config.ts
// (the budget setter behind both dashboards, and the director's config request file). Tests for
// src/config.ts itself and for src/config-validation.ts live in test/config.test.ts.

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

// The write-side failure path: when the config directory cannot take a new file (disk full,
// permissions), the error surfaces as a string instead of throwing, the old file is left
// byte-for-byte intact, and the atomic writer's tmp file does not linger. Skipped under root,
// where chmod cannot stop the write (the success path already covers the ordinary case).
test("setDailyBudgetUsd reports a failed write and leaves the config untouched", (t) => {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (asRoot) {
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
