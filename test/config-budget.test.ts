// Tests for src/config/config-write.ts's budget setter (setDailyBudgetUsd),
// the shared setter behind the TUI's Ctrl+B editor and the GUI's /api/budget endpoint.
// The key-editing engine lives in test/config-write.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./helpers/json-read.js";
import { withReadOnlyDir } from "./helpers/fs-faults.js";
import { skipIfRoot, tmpdir } from "./fixtures/repo-fixtures.js";
import { setDailyBudgetUsd } from "../src/config/config-write.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";

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

test("setDailyBudgetUsd leaves tumwater.json byte-identical when the cap is already that value", () => {
  const dir = tmpdir();
  const file = path.join(dir, "tumwater.json");
  saveConfig(dir, defaultConfig());
  assert.deepEqual(setDailyBudgetUsd(dir, 25), { ok: true });
  const bytes = fs.readFileSync(file);
  assert.deepEqual(setDailyBudgetUsd(dir, 25), { ok: true, unchanged: true });
  assert.deepEqual(fs.readFileSync(file), bytes);

  // A hand-written file omitting the key resolves to the default, so saving it is unchanged.
  const minimal = tmpdir();
  const minimalFile = path.join(minimal, "tumwater.json");
  fs.writeFileSync(minimalFile, "{}\n");
  assert.deepEqual(setDailyBudgetUsd(minimal, 50), { ok: true, unchanged: true });
  assert.equal(fs.readFileSync(minimalFile, "utf8"), "{}\n");
});

// The write-side failure path: when the config directory cannot take a new file (disk full,
// permissions), the error surfaces as a string instead of throwing, the old file is left
// byte-for-byte intact, and the atomic writer's tmp file does not linger. Skipped under root,
// where chmod cannot stop the write (the success path already covers the ordinary case).
test("setDailyBudgetUsd reports a failed write and leaves the config untouched", (t) => {
  if (skipIfRoot(t)) return;
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxDailyCostUsd = 7;
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");
  withReadOnlyDir(dir, () => { // not writable — the tmp write fails
    const r = setDailyBudgetUsd(dir, 25);
    assert.equal(r.ok, false, "a failed write is surfaced, never thrown");
    if (!r.ok) assert.ok(r.error.length > 0, "a non-empty error string for the UI to flash");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the old config is untouched");
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith("tumwater.json.tmp-")),
      [],
      "the failed write leaves no tmp remnant",
    );
  });
});

// The writeJsonAtomic arm specifically: the lock (under .tumwater/state) must still be
// acquirable while the repo root is not writable, so the failure lands in writeConfigMutation's
// atomic-write catch rather than the outer lock catch. Pre-creating the state dir makes the two
// separable — chmod on the root does not change the state dir's own permissions.
test("setDailyBudgetUsd surfaces an atomic-write failure after the lock is taken", (t) => {
  if (skipIfRoot(t)) return;
  const dir = tmpdir();
  const base = defaultConfig();
  base.maxDailyCostUsd = 7;
  saveConfig(dir, base);
  const file = path.join(dir, "tumwater.json");
  const before = fs.readFileSync(file, "utf8");
  fs.mkdirSync(path.join(dir, ".tumwater", "state"), { recursive: true });
  withReadOnlyDir(dir, () => { // root read-only; .tumwater/state stays writable, so the lock succeeds
    const r = setDailyBudgetUsd(dir, 25);
    assert.equal(r.ok, false, "the failed atomic write is surfaced, never thrown");
    if (!r.ok) assert.ok(r.error.length > 0, "a non-empty error string for the UI to flash");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the old config is untouched");
  });
});

