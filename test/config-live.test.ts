import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { defaultConfig } from "../src/config.js";
import { newLiveConfigReload } from "../src/config-live.js";
import { readEvents } from "../src/events.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import { Semaphore } from "../src/semaphore.js";
import { eventsOfType } from "./log-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { makeRepo, writeConfig } from "./repo-fixtures.js";

function cloneConfig(c: TumwaterConfig): TumwaterConfig {
  return JSON.parse(JSON.stringify(c)) as TumwaterConfig;
}

function warnMessages(root: string): string[] {
  return readEvents(root)
    .filter((e) => e.type === "warning" && e.loop === "harness")
    .map((e) => (e as unknown as { message: string }).message);
}

function changedKeys(root: string): string[][] {
  return readEvents(root)
    .filter((e) => e.type === "config_changed")
    .map((e) => (e as unknown as { keys: string[] }).keys);
}

function newReload(
  root: string,
  config: TumwaterConfig,
  runners: ReturnType<typeof makeLoopRunner>[],
  sem: Semaphore,
  roleFilter?: string,
) {
  return newLiveConfigReload({
    root,
    config,
    mainBranch: "main",
    signal: new AbortController().signal,
    runners,
    semaphore: sem,
    roleFilter,
  });
}

/** The shared fixture: a repo whose on-disk tumwater.json holds `config`, one improve runner
 * wired to a live reload over it, and the semaphore the reload resizes. Every test's prelude —
 * makeRepo, writeConfig, one runner, the reload itself — lived copy-pasted here; this homes it
 * and returns the pieces a test mutates or asserts on later (call live.poll() yourself when
 * the test wants the first poll to happen after its own setup). */
function liveReload(config: TumwaterConfig, roleFilter?: string) {
  const root = makeRepo();
  writeConfig(root, config);
  const runners = [makeLoopRunner(root, "improve", config)];
  const sem = new Semaphore(1);
  const live = newReload(root, config, runners, sem, roleFilter);
  return { root, runners, sem, live };
}

test("first poll of an unchanged tumwater.json returns the startup config and logs nothing", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);

  // loadConfigCached clones on every read, so identity is structural, not reference.
  assert.deepEqual(live.poll(), config);
  assert.deepEqual(readEvents(root), []);
});

test("a config edit is pushed to existing runners and logged once, not once per poll", () => {
  const config = defaultConfig();
  const { root, runners, live } = liveReload(config);
  live.poll();

  const edited = cloneConfig(config);
  edited.model = "other-model";
  writeConfig(root, edited);

  assert.equal(live.poll().model, "other-model");
  assert.equal(runners[0]!.config.model, "other-model");
  assert.deepEqual(changedKeys(root), [["model"]]);

  // The second poll of the same file is a no-op: the event is edge-triggered.
  assert.equal(live.poll().model, "other-model");
  assert.equal(changedKeys(root).length, 1);
});

test("a maxConcurrent edit live-resizes the semaphore and logs its own event", () => {
  const config = { ...defaultConfig(), maxConcurrent: 1 };
  const { root, sem, live } = liveReload(config);
  live.poll();

  const edited = cloneConfig(config);
  edited.maxConcurrent = 3;
  writeConfig(root, edited);

  assert.equal(live.poll().maxConcurrent, 3);
  assert.equal(sem.limit, 3);
  const resize = eventsOfType(root, "max_concurrent_changed");
  assert.equal(resize.length, 1);
  assert.deepEqual(resize[0], { ...resize[0], from: 1, to: 3 });
  // maxConcurrent has its own event, so config_changed must not repeat it.
  assert.deepEqual(changedKeys(root), []);
});

