/** src/roles/loop-ids.ts — the loop-id/base-role arithmetic of parallel work instances
 * (plans/parallel-work-instances.md, part 1/7) — plus the base-role normalization it drives in
 * roles.ts, config-views.ts, role-cap-gates.ts and config-validation.ts. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  INSTANCE_ROLES,
  baseRoleOf,
  instanceIndex,
  loopEnabled,
} from "../src/roles/loop-ids.js";
import { baselineBlocked, roleById, roleTier, yieldScaledRole } from "../src/roles/roles.js";
import { configForRole } from "../src/config/config-views.js";
import { defaultConfig } from "../src/config/config.js";
import { validateConfig } from "../src/config/config-validation.js";
import { errorMessage } from "../src/text/text.js";
import { freshLoopState } from "../src/loop/loop-state.js";
import { dailyCost, recordDailyCost } from "../src/budget/budget.js";
import { newRoleCapGateState, pollRoleCapGate } from "../src/gates/role-cap-gates.js";
import { readEvents } from "../src/events/event-read.js";
import { commitTrailer, stampedSubject } from "../src/git/commit-message.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

test("baseRoleOf and instanceIndex map only a base role's -N ids", () => {
  assert.ok(INSTANCE_ROLES.has("feature") && INSTANCE_ROLES.has("bugfix"));
  assert.ok(!INSTANCE_ROLES.has("clean"));

  assert.equal(baseRoleOf("feature-2"), "feature");
  assert.equal(baseRoleOf("bugfix-10"), "bugfix");
  // The bare id is instance 1; -1 is not a second instance, and other roles never split.
  assert.equal(baseRoleOf("feature"), "feature");
  assert.equal(baseRoleOf("feature-1"), "feature-1");
  assert.equal(baseRoleOf("clean-2"), "clean-2");
  assert.equal(baseRoleOf("my-loop"), "my-loop");

  assert.equal(instanceIndex("feature"), 1);
  assert.equal(instanceIndex("feature-1"), 1);
  assert.equal(instanceIndex("feature-2"), 2);
  assert.equal(instanceIndex("bugfix-10"), 10);
  assert.equal(instanceIndex("clean-2"), 1);
});

test("loopEnabled reads the base role and holds extra instances off until part 5/7", () => {
  const config = defaultConfig();
  assert.equal(loopEnabled(config, "feature"), true, "a bare enabled role runs");
  assert.equal(loopEnabled(config, "feature-2"), false, "no instances configured means index > 1 is off");
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), enabled: false };
  assert.equal(loopEnabled(config, "feature"), false);
  assert.equal(loopEnabled(config, "feature-2"), false, "a disabled base role disables its instances");
  assert.equal(loopEnabled(config, "my-loop"), false, "an unknown id has no enabled base entry");
});

test("role helpers resolve an instance id through its base role", () => {
  assert.equal(roleById("feature-2")?.id, "feature");
  assert.equal(roleById("my-loop"), undefined);

  assert.equal(roleTier("feature-2"), 0, "a feature instance sorts in the work tier");
  assert.equal(roleTier("clean-2"), 1, "an untouched id keeps its own tier");
  assert.equal(yieldScaledRole("feature-2"), false, "feature never yield-scales");
  assert.equal(yieldScaledRole("bugfix-2"), true, "bugfix wears the search clock on any instance");
  assert.equal(baselineBlocked("feature-2"), true, "a feature instance is blocked on red main");
  assert.equal(baselineBlocked("bugfix-2"), false, "the healer is never blocked");
});

test("configForRole resolves an instance id's model through its base role", () => {
  const config = defaultConfig();
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), model: "strong" };
  assert.deepEqual(configForRole(config, "feature-2"), configForRole(config, "feature"));
});

test("a custom loop name shaped like an instance id is a validation error", () => {
  assert.throws(
    () => validateConfig({ customLoops: [{ name: "feature-2", task: "do a thing" }] }),
    (err: unknown) => /would shadow the feature loop's instance ids/.test(errorMessage(err)),
  );
  assert.doesNotThrow(() => validateConfig({ customLoops: [{ name: "my-loop", task: "do a thing" }] }));
});

test("a commit stamps the base role and still trailers the loop id", () => {
  assert.equal(stampedSubject(baseRoleOf("feature-2"), "land it"), "tumwater(feature): land it");
  assert.match(commitTrailer("feature-2", 1, 3, 1000), /^Tick: feature-2 #1/);
});

test("the per-role cap groups instances: their spend sums against the base role's cap", () => {
  const root = tmpdir("loop-ids-cap-");
  const a = freshLoopState("feature");
  const b = freshLoopState("feature-2");
  recordDailyCost(a, 0.6);
  recordDailyCost(b, 0.6);
  assert.ok(dailyCost(a) > 0.5 && dailyCost(b) > 0.5);

  const paused = pollRoleCapGate(
    root,
    newRoleCapGateState(),
    [
      { role: "feature", state: a },
      { role: "feature-2", state: b },
    ],
    { feature: 1 },
    Date.now(),
  );
  assert.deepEqual([...paused].sort(), ["feature", "feature-2"], "both instances pause");
  const events = readEvents(root, 100).filter((e) => e.type === "role_cap_paused");
  assert.equal(events.length, 1, "one crossing event for the group");
  assert.equal(events[0]!.role, "feature", "the event names the base role");
  assert.ok(Math.abs(Number(events[0]!.spentUsd) - 1.2) < 1e-9, "the summed spend rides the event");
});
