// The `tumwater role` writes that decide which roles run and how many (see
// cli-operators.test.ts for the split): --enable/--disable, --instances and
// --review-after-merge, each set and cleared in tumwater.json.

import test from "node:test";
import { readJson } from "./helpers/json-read.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import type { TeamConfigFile } from "./fixtures/config-fixtures.js";

test("role --instances/--clear-instances write the role's parallel-runner count", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role instances");
  const config = () => readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));

  // `--instances <n>` writes roles.feature.instances through the config core.
  let r = await cli(repo, "role", "feature", "--instances", "3");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances set to 3/);
  assert.equal(config().roles.feature.instances, 3);

  // An instance id targets its base role: feature-2 writes the .feature key.
  r = await cli(repo, "role", "feature-2", "--instances", "3");
  assert.equal(r.code, 0);
  assert.equal(config().roles.feature.instances, 3);

  // The write is visible: `tumwater role feature` and feature-2 render an Instances line.
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /- Instances: 3/);
  r = await cli(repo, "role", "feature-2");
  assert.match(r.stdout, /- Instances: 3/);
  r = await cli(repo, "role", "feature-2", "--json");
  assert.match(r.stdout, /"instances": 3/);

  // A clear removes the key; `--instances ""` clears it too, and a clear writes nothing when
  // the key is already unset.
  r = await cli(repo, "role", "feature", "--clear-instances");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances cleared/);
  assert.equal(config().roles.feature.instances, undefined);
  const bytesAfterClear = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "feature", "--clear-instances");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances is not set in tumwater.json, so nothing was cleared/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterClear, "clearing an unset key writes nothing");
  // An absent count resolves to 1, so asking for 1 is a no-op that writes nothing.
  r = await cli(repo, "role", "feature", "--instances", "1");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances is already 1, so tumwater.json was not written/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterClear, "instances 1 on an unset key writes nothing");
  // A role that may not split still gets validateConfig's refusal, not the no-op shortcut.
  r = await cli(repo, "role", "director", "--instances", "1");
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterClear, "a refused write leaves the file alone");
  r = await cli(repo, "role", "feature", "--instances", "2");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances set to 2/);
  r = await cli(repo, "role", "feature", "--instances", "2");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances is already 2, so tumwater.json was not written/);
  // An exponent spelling like "2e0" is itself a JSON number (2), so it would silently write 2
  // past plainDecimalToJson and validateConfig's INSTANCE_COUNT integer check alike — the same
  // silent misread the cap and min-run-interval writes refuse, so this refuses it too, naming
  // the key and leaving the file unchanged.
  const bytesAfterTwo = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const bad of ["2e0", "3e0"]) {
    r = await cli(repo, "role", "feature", "--instances", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /roles\.feature\.instances/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), bytesAfterTwo, `file unchanged on ${bad}`);
  }
  r = await cli(repo, "role", "feature", "--instances", "");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: instances cleared/);
  assert.equal(config().roles.feature.instances, undefined);

  // A tumwater.json that fails to load is no basis for "already 1": the write fails instead.
  const goodJson = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  fs.writeFileSync(path.join(repo, "tumwater.json"), "{ not json");
  r = await cli(repo, "role", "feature", "--instances", "1");
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.stdout, /already/);
  fs.writeFileSync(path.join(repo, "tumwater.json"), goodJson);

  // A malformed count fails with validateConfig's message naming the key, leaving the file
  // unchanged.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const bad of ["0", "9", "1.5", "abc"]) {
    r = await cli(repo, "role", "feature", "--instances", bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /roles\.feature\.instances/);
    assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, `file unchanged on ${bad}`);
  }
  // Only feature and bugfix may split: the director and every other role are refused.
  r = await cli(repo, "role", "steward", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only valid for feature and bugfix/);
  r = await cli(repo, "role", "director", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only valid for feature and bugfix/);
  // An unknown id is refused, writing nothing.
  r = await cli(repo, "role", "bogus", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);

  // Mutually exclusive or inapplicable flags are refused and write nothing.
  r = await cli(repo, "role", "feature", "--clear-instances", "--instances", "2");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --clear-instances or --instances, not both/);
  r = await cli(repo, "role", "feature", "--instances", "2", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to an instances write/);
  r = await cli(repo, "role", "feature", "--clear-instances", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to an instances write/);
  r = await cli(repo, "role", "feature", "--instances", "2", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /instances and cap writes cannot share one invocation/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "no write from the refused invocations");
});

