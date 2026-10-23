import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { newLiveConfigReload } from "../src/config/config-live.js";
import { readEvents } from "../src/events/event-read.js";
import type { TumwaterConfig } from "../src/config/config-schema.js";
import { Semaphore } from "../src/concurrency/semaphore.js";
import { eventsLogPath } from "../src/paths.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { makeRepo, tmpdir, writeConfig } from "./fixtures/repo-fixtures.js";
import { writeScript } from "./fakes/fake-commands.js";
import { readOpencodeCache } from "../src/agent/opencode/opencode-catalog.js";
import { readClaudeAccount } from "../src/agent/claude/claude-account.js";
import { readCodexAccount } from "../src/agent/codex/codex-account.js";

function cloneConfig(c: TumwaterConfig): TumwaterConfig {
  return JSON.parse(JSON.stringify(c)) as TumwaterConfig;
}

function warnMessages(root: string): string[] {
  return readEvents(root)
    .filter((e) => e.type === "warning" && e.source === "tumwater")
    .map((e) => (e as unknown as { message: string }).message);
}

function changedKeys(root: string): string[][] {
  return readEvents(root)
    .filter((e) => e.type === "config_changed")
    .map((e) => (e as unknown as { keys: string[] }).keys);
}

function modelEvents(root: string): { from?: string; to?: string; roles?: { role: string; from: string | null; to: string | null }[] }[] {
  return readEvents(root).filter((e) => e.type === "model_changed") as never;
}

function newReload(
  root: string,
  config: TumwaterConfig,
  runners: ReturnType<typeof makeRoleRunner>[],
  sem: Semaphore,
  roleFilter?: string | readonly string[],
) {
  return newLiveConfigReload({
    root,
    config,
    mainBranch: "main",
    runnerSignal: new AbortController().signal,
    runners,
    semaphore: sem,
    roleFilter: typeof roleFilter === "string" ? [roleFilter] : roleFilter,
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
  const runners = [makeRoleRunner(root, "improve", config)];
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

test("a top-level model edit logs one model_changed with the new label, edge-triggered", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);
  live.poll();

  const edited = cloneConfig(config);
  edited.model = "prov-a/model-a";
  writeConfig(root, edited);
  live.poll();

  // config_changed (unchanged) then the model-specific line, exactly once.
  assert.deepEqual(changedKeys(root), [["model"]]);
  const models = modelEvents(root);
  assert.equal(models.length, 1);
  assert.equal(models[0]!.from, null);
  assert.equal(models[0]!.to, "prov-a/model-a");

  // An unchanged poll of the same file adds nothing more.
  live.poll();
  assert.equal(modelEvents(root).length, 1);
});

// A backend flip over a bare-id model (PLANS.md "Mixed claude + pi fleets, part 3/4" gap 7):
// the label is agent-qualified, so moving `agent` pi→claude relabels the tier and the reload
// logs model_changed — an edit that moves a bare id to another backend must not read as
// "nothing changed".
test("flipping agent over a bare-id model logs one model_changed", () => {
  // A non-claude bare id: over `pi` it stays bare, over `claude` it names the backend, so the
  // flip relabels the tier. (A bare `claude-…` id routes to claude over pi already — rule 3a —
  // so the flip would not relabel it.)
  const config = cloneConfig(defaultConfig());
  config.backend = "pi";
  config.model = "sonnet";
  const { root, live } = liveReload(config);
  live.poll();

  const edited = cloneConfig(config);
  edited.backend = "claude";
  writeConfig(root, edited);
  live.poll();

  const models = modelEvents(root);
  assert.equal(models.length, 1, "a backend flip over a bare id is a model change");
  assert.equal(models[0]!.from, "sonnet");
  assert.equal(models[0]!.to, "claude/sonnet");
});

test("a roles.<id>.model edit logs a model_changed carrying the per-role diff", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);
  live.poll();

  const edited = cloneConfig(config);
  edited.roles.qa = { ...edited.roles.qa, enabled: true, model: "prov-b/model-b" };
  writeConfig(root, edited);
  live.poll();

  const models = modelEvents(root);
  assert.equal(models.length, 1);
  assert.equal(models[0]!.from, null);
  assert.equal(models[0]!.to, null);
  assert.deepEqual(models[0]!.roles, [{ role: "qa", from: null, to: "prov-b/model-b" }]);
});

