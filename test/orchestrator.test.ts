import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  fairOrder,
  isEligible,
  orchestratorAlive,
  readOrchestratorInfo,
  runOrchestrator,
} from "../src/orchestrator.js";
import { ROLES } from "../src/roles.js";
import { LoopRunner } from "../src/loop.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.js";
import type { TumwaterConfig } from "../src/types.js";
import { initProject } from "../src/init.js";
import { readEvents } from "../src/events.js";
import { loadLoopState, nextBackoffSeconds, saveLoopState, zeroCounters } from "../src/state.js";
import { orchestratorStatePath, resetRequestPath } from "../src/paths.js";
import { assistantLine, fakePi, makeRepo, tmpdir } from "./util.js";

function runner(role: string): LoopRunner {
  return new LoopRunner(makeRepo(), role, defaultConfig(), "main");
}

test("a fresh loop is eligible at startup", () => {
  const r = runner("clean");
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, true);
});

test("a running or recently-finished loop is not eligible", () => {
  const r = runner("clean");
  r.state.running = true;
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
  r.state.running = false;
  r.state.lastTickEndedAt = Date.now();
  r.state.nextRunAt = 0;
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
});

test("a sleeping loop wakes when main moves, respecting the min gap", () => {
  const r = runner("clean");
  const now = Date.now();
  const gap = r.config.minTickIntervalSeconds * 1000;
  r.state.ticks = 1;
  r.state.lastTickEndedAt = now - gap - 1000;
  r.state.nextRunAt = now + 60_000;
  r.state.lastMainHead = "old";
  assert.equal(isEligible(r, now, "old", 0).run, false);
  const woken = isEligible(r, now, "new", 0);
  assert.equal(woken.run, true);
  assert.equal(woken.reason, "main moved");
  // But not if it just finished a tick.
  r.state.lastTickEndedAt = now - 1000;
  assert.equal(isEligible(r, now, "new", 0).run, false);
});

test("the director only runs when the inbox has work", () => {
  const r = runner("director");
  assert.equal(isEligible(r, Date.now(), "abc", 0).run, false);
  const eligible = isEligible(r, Date.now(), "abc", 2);
  assert.equal(eligible.run, true);
  assert.equal(eligible.reason, "inbox");
});

test("the director ignores the min gap and backoff: queued prompts run back to back", () => {
  const r = runner("director");
  const now = Date.now();
  r.state.lastTickEndedAt = now - 1000; // Just finished — a role loop would be gated.
  r.state.nextRunAt = now + 3600_000; // Even a (stale) backoff must not block prompts.
  assert.equal(isEligible(r, now, "abc", 1).run, true);
  assert.equal(isEligible(r, now, "abc", 0).run, false);
});

test("fairOrder puts the director first even when it ticked most recently", () => {
  const director = runner("director");
  director.state.lastTickEndedAt = 9999;
  const feature = runner("feature");
  feature.state.lastTickEndedAt = 1;
  const fresh = runner("clean");
  assert.deepEqual(
    fairOrder([feature, fresh, director]).map((r) => r.role),
    ["director", "clean", "feature"],
  );
});

test("role catalog puts shipping work before hygiene", () => {
  const ids = ROLES.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 4), ["feature", "bugfix", "plan", "readme"]);
  for (const hygiene of ["organize", "coverage", "clean", "dry"]) {
    assert.ok(ids.indexOf(hygiene) > ids.indexOf("readme"), `${hygiene} should rank below readme`);
  }
});

test("fairOrder alternates loops: least-recently-ticked first, catalog order for fresh ties", () => {
  const recent = runner("feature");
  recent.state.lastTickEndedAt = 2000;
  const stale = runner("dry");
  stale.state.lastTickEndedAt = 1000;
  const freshA = runner("bugfix");
  const freshB = runner("clean");
  const ordered = fairOrder([recent, freshA, stale, freshB]);
  assert.deepEqual(
    ordered.map((r) => r.role),
    ["bugfix", "clean", "dry", "feature"],
  );
});

test("backoff grows by the factor and caps at max", () => {
  const config = defaultConfig();
  config.idleBackoff = { initialSeconds: 10, factor: 3, maxSeconds: 50 };
  let backoff = 0;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    backoff = nextBackoffSeconds(backoff, config);
    seen.push(backoff);
  }
  assert.deepEqual(seen, [10, 30, 50, 50]);
});

// --- Orchestrator lifecycle (info file, alive check, run/shutdown) ---

test("readOrchestratorInfo and orchestratorAlive handle missing, valid, dead-pid, and corrupt state", () => {
  const dir = tmpdir();
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);

  const file = orchestratorStatePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Our own pid is alive; a huge one is not.
  for (const [pid, alive] of [
    [process.pid, true],
    [999_999_999, false],
  ] as const) {
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now(), roles: ["clean"] }));
    assert.equal(readOrchestratorInfo(dir)?.pid, pid);
    assert.equal(orchestratorAlive(dir), alive);
  }

  // A torn write must not crash observers (TUI/GUI poll this every second).
  fs.writeFileSync(file, "{ not json");
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);
});

