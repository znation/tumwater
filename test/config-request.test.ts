// Tests for src/config/config-request.ts's config-request path
// (applyConfigRequest) — the request file roles write and the run applies.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./helpers/json-read.js";
import { withReadOnlyDir } from "./helpers/fs-faults.js";
import { skipIfRoot, tmpdir } from "./fixtures/repo-fixtures.js";
import { applyConfigRequest } from "../src/config/config-request.js";
import type { BuildCheckOutcome } from "../src/build/build-check.js";
import type { BuildCheck } from "../src/build/build-check-detect.js";
import { customRoleNames, defaultConfig, loadConfig, saveConfig } from "../src/config/config.js";
import { configRequestPath } from "../src/paths.js";

// Harness-mediated config writes (plans/portability.md §3/7): the director leaves a request
// file in its worktree; applyConfigRequest validates, applies only customRoles and
// check.command, and deletes the request on EVERY path — so custom-role management and check
// declaration work with the config tracked, gitignored, or absent, and the file never reaches
// a commit.

function writeRequest(wt: string, value: unknown): void {
  fs.writeFileSync(configRequestPath(wt), typeof value === "string" ? value : JSON.stringify(value));
}

test("applyConfigRequest returns null when no request file exists", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  assert.equal(await applyConfigRequest(root, wt), null);
});

test("applyConfigRequest applies a customRoles array to the live config and deletes the request", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customRoles: [{ name: "docs", task: "Keep the examples current." }] });
  const result = await applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  // The role is live (loadConfig re-reads the file) with defaults otherwise intact.
  assert.deepEqual(customRoleNames(loadConfig(root)), ["docs"]);
  assert.equal(loadConfig(root).maxDailyCostUsd, defaultConfig().maxDailyCostUsd);
  // The request file is gone — it can never be staged by commitAll.
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest still applies a request that says the old customLoops", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customLoops: [{ name: "docs", task: "Keep the examples current." }] });
  const result = await applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  assert.deepEqual(customRoleNames(loadConfig(root)), ["docs"]);
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest refuses a request naming both customRoles and customLoops", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  writeRequest(wt, {
    customRoles: [{ name: "docs", task: "a" }],
    customLoops: [{ name: "docs", task: "b" }],
  });
  const result = await applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, []);
  assert.match(result?.error ?? "", /customLoops and customRoles are both set/);
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before);
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest keeps one pi spelling when writing the merged config", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  const config = defaultConfig();
  config.backends = { pi: { args: ["--new"] } };
  // saveConfig collapses the default piArgs the merged config always carries, so the live file
  // starts with only the new spelling.
  saveConfig(root, config);
  writeRequest(wt, { customRoles: [{ name: "docs", task: "Keep the examples current." }] });
  const result = await applyConfigRequest(root, wt);
  assert.equal(result?.error, undefined);
  assert.deepEqual(result?.applied, ["docs"]);
  // The full-file overwrite re-derives the merged config and must not reintroduce the default
  // piArgs beside backends.pi.args — the next load's raw pass rejects a file holding both.
  const raw = readJson(path.join(root, "tumwater.json")) as Record<string, unknown>;
  assert.ok(!("piArgs" in raw), "no piArgs alias was written");
  assert.deepEqual((raw.backends as Record<string, Record<string, unknown>>).pi, { args: ["--new"] });
  assert.doesNotThrow(() => loadConfig(root), "the written file passes the alias rule");
});

test("applyConfigRequest replaces the whole array and strips orphaned roles entries", async () => {
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
  const result = await applyConfigRequest(root, wt);
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, []);
  assert.equal(result?.error, undefined);
  const loaded = loadConfig(root);
  assert.deepEqual(customRoleNames(loaded), ["docs"]);
  assert.equal(loaded.customRoles[0]!.task, "new task");
  assert.equal(loaded.roles.docs?.enabled, false, "a kept role's roles entry survives");
  assert.ok(!("scrape" in loaded.roles), "a removed role's roles entry is stripped");
});

