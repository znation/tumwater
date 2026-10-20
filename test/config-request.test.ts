// Tests for src/config/config-write.ts's director config-request path
// (applyConfigRequest) — the request file the director writes and the run applies.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./helpers/json-read.js";
import { withReadOnlyDir } from "./helpers/fs-faults.js";
import { skipIfRoot, tmpdir } from "./fixtures/repo-fixtures.js";
import { applyConfigRequest } from "../src/config/config-write.js";
import { customLoopNames, defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";
import { configRequestPath } from "../src/paths.js";

// Harness-mediated config writes (plans/portability.md §3/7): the director leaves a request
// file in its worktree; applyConfigRequest validates, applies only customRoles, and deletes
// the request on EVERY path — so custom-role management works with the config tracked,
// gitignored, or absent, and the file never reaches a commit.

function writeRequest(wt: string, value: unknown): void {
  fs.writeFileSync(configRequestPath(wt), typeof value === "string" ? value : JSON.stringify(value));
}

test("applyConfigRequest returns null when no request file exists", () => {
  const root = tmpdir();
  const wt = tmpdir();
  assert.equal(applyConfigRequest(root, wt), null);
});

test("applyConfigRequest applies a customRoles array to the live config and deletes the request", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customRoles: [{ name: "docs", task: "Keep the examples current." }] });
  const result = applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  // The role is live (loadConfig re-reads the file) with defaults otherwise intact.
  assert.deepEqual(customLoopNames(loadConfig(root)), ["docs"]);
  assert.equal(loadConfig(root).maxDailyCostUsd, defaultConfig().maxDailyCostUsd);
  // The request file is gone — it can never be staged by commitAll.
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest still applies a request that says the old customLoops", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customLoops: [{ name: "docs", task: "Keep the examples current." }] });
  const result = applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  assert.deepEqual(customLoopNames(loadConfig(root)), ["docs"]);
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest refuses a request naming both customRoles and customLoops", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  writeRequest(wt, {
    customRoles: [{ name: "docs", task: "a" }],
    customLoops: [{ name: "docs", task: "b" }],
  });
  const result = applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, []);
  assert.match(result?.error ?? "", /customLoops and customRoles are both set/);
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before);
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest keeps one pi spelling when writing the merged config", () => {
  const root = tmpdir();
  const wt = tmpdir();
  const config = defaultConfig();
  config.backends = { pi: { args: ["--new"] } };
  // saveConfig collapses the default piArgs the merged config always carries, so the live file
  // starts with only the new spelling.
  saveConfig(root, config);
  writeRequest(wt, { customRoles: [{ name: "docs", task: "Keep the examples current." }] });
  const result = applyConfigRequest(root, wt);
  assert.equal(result?.error, undefined);
  assert.deepEqual(result?.applied, ["docs"]);
  // The full-file overwrite re-derives the merged config and must not reintroduce the default
  // piArgs beside backends.pi.args — the next load's raw pass rejects a file holding both.
  const raw = readJson(path.join(root, "tumwater.json")) as Record<string, unknown>;
  assert.ok(!("piArgs" in raw), "no piArgs alias was written");
  assert.deepEqual((raw.backends as Record<string, Record<string, unknown>>).pi, { args: ["--new"] });
  assert.doesNotThrow(() => loadConfig(root), "the written file passes the alias rule");
});

test("applyConfigRequest replaces the whole array and strips orphaned roles entries", () => {
  const root = tmpdir();
  const wt = tmpdir();
  const config = defaultConfig();
  config.customRoles = [
    { name: "docs", task: "old task" },
    { name: "scrape", task: "old task" },
  ];
  config.roles.docs = { enabled: false };
  config.roles.scrape = { enabled: false };
  saveConfig(root, config);
  // The replacement array keeps only docs — scrape's roles entry must go with it, or
  // validateConfig would reject the orphaned id and the removal would never apply.
  writeRequest(wt, { customRoles: [{ name: "docs", task: "new task" }] });
  const result = applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  const loaded = loadConfig(root);
  assert.deepEqual(customLoopNames(loaded), ["docs"]);
  assert.equal(loaded.customRoles[0]!.task, "new task");
  assert.equal(loaded.roles.docs?.enabled, false, "a kept role's roles entry survives");
  assert.ok(!("scrape" in loaded.roles), "a removed role's roles entry is stripped");
});

test("applyConfigRequest ignores disallowed keys with their names, and still applies customRoles", () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, {
    customRoles: [{ name: "docs", task: "Keep the examples current." }],
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
  writeRequest(wt, { customRoles: [{ name: "Docs", task: "uppercase name" }] });
  const result = applyConfigRequest(root, wt);
  assert.ok(result?.error, "a validation failure surfaces as an error string");
  assert.match(result.error, /customRoles\[0\]\.name/);
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
  writeRequest(wt, { customRoles: [null] });
  let result = applyConfigRequest(root, wt);
  assert.ok(result?.error?.includes('customRoles[0]'), JSON.stringify(result));
  assert.deepEqual(loadConfig(root), defaultConfig());
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, "not json at all");
  result = applyConfigRequest(root, wt);
  assert.ok(result?.error, "unparseable JSON surfaces as an error string");
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, { customRoles: "everything" });
  result = applyConfigRequest(root, wt);
  assert.ok(result?.error?.includes('must be an array'), JSON.stringify(result));
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, ["an array, not an object"]);
  result = applyConfigRequest(root, wt);
  assert.ok(result?.error?.includes('must be a JSON object'), JSON.stringify(result));
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

