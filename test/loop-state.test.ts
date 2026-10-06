import test from "node:test";
import { readJson } from "./json-read.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  freshLoopState,
  loadLoopState,
  saveLoopState,
  zeroCounters,
} from "../src/loop/loop-state.js";
import {
  isFleetPaused,
  orchestratorAlive,
  pauseFleet,
  readOrchestratorInfo,
  resumeFleet,
} from "../src/fleet/fleet-state.js";
import { dailyCost, todayStamp } from "../src/budget/budget.js";
import type { LoopState } from "../src/loop/loop-state.js";
import { orchestratorStatePath, pausedPath, statePath } from "../src/paths.js";
import { tmpdir, writeMalformedJson } from "./repo-fixtures.js";
import { writeOrchestratorMarker } from "./log-fixtures.js";
import { ensureParentDir } from "../src/files.js";

/** The persisted-state file's own tests (src/loop/loop-state.ts): fresh defaults, the tolerant load,
 * the atomic save, the counter reset — and the orchestrator info file, whose readers live in
 * fleet/fleet-state.ts but whose shape is pinned beside the state convention it mirrors. The
 * tick-apply.ts scheduling policy's tests live in tick-apply.test.ts. */

/** Every field a fresh state has must hold its default value (extra junk keys are allowed). */
function assertFreshFields(s: LoopState, role: string): void {
  const fresh = freshLoopState(role);
  for (const key of Object.keys(fresh)) {
    assert.equal(
      s[key as keyof LoopState],
      fresh[key as keyof LoopState],
      `field ${key} should keep its default`,
    );
  }
}

test("loadLoopState returns fresh defaults when no file exists", () => {
  const dir = tmpdir();
  assert.deepEqual(loadLoopState(dir, "clean"), freshLoopState("clean"));
});

test("pauseFleet and resumeFleet write the pause marker and report whether state changed", () => {
  const dir = tmpdir(); // fresh repo: no .tumwater/ yet — writeJsonAtomic must create it
  assert.equal(isFleetPaused(dir), false);

  assert.equal(pauseFleet(dir), true, "the first pause changes state");
  assert.equal(isFleetPaused(dir), true);
  const marker = readJson(pausedPath(dir)) as { at: number };
  assert.deepEqual(Object.keys(marker), ["at"], "the marker keeps the CLI's { at } shape");
  assert.equal(typeof marker.at, "number");

  assert.equal(pauseFleet(dir), false, "a repeat pause is a no-op");
  assert.equal(isFleetPaused(dir), true);

  assert.equal(resumeFleet(dir), true, "resume lifts the marker");
  assert.equal(isFleetPaused(dir), false);
  assert.equal(fs.existsSync(pausedPath(dir)), false);

  assert.equal(resumeFleet(dir), false, "resume without a marker is a no-op");
});

test("saveLoopState creates the state dir and round-trips without leaving a temp file", () => {
  const dir = tmpdir();
  const s = freshLoopState("feature");
  s.ticks = 7;
  s.generatedTokens = 123456;
  s.lastResult = "changed";
  saveLoopState(dir, s); // .tumwater/ does not exist yet
  assert.ok(fs.existsSync(statePath(dir, "feature")));
  const stateDir = path.dirname(statePath(dir, "feature"));
  assert.deepEqual(fs.readdirSync(stateDir), ["feature.json"], "no .tmp leftovers");
  assert.deepEqual(loadLoopState(dir, "feature"), s);
});

// Two processes hammering one role's state file concurrently — the real-world shape: the
// orchestrator saves at tick end and around its review gate while `tumwater reset-counters`
// rewrites the same file from the CLI process. With per-pid tmp names each writer owns its
// own tmp, so neither rename can ENOENT and the final file is always one complete state
// (last writer wins), never bytes mixed from both writers.
test("saveLoopState from two concurrent processes never tears the file or loses a rename", async () => {
  const dir = tmpdir();
  // The child imports the BUILT module, like every other spawned-child test in this suite.
  // Resolved against this test's own file:// URL, so the child can import it from any cwd.
  const stateUrl = new URL("../src/loop/loop-state.js", import.meta.url).href;
  // --input-type=module: top-level import in -e code needs explicit module syntax on Node
  // < 22.7 (engines declares >= 20); detection is not a portable default.
  const script = `
    import { saveLoopState } from ${JSON.stringify(stateUrl)};
    const [root, tag, n] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i++) {
      const s = { role: "race", ticks: i, commits: 0, nextRunAt: 0, backoffSeconds: 0, lastMainHead: "", generatedTokens: 0, peakContextTokens: 0, totalCostUsd: 0, dayStamp: "", dayCostUsd: 0 };
      if (tag === "b") s.lastSummary = "writer-b padding ".repeat(16); // longer payload than writer a's
      saveLoopState(root, s);
    }`;
  const runWriter = (tag: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, tag, "300"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stderr }));
    });
  const [a, b] = await Promise.all([runWriter("a"), runWriter("b")]);
  assert.equal(a.code, 0, `writer a crashed: ${a.stderr}`);
  assert.equal(b.code, 0, `writer b crashed: ${b.stderr}`);

  const file = statePath(dir, "race");
  let parsed: Record<string, unknown>;
  try {
    parsed = readJson(file);
  } catch (err) {
    assert.fail(`state file is torn after concurrent writes (${String(err)})`);
  }
  // Last writer wins with a COMPLETE state from one process — never bytes mixed from both.
  const summary = parsed.lastSummary;
  assert.ok(
    summary === undefined || (typeof summary === "string" && summary.startsWith("writer-b padding")),
    `mixed writers in final state: ${JSON.stringify(summary)}`,
  );
  // No tmp remnants from either pid.
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-")), [], "no tmp leftovers");
});