test("applyConfigRequest ignores disallowed keys with their names, and still applies customRoles", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, {
    customRoles: [{ name: "docs", task: "Keep the examples current." }],
    maxDailyCostUsd: 1,
    roles: { director: { enabled: false } },
  });
  const result = await applyConfigRequest(root, wt);
  // applied names ride with ignored so the caller can warn without losing the good half.
  assert.deepEqual(result?.applied, ["docs"]);
  assert.deepEqual(result?.ignored, ["maxDailyCostUsd", "roles"]);
  assert.equal(result?.error, undefined);
  const loaded = loadConfig(root);
  assert.deepEqual(customRoleNames(loaded), ["docs"]);
  // The ignored keys changed nothing: the permitted-key filter drops them before the merge.
  assert.equal(loaded.maxDailyCostUsd, defaultConfig().maxDailyCostUsd);
  assert.equal(loaded.roles.director?.enabled, true);
});

test("applyConfigRequest rejects an invalid candidate: nothing written, previous config live, request deleted", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customRoles: [{ name: "Docs", task: "uppercase name" }] });
  const result = await applyConfigRequest(root, wt);
  assert.ok(result?.error, "a validation failure surfaces as an error string");
  assert.match(result.error, /customRoles\[0\]\.name/);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(loadConfig(root), defaultConfig());
  // Deleted anyway — a malformed request must not retry forever.
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

test("applyConfigRequest survives structurally malformed requests without throwing", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  // Regression: a null entry must reach validateConfig as a named problem, never crash on a
  // premature `.name` dereference.
  writeRequest(wt, { customRoles: [null] });
  let result = await applyConfigRequest(root, wt);
  assert.ok(result?.error?.includes('customRoles[0]'), JSON.stringify(result));
  assert.deepEqual(loadConfig(root), defaultConfig());
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, "not json at all");
  result = await applyConfigRequest(root, wt);
  assert.ok(result?.error, "unparseable JSON surfaces as an error string");
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, { customRoles: "everything" });
  result = await applyConfigRequest(root, wt);
  assert.ok(result?.error?.includes('must be an array'), JSON.stringify(result));
  assert.ok(!fs.existsSync(configRequestPath(wt)));

  writeRequest(wt, ["an array, not an object"]);
  result = await applyConfigRequest(root, wt);
  assert.ok(result?.error?.includes('must be a JSON object'), JSON.stringify(result));
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});

// The one failure the delete-on-every-path rule cannot absorb: the unlink itself fails (a
// permissions surprise on the worktree directory — the same shape as a full disk or an
// externally locked file). The application stands (its write already happened), the failure is
// surfaced as the error string (the caller logs it; the file would otherwise survive into
// commitAll's `git add -A` and reach a review gate), and the file is still there for a retry.
// Skipped under root, where chmod cannot stop the unlink (the success path already covers it).
test("a request whose unlink fails is still applied, with the failed deletion surfaced as the error", async (t) => {
  if (skipIfRoot(t)) return;
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customRoles: [{ name: "docs", task: "Keep the examples current." }] });
  await withReadOnlyDir(wt, async () => { // the read succeeds, the unlink cannot
    const result = await applyConfigRequest(root, wt);
    assert.ok(result, "a present request file is never read as null");
    assert.deepEqual(result.applied, ["docs"], "the write happened before the failed cleanup");
    assert.deepEqual(customRoleNames(loadConfig(root)), ["docs"], "the role is live");
    assert.match(result.error ?? "", /could not be deleted/);
    assert.ok(fs.existsSync(configRequestPath(wt)), "the undeletable request is still on disk");
  });
});

// The ??= precedence: a request that failed validation AND could not be deleted reports the
// validation problem — the reason the caller acts on — never the cleanup noise.
test("a validation failure outranks a failed deletion in the surfaced error", async (t) => {
  if (skipIfRoot(t)) return;
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  writeRequest(wt, { customRoles: [{ name: "Docs", task: "uppercase name" }] });
  await withReadOnlyDir(wt, async () => {
    const result = await applyConfigRequest(root, wt);
    assert.ok(result);
    assert.deepEqual(result.applied, []);
    assert.match(result.error ?? "", /customRoles\[0\]\.name/);
    assert.doesNotMatch(result.error ?? "", /could not be deleted/);
  });
  assert.ok(fs.existsSync(configRequestPath(wt)), "still undeletable after the failure");
});