test("a roles.<id>.instructions edit logs config_changed but no model_changed", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);
  live.poll();

  const edited = cloneConfig(config);
  edited.roles.qa = { ...edited.roles.qa, enabled: true, instructions: "be nice" };
  writeConfig(root, edited);
  live.poll();

  assert.deepEqual(changedKeys(root), [["roles.qa"]]);
  assert.equal(modelEvents(root).length, 0);
});

test("a minRunIntervalSeconds-only edit logs no model_changed", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);
  live.poll();

  const edited = cloneConfig(config);
  edited.minRunIntervalSeconds = (edited.minRunIntervalSeconds ?? 0) + 1;
  writeConfig(root, edited);
  live.poll();

  assert.deepEqual(changedKeys(root), [["minRunIntervalSeconds"]]);
  assert.equal(modelEvents(root).length, 0);
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

test("a maxConcurrentPerProvider edit re-applies key caps and logs one event per changed provider", () => {
  const config = { ...defaultConfig(), maxConcurrentPerProvider: { omlx: 1 } };
  const { root, sem, live } = liveReload(config);
  live.poll();
  // The startup config seeds the pool's caps.
  assert.equal(sem.snapshot().byKey.omlx?.limit, 1);

  const edited = cloneConfig(config);
  edited.maxConcurrentPerProvider = { omlx: 2, claude: 3 };
  writeConfig(root, edited);

  assert.equal(live.poll().maxConcurrentPerProvider?.claude, 3);
  const snap = sem.snapshot().byKey;
  assert.equal(snap.omlx?.limit, 2);
  assert.equal(snap.claude?.limit, 3);
  const caps = eventsOfType(root, "provider_concurrency_changed");
  assert.equal(caps.length, 2);
  const byProvider = Object.fromEntries(caps.map((e) => [e.provider as string, { from: e.from, to: e.to }]));
  assert.deepEqual(byProvider, { omlx: { from: 1, to: 2 }, claude: { from: 0, to: 3 } });
  // Each provider cap has its own event, so config_changed must not repeat the key.
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

test("a broken tumwater.json still reloads when the event log is unwritable", () => {
  const config = defaultConfig();
  const { root, live } = liveReload(config);
  live.poll();
  // events.jsonl as a directory makes every logEvent/warnEvent append throw (EISDIR). The
  // invalid-config warning must not take the team down with it: poll() is called from the
  // orchestrator's poll loop, which has no catch.
  fs.mkdirSync(eventsLogPath(root), { recursive: true });
  fs.writeFileSync(`${root}/tumwater.json`, "{not json");
  assert.doesNotThrow(() => live.poll());
  assert.deepEqual(live.poll(), config);
});

test("enabling a role mid-run appends a runner; disabling one warns that its runs stop", () => {
  const config = cloneConfig(defaultConfig());
  const qaRole = config.roles.qa ?? { enabled: true };
  config.roles.qa = { ...qaRole, enabled: false };
  const { root, runners, live } = liveReload(config);
  // The first poll syncs the team: every enabled role missing from the list gets a runner,
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
  // The first poll's team sync honors the filter too: qa is enabled on disk but gets no
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

test("a scoped round with two roles creates runners for both and no other", () => {
  const config = cloneConfig(defaultConfig());
  for (const id of ["qa", "readme"]) {
    config.roles[id] = { ...(config.roles[id] ?? { enabled: true }), enabled: true };
  }
  const root = makeRepo();
  writeConfig(root, config);
  const runners = [makeRoleRunner(root, "improve", config)];
  const live = newReload(root, config, runners, new Semaphore(1), ["improve", "qa"]);
  live.poll();
  assert.ok(runners.some((r) => r.role === "qa"), "a runner for the second listed role");
  assert.ok(!runners.some((r) => r.role === "readme"), "no runner for an unlisted role");
});

test("raising an instance count appends the new role's runner; lowering keeps it (part 5b/7)", () => {
  const config = cloneConfig(defaultConfig());
  config.roles.feature = { ...(config.roles.feature ?? { enabled: true }), instances: 1 };
  const { root, runners, live } = liveReload(config);
  live.poll();
  assert.ok(!runners.some((r) => r.role === "feature-2"), "one instance means no -2 runner");

  config.roles.feature = { ...config.roles.feature, instances: 2 };
  writeConfig(root, config);
  live.poll();
  assert.ok(runners.some((r) => r.role === "feature-2"), "the new instance gains a runner");
  assert.equal(warnMessages(root).filter((m) => m.includes("role feature-2 enabled")).length, 1);

  // A lowered count keeps the runner (runnerEnabled skips its future runs) and warns once.
  config.roles.feature = { ...config.roles.feature, instances: 1 };
  writeConfig(root, config);
  live.poll();
  assert.ok(runners.some((r) => r.role === "feature-2"), "a lowered count keeps the runner");
  assert.equal(warnMessages(root).filter((m) => m.includes("role feature-2 disabled")).length, 1);
});

test("a live edit adding a claude reviewer verifies the binary and seeds the account once", () => {
  // plans/provider-concurrency.md §9 gap 1: before seeking, a live edit that added a claude
  // seam to a pi team re-ran neither the backend's binary check nor the account seed — the
  // team then ran the reviewer unverifiably and, with no account file, the budget priced it
  // at the cap. Now the reload checks the newly-routed backend and seeds once per root, with a
  // missing binary a warning event rather than a crash.
  const start = cloneConfig(defaultConfig());
  start.review = { ...(start.review ?? {}), enabled: true };
  const { root, live } = liveReload(start);
  live.poll(); // first poll of the unchanged pi config: nothing new
  const claudeBin = tmpdir("live-claude-bin-");
  writeScript(path.join(claudeBin, "claude"), 'echo \'{"loggedIn":true,"subscriptionType":"team"}\'');
  const next = cloneConfig(start);
  next.backends = { claude: { bin: path.join(claudeBin, "claude") } };
  next.review = { ...next.review, backend: "claude", model: "claude-sonnet-5-5" };
  writeConfig(root, next);
  live.poll();
  const binary = readEvents(root).filter((e) => e.type === "backend_binary");
  assert.equal(binary.length, 1, "one backend_binary event for the newly routed claude");
  assert.equal((binary[0] as unknown as { agent: string }).agent, "claude");
  assert.equal((binary[0] as unknown as { found: boolean }).found, true);
  const account = readClaudeAccount(root);
  assert.ok(account !== null, "the reload seeded the claude account");
  assert.equal(account.billing, "subscription");
  // Repeated polls of the same config seed/check nothing further (once per root).
  live.poll();
  assert.equal(readEvents(root).filter((e) => e.type === "backend_binary").length, 1);
});

test("a live edit adding a missing claude binary warns but keeps the team running", () => {
  const start = cloneConfig(defaultConfig());
  start.review = { ...(start.review ?? {}), enabled: true };
  const { root, live } = liveReload(start);
  live.poll();
  const next = cloneConfig(start);
  next.backends = { claude: { bin: "/no/such/claude" } };
  next.review = { ...next.review, backend: "claude", model: "claude-sonnet-5-5" };
  writeConfig(root, next);
  live.poll();
  const warnings = warnMessages(root).filter((m) => m.includes("newly routed claude backend"));
  assert.equal(warnings.length, 1, "a missing newly-routed binary warns, once");
  assert.match(warnings[0] ?? "", /\/no\/such\/claude/);
  // The team kept running: the poll returned the live config, no throw.
  assert.equal(readEvents(root).some((e) => e.type === "backend_binary"), false);
});

test("a live edit routing a seam to codex refuses while codex is logged in with an API key", () => {
  const start = cloneConfig(defaultConfig());
  start.review = { ...(start.review ?? {}), enabled: true };
  const { root, runners, live } = liveReload(start);
  live.poll(); // the unchanged pi config: nothing new
  const codexBin = tmpdir("live-codex-bin-");
  writeScript(path.join(codexBin, "codex"), 'echo "Logged in using an API key"');
  const next = cloneConfig(start);
  next.backends = { codex: { bin: path.join(codexBin, "codex") } };
  next.review = { ...next.review, backend: "codex", model: "gpt-6-luna" };
  writeConfig(root, next);
  // The refusal keeps the last-known-good config: the API-billed codex seam is never applied,
  // so no runner routes to it (the same refusal as startup, decision 5).
  assert.deepEqual(live.poll(), start);
  assert.equal(runners[0]!.config.review?.backend, start.review?.backend);
  assert.notEqual(runners[0]!.config.review?.backend, "codex", "the refused codex seam is not applied");
  const warnings = warnMessages(root).filter((m) => m.includes("Codex is logged in with an API key"));
  assert.equal(warnings.length, 1, "an API-key codex seam warns the same refusal as startup");
  assert.match(warnings[0] ?? "", /login --device-auth/);
  assert.equal(readCodexAccount(root)?.billing, "api");
  // A second poll while the file still routes codex keeps refusing (no re-apply, no re-warn).
  assert.deepEqual(live.poll(), start);
  assert.equal(warnMessages(root).filter((m) => m.includes("Codex is logged in with an API key")).length, 1);
});

/** A live reload over a pi team whose review seam a test then edits onto opencode, with the
 * catalog seed's fetch injected. Returns a poll that routes the seam and lets the
 * fire-and-forget refresh settle (an async fetch stub plus synchronous cache I/O leaves only
 * microtasks). */
function opencodeRouting(fetch: () => Promise<never>) {
  const start = cloneConfig(defaultConfig());
  start.review = { ...(start.review ?? {}), enabled: true };
  const root = makeRepo();
  writeConfig(root, start);
  const live = newLiveConfigReload({
    root,
    config: start,
    mainBranch: "main",
    runnerSignal: new AbortController().signal,
    runners: [makeRoleRunner(root, "improve", start)],
    semaphore: new Semaphore(1),
    opencodeSeed: { fetch, now: () => 1_000 },
  });
  live.poll(); // the unchanged pi config: nothing new
  const binDir = tmpdir("live-opencode-bin-");
  writeScript(path.join(binDir, "opencode"), "exit 0");
  const next = cloneConfig(start);
  next.backends = { opencode: { bin: path.join(binDir, "opencode") } };
  next.review = { ...next.review, backend: "opencode", model: "deepseek-v4.1-flash-free" };
  writeConfig(root, next);
  const pollAndSettle = async () => {
    live.poll();
    await new Promise((r) => setImmediate(r));
  };
  return { root, pollAndSettle };
}

test("a live edit routing a seam to opencode seeds the models catalog once", async () => {
  let calls = 0;
  const { root, pollAndSettle } = opencodeRouting((async () => {
    calls++;
    return { opencode: { models: { "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 } } } } };
  }) as never);
  await pollAndSettle();
  assert.equal(calls, 1);
  const cache = readOpencodeCache(root);
  assert.equal(cache.fetchedAt, 1_000);
  assert.equal(cache.models["opencode/deepseek-v4.1-flash-free"]?.free, true);
  await pollAndSettle();
  assert.equal(calls, 1, "a repeated poll does not refetch");
});

test("a failed live catalog seed warns instead of crashing the poll", async () => {
  const { root, pollAndSettle } = opencodeRouting((async () => {
    throw new Error("offline");
  }) as never);
  await pollAndSettle();
  const warnings = warnMessages(root).filter((m) => m.startsWith("open code model catalog fetch failed"));
  assert.equal(warnings.length, 1);
});
