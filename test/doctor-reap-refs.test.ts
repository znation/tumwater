import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, sh, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { cli } from "./helpers/cli-harness.js";

// The `tumwater doctor` reap flags over git refs (see doctor.test.ts for the split):
// --drop-broken-pins drops the broken refs/tumwater pins and --retire-leftovers the disabled
// roles' leftover branches, each before the report and as its own field under --json.

test("doctor --drop-broken-pins starts the report without a blank line when no pins are broken", async () => {
  const r = await cli(makeRepo(), "doctor", "--drop-broken-pins");
  assert.doesNotMatch(r.stdout, /^\n/);
});

test("doctor --drop-broken-pins drops the row's broken pins before the report", async () => {
  const seed = () => {
    const repo = makeRepo();
    writeFileDeep(path.join(repo, ".git", "refs", "tumwater", "merge", "broken"), `${"2".repeat(40)}\n`);
    return repo;
  };
  const repo = seed();
  const r = await cli(repo, "doctor", "--drop-broken-pins");
  assert.match(r.stdout, /^1 dropped broken pin: refs\/tumwater\/merge\/broken names [0-9a-f]{8}\n\n/);
  assert.equal(fs.existsSync(path.join(repo, ".git", "refs", "tumwater", "merge", "broken")), false, "the broken pin's ref is gone");
  const repoJson = seed();
  const json = await cli(repoJson, "doctor", "--drop-broken-pins", "--json");
  const doc = JSON.parse(json.stdout);
  assert.deepEqual(doc.brokenPinDrop, { dropped: [{ ref: "refs/tumwater/merge/broken", sha: "2".repeat(40) }], failed: [] });
  assert.equal(doc.checks.find((c: { name: string }) => c.name === "tumwater pins").level, "ok");
  // Without the flag the ref and the row stay as the check found them, and no drop is printed.
  const repoPlain = seed();
  const plain = await cli(repoPlain, "doctor");
  assert.doesNotMatch(plain.stdout, /^1 dropped broken pin/);
  assert.equal(fs.existsSync(path.join(repoPlain, ".git", "refs", "tumwater", "merge", "broken")), true);
  const plainJson = JSON.parse((await cli(repoPlain, "doctor", "--json")).stdout);
  assert.equal(plainJson.checks.find((c: { name: string }) => c.name === "tumwater pins").level, "fail");
  assert.ok(!("brokenPinDrop" in plainJson));
});

test("doctor --retire-leftovers retires before the report and --json carries leftoverRetire", async () => {
  const seed = () => {
    const repo = makeRepo();
    writeConfig(repo, { roles: { feature: { enabled: false } } });
    sh(repo, "git", "branch", "tumwater/feature");
    return repo;
  };
  const repo = seed();
  const r = await cli(repo, "doctor", "--retire-leftovers");
  assert.match(r.stdout, /^retired feature: the branch \(tumwater\/feature\)\n\n/);
  assert.equal(sh(repo, "git", "branch").includes("tumwater/feature"), false, "feature's branch is gone");
  const repoJson = seed();
  const json = await cli(repoJson, "doctor", "--retire-leftovers", "--json");
  const doc = JSON.parse(json.stdout);
  assert.deepEqual(doc.leftoverRetire, { retired: [{ role: "feature", removed: ["branch"] }], failed: [] });
  // Without the flag the branch and the row stay as found, and no retire line prints.
  const repoPlain = seed();
  const plain = await cli(repoPlain, "doctor");
  assert.doesNotMatch(plain.stdout, /^retired feature/);
  assert.equal(sh(repoPlain, "git", "branch").includes("tumwater/feature"), true, "the branch stays without the flag");
  const plainJson = JSON.parse((await cli(repoPlain, "doctor", "--json")).stdout);
  assert.equal(plainJson.checks.find((c: { name: string }) => c.name === "leftover role branches").level, "warn");
  assert.ok(!("leftoverRetire" in plainJson));
});