// The config request (applyConfigRequest) is a whole-config write too: applying it
// must not re-expand the file's partial roles section, while still stripping the roles entry
// of a custom role it removes (BUGS.md 2026-10-11).
test("applyConfigRequest preserves the file's own roles section", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({ roles: { feature: { enabled: true }, qa: { enabled: false } } }),
  );
  writeRequest(wt, { customRoles: [] });
  const result = await applyConfigRequest(root, wt);
  assert.equal(result?.error, undefined);
  assert.deepEqual(
    (readJson(path.join(root, "tumwater.json")) as Record<string, unknown>).roles,
    { feature: { enabled: true }, qa: { enabled: false } },
    "the file's roles section survives a config request",
  );
});

test("applyConfigRequest strips a removed custom role's entry from the file's own roles section", async () => {
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
  const result = await applyConfigRequest(root, wt);
  assert.equal(result?.error, undefined);
  assert.deepEqual(
    (readJson(path.join(root, "tumwater.json")) as Record<string, unknown>).roles,
    { feature: { enabled: true }, docs: { enabled: false } },
    "the kept role's file entry survives and the removed role's is stripped",
  );
});


test("applyConfigRequest leaves tumwater.json byte-identical when the request matches the live customRoles", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  fs.writeFileSync(path.join(root, "tumwater.json"), '{"customRoles":[{"name":"docs","task":"t"}]}\n');
  const before = fs.readFileSync(path.join(root, "tumwater.json"));
  writeRequest(wt, { customRoles: [{ name: "docs", task: "t" }], stray: 1 });
  const result = await applyConfigRequest(root, wt);
  assert.deepEqual(fs.readFileSync(path.join(root, "tumwater.json")), before);
  assert.equal(result?.unchanged, true);
  assert.deepEqual(result?.applied, []);
  assert.deepEqual(result?.ignored, ["stray"]);
  assert.equal(result?.error, undefined);
  assert.equal(fs.existsSync(configRequestPath(wt)), false);

  writeRequest(wt, { customRoles: [{ name: "docs", task: "changed" }] });
  const changed = await applyConfigRequest(root, wt);
  assert.deepEqual(changed?.applied, ["docs"]);
  assert.equal(changed?.unchanged, undefined);
  assert.equal(loadConfig(root).customRoles[0]?.task, "changed");
});

// ── check.command declaration (part 1/2) ────────────────────────────────────────────────────
// A role may declare the project's check through the request, but the harness verifies it
// green in the worktree before writing: a command that could never pass would park the whole
// queue behind a red main, so the role's own claim is not the evidence. Tests inject a fake
// check runner so the pass/fail branches are deterministic (no spawned process).

test("a check request declares check.command once the guard observes it green", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  const config = defaultConfig();
  config.check = { command: "npm run build", gateCommand: "npm run fast" };
  saveConfig(root, config);
  writeRequest(wt, { check: { command: "npm run lint" } });
  const green: (wt: string, c: BuildCheck) => Promise<BuildCheckOutcome> = async (_w, _c) => ({
    status: "passed",
    script: "npm run lint",
  });
  const result = await applyConfigRequest(root, wt, green);
  assert.equal(result?.error, undefined);
  assert.deepEqual(result?.ignored, []);
  assert.deepEqual(result?.applied, []);
  const loaded = loadConfig(root);
  assert.equal(loaded.check?.command, "npm run lint", "the declared command lands");
  assert.equal(loaded.check?.gateCommand, "npm run fast", "a hand-set gateCommand survives");
  assert.equal(loaded.maxDailyCostUsd, defaultConfig().maxDailyCostUsd, "nothing else changed");
  assert.ok(!fs.existsSync(configRequestPath(wt)), "the request file is gone");
});

test("the guard resolves check.cwd against the worktree like the gate's pre-check", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  const config = defaultConfig();
  config.check = { command: "npm run build", cwd: "sub" };
  saveConfig(root, config);
  writeRequest(wt, { check: { command: "npm run lint" } });
  let seenCwd: string | undefined;
  const record: (wt: string, c: BuildCheck) => Promise<BuildCheckOutcome> = async (_w, c) => {
    seenCwd = c.kind === "command" ? c.cwd : undefined;
    return { status: "passed", script: "npm run lint" };
  };
  const result = await applyConfigRequest(root, wt, record);
  assert.equal(result?.error, undefined);
  // detectBuildCheck resolves a command check's cwd as path.resolve(startDir, check.cwd ?? "."),
  // so a preserved check.cwd must be honored or the guard runs in the wrong tree (a false green
  // or false red against the gate) — the gate pre-check is runScopedBuildCheck on this same wt.
  assert.equal(seenCwd, path.resolve(wt, "sub"), "the gate's check.cwd resolution is honored");
  assert.equal(loadConfig(root).check?.command, "npm run lint", "the declared command still lands");
});