// The one failure the delete-on-every-path rule cannot absorb: the unlink itself fails (a
// permissions surprise on the worktree directory — the same shape as a full disk or an
// externally locked file). The application stands (its write already happened), the failure is
// surfaced as the error string (the caller logs it; the file would otherwise survive into
// commitAll's `git add -A` and reach a review gate), and the file is still there for a retry.
// Skipped under root, where chmod cannot stop the unlink (the success path already covers it).
test("a request whose unlink fails is still applied, with the failed deletion surfaced as the error", (t) => {
  if (skipIfRoot(t)) return;
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customRoles: [{ name: "docs", task: "Keep the examples current." }] });
  withReadOnlyDir(wt, () => { // the read succeeds, the unlink cannot
    const result = applyConfigRequest(root, wt);
    assert.ok(result, "a present request file is never read as null");
    assert.deepEqual(result.applied, ["docs"], "the write happened before the failed cleanup");
    assert.deepEqual(customLoopNames(loadConfig(root)), ["docs"], "the role is live");
    assert.match(result.error ?? "", /could not be deleted/);
    assert.ok(fs.existsSync(configRequestPath(wt)), "the undeletable request is still on disk");
  });
});

// The ??= precedence: a request that failed validation AND could not be deleted reports the
// validation problem — the reason the caller acts on — never the cleanup noise.
test("a validation failure outranks a failed deletion in the surfaced error", (t) => {
  if (skipIfRoot(t)) return;
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customRoles: [{ name: "Docs", task: "uppercase name" }] });
  withReadOnlyDir(wt, () => {
    const result = applyConfigRequest(root, wt);
    assert.ok(result);
    assert.deepEqual(result.applied, []);
    assert.match(result.error ?? "", /customRoles\[0\]\.name/);
    assert.doesNotMatch(result.error ?? "", /could not be deleted/);
  });
  assert.ok(fs.existsSync(configRequestPath(wt)), "still undeletable after the failure");
});

// The director's config request (applyConfigRequest) is a whole-config write too: applying it
// must not re-expand the file's partial roles section, while still stripping the roles entry
// of a custom role it removes (BUGS.md 2026-10-11).
test("applyConfigRequest preserves the file's own roles section", () => {
  const root = tmpdir();
  const wt = tmpdir();
  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({ roles: { feature: { enabled: true }, qa: { enabled: false } } }),
  );
  writeRequest(wt, { customRoles: [] });
  const result = applyConfigRequest(root, wt);
  assert.equal(result?.error, undefined);
  assert.deepEqual(
    (readJson(path.join(root, "tumwater.json")) as Record<string, unknown>).roles,
    { feature: { enabled: true }, qa: { enabled: false } },
    "the file's roles section survives a config request",
  );
});

test("applyConfigRequest strips a removed custom role's entry from the file's own roles section", () => {
  const root = tmpdir();
  const wt = tmpdir();
  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({
      customRoles: [
        { name: "docs", task: "old task" },
        { name: "scrape", task: "old task" },
      ],
      roles: { feature: { enabled: true }, docs: { enabled: false }, scrape: { enabled: false } },
    }),
  );
  writeRequest(wt, { customRoles: [{ name: "docs", task: "new task" }] });
  const result = applyConfigRequest(root, wt);
  assert.equal(result?.error, undefined);
  assert.deepEqual(
    (readJson(path.join(root, "tumwater.json")) as Record<string, unknown>).roles,
    { feature: { enabled: true }, docs: { enabled: false } },
    "the kept role's file entry survives and the removed role's is stripped",
  );
});


test("applyConfigRequest leaves tumwater.json byte-identical when the request matches the live customRoles", () => {
  const root = tmpdir();
  const wt = tmpdir();
  fs.writeFileSync(path.join(root, "tumwater.json"), '{"customRoles":[{"name":"docs","task":"t"}]}\n');
  const before = fs.readFileSync(path.join(root, "tumwater.json"));
  writeRequest(wt, { customRoles: [{ name: "docs", task: "t" }], stray: 1 });
  const result = applyConfigRequest(root, wt);
  assert.deepEqual(fs.readFileSync(path.join(root, "tumwater.json")), before);
  assert.equal(result?.unchanged, true);
  assert.deepEqual(result?.applied, []);
  assert.deepEqual(result?.ignored, ["stray"]);
  assert.equal(result?.error, undefined);
  assert.equal(fs.existsSync(configRequestPath(wt)), false);

  writeRequest(wt, { customRoles: [{ name: "docs", task: "changed" }] });
  const changed = applyConfigRequest(root, wt);
  assert.deepEqual(changed?.applied, ["docs"]);
  assert.equal(changed?.unchanged, undefined);
  assert.equal(loadConfig(root).customRoles[0]?.task, "changed");
});