test("runOrchestrator ticks enabled roles and cleans up on shutdown", async () => {
  const repo = makeRepo();
  await initProject(repo, "orchestrator lifecycle test");
  const config = loadConfig(repo);
  for (const id of Object.keys(config.roles)) {
    if (!["clean", "dry"].includes(id)) config.roles[id]!.enabled = false;
  }
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const controller = new AbortController();
  try {
    const done = runOrchestrator({ root: repo, config, mainBranch: "main", signal: controller.signal });
    // The info file is written before the first poll; wait for it.
    const deadline = Date.now() + 5000;
    while (!readOrchestratorInfo(repo) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    const info = readOrchestratorInfo(repo);
    assert.ok(info, "orchestrator state file exists while running");
    assert.equal(info.pid, process.pid);
    assert.deepEqual([...info.roles].sort(), ["clean", "dry"]);
    assert.ok(orchestratorAlive(repo), "a live orchestrator reports alive");

    setTimeout(() => controller.abort(), 1200);
    await done;

    // Shutdown removed the state file and logged both lifecycle events.
    assert.equal(readOrchestratorInfo(repo), null, "state file removed on shutdown");
    const types = readEvents(repo).map((e) => e.type);
    assert.ok(types.includes("orchestrator_start"));
    assert.ok(types.includes("orchestrator_stop"));
    // Both enabled roles got their startup tick.
    for (const role of ["clean", "dry"])
      assert.ok(loadLoopState(repo, role).ticks >= 1, `${role} should have ticked`);
  } finally {
    restore();
    controller.abort();
  }
});

test("runOrchestrator refuses to start with no roles enabled", async () => {
  const repo = makeRepo();
  await initProject(repo, "no roles test");
  const config = loadConfig(repo);
  for (const id of Object.keys(config.roles)) config.roles[id]!.enabled = false;
  const controller = new AbortController();
  try {
    await assert.rejects(
      runOrchestrator({ root: repo, config, mainBranch: "main", signal: controller.signal }),
      /no roles enabled/,
    );
  } finally {
    controller.abort();
  }
});

// --- Live-reload tumwater.json while running ---

/** Poll until fn() is true, failing after ms (default 20s). */
async function waitFor(fn: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A fake pi that records each run's --provider/--model flags to argsFile and declares
 * nothing-to-do (so no commit happens). */
function recordingFakePi(argsFile: string): () => void {
  return fakePi(
    [
      `m=""; p=""`,
      `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; esac; shift; done`,
      `echo "run: model=$m provider=$p" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
}

/** A config where only the given roles tick quickly (no min gap, 1s backoff) so several
 * ticks land within a few poll cycles. */
function fastConfig(roles: string[], model?: string): TumwaterConfig {
  const c = defaultConfig();
  if (model) c.model = model;
  c.minTickIntervalSeconds = 0;
  c.idleBackoff = { initialSeconds: 1, factor: 1, maxSeconds: 1 };
  for (const id of Object.keys(c.roles)) c.roles[id]!.enabled = roles.includes(id);
  return c;
}

test("mid-run tumwater.json edits steer the fleet; a broken file keeps last-known-good", async () => {
  const repo = makeRepo();
  await initProject(repo, "live reload test");
  saveConfig(repo, fastConfig(["clean"], "good-model"));
  const argsFile = path.join(tmpdir(), "argv.log");
  fs.rmSync(argsFile, { force: true }); // A previous run's lines must not leak into this one.
  const restore = recordingFakePi(argsFile);
  const controller = new AbortController();
  const done = runOrchestrator({ root: repo, config: loadConfig(repo), mainBranch: "main", signal: controller.signal });
  try {
    // Assert on what pi actually saw (its recorded argv), not on tick counts: a tick can be
    // scheduled before our file write lands, so only the argv evidence pins a run to a config.
    // The file is created by pi's first run; until then there are no runs.
    const runs = (): string[] => {
      try {
        // recordingFakePi writes one `run model=… provider=…` line per pi invocation.
        return fs.readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("run:"));
      } catch {
        return [];
      }
    };
    await waitFor(
      () => runs().length >= 1 && runs()[0]?.includes("model=good-model") === true,
      "first pi run",
    );

    // A mid-run edit applies within a poll cycle — no restart.
    saveConfig(repo, fastConfig(["clean"], "reloaded-model"));
    await waitFor(() => runs().at(-1)?.includes("model=reloaded-model") === true, "pi run with the edited model");

    // A broken file keeps the last-known-good config and warns exactly once.
    fs.writeFileSync(path.join(repo, "tumwater.json"), "{ not json");
    const runsBeforeBreak = runs().length;
    await waitFor(
      () => runs().length > runsBeforeBreak && runs().at(-1)?.includes("model=reloaded-model") === true,
      "a further pi run while the file is broken",
    );
    const warnings = () =>
      readEvents(repo).filter(
        (e) => e.type === "warning" && ((e.message as string | undefined) ?? "").includes("tumwater.json invalid"),
      );
    assert.equal(warnings().length, 1, "one warning for the broken file");

    // Fixing the file recovers: the new value applies and no further warnings appear.
    saveConfig(repo, fastConfig(["clean"], "fixed-model"));
    await waitFor(() => runs().at(-1)?.includes("model=fixed-model") === true, "pi run with the fixed model");
    assert.equal(warnings().length, 1, "no new warnings once the file is fixed");
  } finally {
    restore();
    controller.abort();
    try {
      await done;
    } catch {
      // The test's own failure (if any) takes precedence over shutdown noise.
    }
  }
});

// --- Reset counters while running (tumwater reset-counters marker) ---

test("a reset request zeroes in-memory counters, survives tick boundaries, and logs an event", async () => {
  const repo = makeRepo();
  await initProject(repo, "reset counters e2e test");
  saveConfig(repo, fastConfig(["clean"]));
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  const controller = new AbortController();
  const done = runOrchestrator({ root: repo, config: loadConfig(repo), mainBranch: "main", signal: controller.signal });
  try {
    // Let a couple of ticks accumulate counters in the runner's memory.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks >= 2 && !loadLoopState(repo, "clean").running,
      "two finished ticks",
    );

    // Reproduce what `tumwater reset-counters` does from the CLI side: zero the state file
    // and drop the marker. (The CLI path itself is covered in test/cli.test.ts.)
    saveLoopState(repo, zeroCounters(loadLoopState(repo, "clean")));
    const markerFile = resetRequestPath(repo);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), roles: ["clean"] }));

    // The fleet consumes the marker within a poll cycle and re-saves zeroed counters. A
    // post-reset tick may have started in the same poll (its +1 belongs to the new window),
    // so at most 1 is expected — without in-memory zeroing this would read >= 3.
    await waitFor(() => !fs.existsSync(markerFile), "the marker to be consumed");
    assert.ok(
      loadLoopState(repo, "clean").ticks <= 1,
      `counters start from zero after consumption (got ${loadLoopState(repo, "clean").ticks})`,
    );

    // The reset survives tick boundaries: the next completed tick counts from zero — a stale
    // in-memory copy would have saved ticks >= 3 here instead.
    await waitFor(
      () => loadLoopState(repo, "clean").ticks === 1 && !loadLoopState(repo, "clean").running,
      "a post-reset tick to finish",
    );

    // The reset is visible as one plain event (no warning prefix), filed under the role.
    const resets = readEvents(repo).filter((e) => e.type === "counters_reset");
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.loop, "clean");
  } finally {
    restore();
    controller.abort();
    try {
      await done;
    } catch {
      // The test's own failure (if any) takes precedence over shutdown noise.
    }
  }
});

test("roles can be enabled and disabled mid-run without a restart", async () => {
  const repo = makeRepo();
  await initProject(repo, "role toggling test");
  saveConfig(repo, fastConfig(["clean", "dry"]));
  const argsFile = path.join(tmpdir(), "argv.log");
  const restore = recordingFakePi(argsFile);
  const controller = new AbortController();
  const done = runOrchestrator({ root: repo, config: loadConfig(repo), mainBranch: "main", signal: controller.signal });
  try {
    const finished = (role: string) => {
      const s = loadLoopState(repo, role);
      return s.ticks >= 1 && !s.running;
    };
    await waitFor(() => finished("clean") && finished("dry"), "startup ticks to finish");

    // Disabling a role stops its next tick; the rest of the fleet keeps ticking.
    saveConfig(repo, fastConfig(["clean"]));
    await new Promise((r) => setTimeout(r, 1000)); // let any in-flight tick finish first
    const dryTicks = loadLoopState(repo, "dry").ticks;
    const cleanTicks = loadLoopState(repo, "clean").ticks;
    // Longer than the max inter-tick gap (1s backoff + 2s poll), so a live loop would tick.
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(loadLoopState(repo, "dry").ticks, dryTicks, "disabled role stops ticking");
    assert.ok(loadLoopState(repo, "clean").ticks > cleanTicks, "other roles keep ticking");
    const messages = () => readEvents(repo).map((e) => (e.message as string | undefined) ?? "");
    assert.ok(messages().some((m) => m.includes("role dry disabled — stopping ticks")), "disable transition logged");

    // Enabling a role that was not running at startup starts it (new runner).
    saveConfig(repo, fastConfig(["clean", "feature"]));
    await waitFor(() => finished("feature"), "newly enabled role to tick");
    assert.ok(messages().some((m) => m.includes("role feature enabled — starting ticks")), "enable transition logged");
    assert.equal(loadLoopState(repo, "dry").ticks, dryTicks, "still-disabled role stays stopped");

    // Re-enabling a previously running loop resumes it within one poll cycle.
    saveConfig(repo, fastConfig(["clean", "dry", "feature"]));
    await waitFor(() => loadLoopState(repo, "dry").ticks > dryTicks, "re-enabled role to tick again");
    assert.ok(messages().some((m) => m.includes("role dry enabled — starting ticks")), "re-enable transition logged");
  } finally {
    restore();
    controller.abort();
    try {
      await done;
    } catch {
      // The test's own failure (if any) takes precedence over shutdown noise.
    }
  }
});