test("with check.gateCommand set, the guard verifies the declared command and the gate command", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  const config = defaultConfig();
  config.check = { command: "npm run build", gateCommand: "npm run fast" };
  saveConfig(root, config);
  writeRequest(wt, { check: { command: "npm run lint" } });
  const seen: string[] = [];
  const record: (wt: string, c: BuildCheck) => Promise<BuildCheckOutcome> = async (_w, c) => {
    if (c.kind === "command") seen.push(c.command);
    return { status: "passed", script: c.kind === "command" ? c.command : "" };
  };
  const result = await applyConfigRequest(root, wt, record);
  assert.equal(result?.error, undefined);
  // The write lands the declared command, but the guard must observe BOTH the declared command
  // (the fail-closed guarantee — a request whose own command fails writes nothing) and the gate
  // command the gate scope will keep running (runScopedBuildCheck swaps in check.gateCommand at
  // scope "gate") green before writing — verifying only one would read green on a command the
  // other never runs.
  assert.deepEqual(seen, ["npm run fast", "npm run lint"], "both the gate and declared commands are verified");
  assert.equal(loadConfig(root).check?.command, "npm run lint", "the declared command still lands");
  assert.equal(loadConfig(root).check?.gateCommand, "npm run fast", "the gate command is preserved");
});

test("an invalid request is rejected before the declared check ever runs", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  // A request that pairs a valid check.command with an invalid customRoles entry must be
  // rejected for the roles problem WITHOUT spawning the check — running it would be a wasted
  // subprocess for a write that can never land (the check is only a gate on a valid write).
  writeRequest(wt, { check: { command: "npm run lint" }, customRoles: [{ name: "Docs" }] });
  let checkRan = false;
  const spy: (wt: string, c: BuildCheck) => Promise<BuildCheckOutcome> = async (_w, _c) => {
    checkRan = true;
    return { status: "passed", script: "npm run lint" };
  };
  const result = await applyConfigRequest(root, wt, spy);
  assert.deepEqual(result?.applied, []);
  assert.match(result?.error ?? "", /customRoles/);
  assert.equal(checkRan, false, "the declared check is not run for an invalid request");
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before, "config is unchanged");
  assert.ok(!fs.existsSync(configRequestPath(wt)), "the rejected request is still deleted");
});

test("a check request whose command fails writes nothing", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  writeRequest(wt, { check: { command: "npm run lint" } });
  const failing: (wt: string, c: BuildCheck) => Promise<BuildCheckOutcome> = async (_w, _c) => ({
    status: "failed",
    script: "npm run lint",
    outputTail: ["lint error"],
  });
  const result = await applyConfigRequest(root, wt, failing);
  assert.deepEqual(result?.applied, []);
  assert.match(result?.error ?? "", /check\.command not declared: `npm run lint` failed in the worktree/);
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before, "config is unchanged");
  assert.ok(!fs.existsSync(configRequestPath(wt)), "the rejected request is still deleted");
});

test("a check request naming another check sub-key is ignored with a warning", async () => {
  const root = tmpdir();
  const wt = tmpdir();
  saveConfig(root, defaultConfig());
  const before = fs.readFileSync(path.join(root, "tumwater.json"), "utf8");
  // No valid command means nothing is declared; the sub-keys are dropped and named, so the
  // caller's warning tells the role exactly what it cannot set — a role can declare a check
  // but never turn the gates off.
  writeRequest(wt, { check: { gateCommand: "npm run fast", timeoutSeconds: 5, command: "" } });
  const result = await applyConfigRequest(root, wt);
  assert.deepEqual(result?.ignored, ["check.gateCommand", "check.timeoutSeconds", "check.command"]);
  assert.equal(result?.error, undefined);
  assert.equal(result?.unchanged, true, "nothing was declared or changed");
  assert.equal(fs.readFileSync(path.join(root, "tumwater.json"), "utf8"), before);
  assert.ok(!fs.existsSync(configRequestPath(wt)));
});