test("loadLoopState fills fields missing from an older or partial file", () => {
  const dir = tmpdir();
  const file = statePath(dir, "clean");
  ensureParentDir(file);
  // A state file written before generatedTokens/lastMainHead existed.
  fs.writeFileSync(file, JSON.stringify({ role: "clean", ticks: 3, commits: 1 }));
  const s = loadLoopState(dir, "clean");
  assert.equal(s.ticks, 3);
  assert.equal(s.commits, 1);
  // loop.ts adds to these every tick; undefined would turn them into NaN.
  assert.equal(s.generatedTokens, 0);
  assert.equal(s.peakContextTokens, 0);
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.lastMainHead, "");
  assert.ok(Number.isFinite(s.nextRunAt));
  // A file written before the daily budget window existed reads $0 through dailyCost —
  // spend recorded before dayStamp/dayCostUsd were fields is unknown, not infinite.
  assert.equal(dailyCost(s), 0);
});

test("loadLoopState recovers from torn or non-object JSON", () => {
  const dir = tmpdir();
  const file = statePath(dir, "dry");
  ensureParentDir(file);
  for (const junk of ['{"ticks": 2', '"just a string"', "[1, 2]", "null"]) {
    fs.writeFileSync(file, junk);
    assertFreshFields(loadLoopState(dir, "dry"), "dry"); // must not throw or lose defaults
  }
});

test("zeroCounters zeroes the accumulated counters and preserves everything else", () => {
  const s = freshLoopState("feature");
  s.ticks = 12;
  s.commits = 5;
  s.generatedTokens = 987654;
  s.totalCostUsd = 3.14;
  s.peakContextTokens = 131072; // last tick's peak — must be cleared too
  s.nextRunAt = 1_700_000_000_000;
  s.backoffSeconds = 30;
  s.lastMainHead = "abc123";
  s.lastResult = "changed";
  s.lastSummary = "did a thing";
  s.lastTickStartedAt = 1;
  s.lastTickEndedAt = 2;
  s.dayStamp = todayStamp(); // daily budget window — must survive a reset
  s.dayCostUsd = 12.5;

  const z = zeroCounters(s);
  assert.equal(z.ticks, 0);
  assert.equal(z.commits, 0);
  assert.equal(z.generatedTokens, 0);
  assert.equal(z.totalCostUsd, 0);
  // Per-tick semantics: peak ctx holds the last completed tick's peak, so a fresh
  // observation window clears it — sleeping loops would otherwise keep showing their old
  // value until they next tick.
  assert.equal(z.peakContextTokens, 0);
  // Scheduling, wake tracking, and last-result fields are untouched.
  assert.equal(z.nextRunAt, s.nextRunAt);
  assert.equal(z.backoffSeconds, 30);
  assert.equal(z.lastMainHead, "abc123");
  assert.equal(z.lastResult, "changed");
  assert.equal(z.lastSummary, "did a thing");
  // The daily cost budget window is deliberately preserved: it is a safety valve, not an
  // observation window — zeroing today's spend would let the cap be bypassed by running
  // reset-counters.
  assert.equal(z.dayStamp, s.dayStamp);
  assert.equal(z.dayCostUsd, 12.5);
  // Pure: the input is unchanged and the result is a new object.
  assert.equal(s.ticks, 12);
  assert.notEqual(z, s);
});

// --- Orchestrator info file: the readers live here so observers don't depend on the scheduler ---

test("readOrchestratorInfo and orchestratorAlive handle missing, valid, dead-pid, and corrupt state", () => {
  const dir = tmpdir();
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);

  const file = orchestratorStatePath(dir);
  ensureParentDir(file);
  // Our own pid is alive; a huge one is not.
  for (const [pid, alive] of [
    [process.pid, true],
    [999_999_999, false],
  ] as const) {
    writeOrchestratorMarker(dir, ["clean"], { pid });
    assert.equal(readOrchestratorInfo(dir)?.pid, pid);
    assert.equal(orchestratorAlive(dir), alive);
  }

  // A torn write must not crash observers (TUI/GUI poll this every second).
  writeMalformedJson(file);
  assert.equal(readOrchestratorInfo(dir), null);
  assert.equal(orchestratorAlive(dir), false);
});