test("a missing tumwater.json keeps the last-known-good config and warns once per vanish", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);
  live.poll();

  fs.unlinkSync(`${root}/tumwater.json`);
  assert.deepEqual(live.poll(), config); // last-known-good, never defaults
  assert.equal(warnMessages(root).filter((m) => m.includes("missing")).length, 1);
  assert.deepEqual(live.poll(), config);
  assert.equal(warnMessages(root).filter((m) => m.includes("missing")).length, 1); // once, not per poll

  // The file reappearing reloads it and logs one reappearance line.
  const edited = cloneConfig(config);
  edited.model = "returned-model";
  writeConfig(root, edited);
  assert.equal(live.poll().model, "returned-model");
  assert.equal(warnMessages(root).filter((m) => m.includes("reappeared")).length, 1);
});

test("a broken tumwater.json keeps the last-known-good config and warns once per distinct error", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);
  live.poll();

  fs.writeFileSync(`${root}/tumwater.json`, "{not json");
  assert.deepEqual(live.poll(), config);
  const invalid = () => warnMessages(root).filter((m) => m.startsWith("tumwater.json invalid"));
  assert.equal(invalid().length, 1);
  assert.deepEqual(live.poll(), config);
  assert.equal(invalid().length, 1); // same error text: no second warning

  // A different error (parses as JSON but fails validation) warns again.
  fs.writeFileSync(`${root}/tumwater.json`, JSON.stringify({ model: 42 }));
  assert.deepEqual(live.poll(), config);
  assert.equal(invalid().length, 2);
});

test("enabling a role mid-run appends a runner; disabling one warns that its ticks stop", () => {
  const config = cloneConfig(defaultConfig());
  const qaRole = config.roles.qa ?? { enabled: true };
  config.roles.qa = { ...qaRole, enabled: false };
  const { root, runners, live } = liveReload(config);
  // The first poll syncs the fleet: every enabled role missing from the list gets a runner,
  // so qa (disabled) is the only catalog role without one.
  live.poll();
  assert.ok(!runners.some((r) => r.role === "qa"));
  assert.deepEqual(readEvents(root), []);

  // Enabling qa starts it: a runner appears, carrying the reloaded config.
  config.roles.qa = { ...qaRole, enabled: true };
  writeConfig(root, config);
  live.poll();
  const qaRunner = runners.find((r) => r.role === "qa");
  assert.ok(qaRunner);
  assert.deepEqual(qaRunner.config, config);

  // Disabling improve warns once; the reload itself never removes a runner.
  config.roles.improve = { ...(config.roles.improve ?? { enabled: true }), enabled: false };
  writeConfig(root, config);
  live.poll();
  assert.ok(runners.some((r) => r.role === "improve") && runners.some((r) => r.role === "qa"));
  assert.equal(warnMessages(root).filter((m) => m.includes("role improve disabled")).length, 1);
});

test("a scoped round's filter skips runners for other roles, and still logs their enabling", () => {
  // A scoped once round (`run --once --role improve`): only improve may ever gain a runner,
  // even though the on-disk config enables qa too — the round must not silently widen past
  // the role it was scoped to.
  const config = cloneConfig(defaultConfig());
  const qaRole = config.roles.qa ?? { enabled: true };
  config.roles.qa = { ...qaRole, enabled: true };
  const { root, runners, live } = liveReload(config, "improve");
  // The first poll's fleet sync honors the filter too: qa is enabled on disk but gets no
  // runner, because the round was scoped before it booted.
  live.poll();
  assert.ok(!runners.some((r) => r.role === "qa"), "no runner for the filtered-out role");
  assert.deepEqual(readEvents(root), []);

  // A mid-round edit that (re-)enables another role does not widen the scope: the enabling
  // warning still fires (the config really changed), but qa's runner waits for the next
  // unscoped round.
  config.roles.qa = { ...qaRole, enabled: false };
  writeConfig(root, config);
  live.poll(); // Edge-sync the transition baseline.
  config.roles.qa = { ...qaRole, enabled: true };
  writeConfig(root, config);
  live.poll();
  assert.ok(!runners.some((r) => r.role === "qa"), "a mid-round enable does not widen the scope");
  assert.equal(warnMessages(root).filter((m) => m.includes("role qa enabled")).length, 1,
    "the enabling is still logged");
});