test("role --enable and --disable write the role's enabled state", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role enable disable");
  const config = () => readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));

  // A role already in the asked-for state is reported and the file is not written.
  const file = path.join(repo, "tumwater.json");
  const fresh = fs.readFileSync(file, "utf8");
  let r = await cli(repo, "role", "feature", "--enable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: already enabled/);
  r = await cli(repo, "role", "selfcheck", "--disable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /selfcheck: already disabled/);
  assert.equal(fs.readFileSync(file, "utf8"), fresh, "no write for a no-op");

  // `--disable` writes roles.feature.enabled === false and the view renders it disabled.
  r = await cli(repo, "role", "feature", "--disable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: disabled/);
  assert.equal(config().roles.feature.enabled, false);
  const disabled = fs.readFileSync(file, "utf8");
  r = await cli(repo, "role", "feature", "--disable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: already disabled/);
  assert.equal(fs.readFileSync(file, "utf8"), disabled, "no write for a repeated disable");
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /- State: disabled, not paused/);
  r = await cli(repo, "role", "feature", "--json");
  assert.match(r.stdout, /"enabled": false/);

  // `--enable` restores it; a disabled role's base id still resolves and enables.
  r = await cli(repo, "role", "feature", "--enable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: enabled/);
  assert.equal(config().roles.feature.enabled, true);

  // An instance id targets its base role: feature-2 disables feature.
  const configured = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  configured.roles = { ...configured.roles, feature: { ...configured.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(configured, null, 2));
  r = await cli(repo, "role", "feature-2", "--disable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: disabled/);
  assert.equal(config().roles.feature.enabled, false);

  // The director cannot be disabled, and an unknown id is refused for both flags.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "director", "--disable");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the director cannot be disabled/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "file unchanged on director disable");
  r = await cli(repo, "role", "director", "--enable");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /director: already enabled/);
  assert.equal(config().roles.director.enabled, true);
  const beforeBogus = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  for (const flag of ["--enable", "--disable"]) {
    r = await cli(repo, "role", "bogus", flag);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown role: bogus/);
  }
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), beforeBogus, "file unchanged on unknown id");

  // --enable --disable and combining either with another role write are refused, name the kinds.
  r = await cli(repo, "role", "feature", "--enable", "--disable");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /enable and disable writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--disable", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to an enable\/disable write/);
  r = await cli(repo, "role", "feature", "--disable", "--clear-notes");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notes and disable writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--disable", "--clear-quiet-hours");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /quiet-hours and disable writes cannot share one invocation/);
  r = await cli(repo, "role", "feature", "--enable", "--instructions-file", "y");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /instructions and enable writes cannot share one invocation/);
});

test("role --review-after-merge and --clear-review-after-merge move the role in review.afterMerge", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli role review-after-merge");
  const config = () => readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));

  // feature is not in the default list, so clearing it (and adding clean, already in the
  // list) are the no-ops that must leave the fresh bytes unchanged.
  const file = path.join(repo, "tumwater.json");
  const fresh = fs.readFileSync(file, "utf8");
  let r = await cli(repo, "role", "feature", "--clear-review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: not in review\.afterMerge, so nothing was cleared/);
  r = await cli(repo, "role", "clean", "--review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /clean: already in review\.afterMerge, so tumwater\.json was not written/);
  assert.equal(fs.readFileSync(file, "utf8"), fresh, "no write for a no-op");

  // --review-after-merge adds feature to review.afterMerge and the view reflects it.
  r = await cli(repo, "role", "feature", "--review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: added to review\.afterMerge/);
  assert.ok(config().review?.afterMerge?.includes("feature"));
  const added = fs.readFileSync(file, "utf8");
  r = await cli(repo, "role", "feature");
  assert.match(r.stdout, /- Review: after merge/);
  r = await cli(repo, "role", "feature", "--json");
  assert.match(r.stdout, /"reviewedAfterMerge": true/);
  r = await cli(repo, "role", "feature", "--review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: already in review\.afterMerge, so tumwater\.json was not written/);
  assert.equal(fs.readFileSync(file, "utf8"), added, "no write for a repeat");

  // --clear-review-after-merge removes feature, and clean's removal leaves the others in order.
  r = await cli(repo, "role", "feature", "--clear-review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: removed from review\.afterMerge/);
  assert.ok(!config().review?.afterMerge?.includes("feature"));
  r = await cli(repo, "role", "clean", "--clear-review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /clean: removed from review\.afterMerge/);
  assert.ok(!config().review?.afterMerge?.includes("clean"));
  assert.ok(config().review?.afterMerge?.includes("bugfix"));

  // An instance id targets its base: feature-2 writes feature (once feature may split).
  const withInstances = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  withInstances.roles = { ...withInstances.roles, feature: { ...withInstances.roles.feature, instances: 2 } };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(withInstances, null, 2));
  r = await cli(repo, "role", "feature-2", "--review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /feature: added to review\.afterMerge/);
  assert.ok(config().review?.afterMerge?.includes("feature"));

  // A review section that already customizes another field keeps it through an add.
  const seeded = readJson<TeamConfigFile>(path.join(repo, "tumwater.json"));
  seeded.review = { ...(seeded.review ?? {}), enabled: false };
  fs.writeFileSync(path.join(repo, "tumwater.json"), JSON.stringify(seeded, null, 2));
  r = await cli(repo, "role", "clean", "--review-after-merge");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /clean: added to review\.afterMerge/);
  const cfg = config();
  assert.equal(cfg.review?.enabled, false, "an unrelated review field survives an add");
  assert.ok(cfg.review?.afterMerge?.includes("clean"));

  // Refusals: the director, both flags together, --json and --cap with a review-after-merge write.
  const before = fs.readFileSync(path.join(repo, "tumwater.json"), "utf8");
  r = await cli(repo, "role", "director", "--review-after-merge");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /review\.afterMerge\.*/);
  r = await cli(repo, "role", "feature", "--review-after-merge", "--clear-review-after-merge");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /give --review-after-merge or --clear-review-after-merge, not both/);
  r = await cli(repo, "role", "feature", "--review-after-merge", "--json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--json does not apply to a review-after-merge write/);
  r = await cli(repo, "role", "feature", "--review-after-merge", "--cap", "5");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cap and review-after-merge writes cannot share one invocation/);
  r = await cli(repo, "role", "bogus", "--review-after-merge");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown role: bogus/);
  assert.equal(fs.readFileSync(path.join(repo, "tumwater.json"), "utf8"), before, "file unchanged on every refusal");
});
