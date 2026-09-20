import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cmdAbort,
  cmdPause,
  cmdResetCounters,
  cmdResume,
  cmdWake,
} from "../src/operator-commands.js";
import { defaultConfig } from "../src/config.js";
import { writeJsonFile } from "../src/json-files.js";
import { DIRECTOR_ROLE } from "../src/roles.js";
import {
  freshLoopState,
  loadLoopState,
  saveLoopState,
} from "../src/state.js";
import {
  abortRequestPath,
  orchestratorStatePath,
  pausedPath,
  resetRequestPath,
  wakeRequestPath,
} from "../src/paths.js";
import { tmpdir } from "./util.js";

/** Producer-side tests for the operator-intent protocol (src/operator-commands.ts). Its
 * consumer half is pinned in operator-requests.test.ts; until now these five CLI commands
 * were only exercised by spawning the real binary (test/cli.test.ts), which cannot assert
 * the marker contents or the untouched scheduling fields in-process. */

/** Sentinel thrown by the process.exit stub so fail() paths are catchable in-process. */
class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

type Outcome<T> =
  | { exited: true; code: number; stdout: string; stderr: string }
  | { exited: false; value: T; stdout: string; stderr: string };

/** Run an async command with process.exit, stdout, and stderr intercepted, so a fail() branch
 * (exit 1 + stderr) and a success message are both assertable without killing the test process
 * or polluting the runner's output. Every global is restored in finally. */
async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  const realExit = process.exit;
  const stdout = process.stdout as unknown as { write: (s: string) => boolean };
  const stderr = process.stderr as unknown as { write: (s: string) => boolean };
  const realOutWrite = stdout.write;
  const realErrWrite = stderr.write;
  let out = "";
  let err = "";
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  stdout.write = (s: string) => ((out += s), true);
  stderr.write = (s: string) => ((err += s), true);
  try {
    return { exited: false, value: await fn(), stdout: out, stderr: err };
  } catch (e) {
    if (e instanceof ExitError) return { exited: true, code: e.code, stdout: out, stderr: err };
    throw e;
  } finally {
    process.exit = realExit;
    stdout.write = realOutWrite;
    stderr.write = realErrWrite;
  }
}

async function expectOk<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const o = await attempt(fn);
  if (o.exited) assert.fail(`expected success, but process.exit(${o.code}) with:\n${o.stderr}`);
  return o;
}

async function expectFail(fn: () => Promise<unknown>): Promise<{ code: number; stderr: string }> {
  const o = await attempt(fn);
  if (!o.exited) assert.fail(`expected process.exit, but the call returned ${JSON.stringify(o.value)}`);
  return o;
}

/** Mark a harness live for orchestratorAlive: its info file names a pid that is provably alive
 * (this test process). */
function markLive(root: string): void {
  writeJsonFile(orchestratorStatePath(root), { pid: process.pid, startedAt: Date.now(), roles: [] });
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

// --- reset-counters ---

test("cmdResetCounters with --role zeroes that loop's counters and preserves its schedule", async () => {
  const root = tmpdir();
  saveLoopState(root, {
    ...freshLoopState("coverage"),
    ticks: 9,
    commits: 4,
    generatedTokens: 1200,
    peakContextTokens: 900,
    totalCostUsd: 3.5,
    nextRunAt: 12_345,
    backoffSeconds: 60,
    lastMainHead: "abc",
  });
  const { stdout } = await expectOk(() => cmdResetCounters(root, ["--role", "coverage"]));
  assert.match(stdout, /counters reset for coverage/);
  const after = loadLoopState(root, "coverage");
  assert.equal(after.ticks, 0);
  assert.equal(after.commits, 0);
  assert.equal(after.generatedTokens, 0);
  assert.equal(after.peakContextTokens, 0);
  assert.equal(after.totalCostUsd, 0);
  // Scheduling and wake tracking are deliberately untouched.
  assert.equal(after.nextRunAt, 12_345);
  assert.equal(after.backoffSeconds, 60);
  assert.equal(after.lastMainHead, "abc");
  const marker = readJson(resetRequestPath(root));
  assert.deepEqual(marker["roles"], ["coverage"]);
  assert.equal(typeof marker["at"], "number");
});

test("cmdResetCounters without --role targets every role in the config", async () => {
  const root = tmpdir();
  const roles = Object.keys(defaultConfig().roles);
  saveLoopState(root, { ...freshLoopState("coverage"), ticks: 5 });
  const { stdout } = await expectOk(() => cmdResetCounters(root, []));
  assert.deepEqual(readJson(resetRequestPath(root))["roles"], roles);
  assert.equal(loadLoopState(root, "coverage").ticks, 0);
  assert.ok(stdout.startsWith("counters reset for "));
});

// --- wake ---

test("cmdWake clears the named loop's backoff and pulls nextRunAt to now, leaving counters alone", async () => {
  const root = tmpdir();
  const before = Date.now();
  saveLoopState(root, {
    ...freshLoopState("clean"),
    ticks: 7,
    backoffSeconds: 3600,
    nextRunAt: Date.now() + 999_999,
  });
  const { stdout } = await expectOk(() => cmdWake(root, ["--role", "clean"]));
  assert.match(stdout, /wake requested for clean/);
  const after = loadLoopState(root, "clean");
  assert.equal(after.backoffSeconds, 0);
  assert.ok(after.nextRunAt >= before && after.nextRunAt <= Date.now(), `nextRunAt ${after.nextRunAt} not pulled to now`);
  assert.equal(after.ticks, 7); // observation-window counters are not this command's job
  assert.deepEqual(readJson(wakeRequestPath(root))["roles"], ["clean"]);
});

// --- abort ---

test("cmdAbort without --role fails before writing any marker", async () => {
  const root = tmpdir();
  const { code, stderr } = await expectFail(() => cmdAbort(root, []));
  assert.equal(code, 1);
  assert.match(stderr, /abort requires --role/);
  assert.equal(fs.existsSync(abortRequestPath(root, "coverage")), false);
});

test("cmdAbort with no live harness fails instead of leaving an unconsumable marker", async () => {
  const root = tmpdir();
  const { code, stderr } = await expectFail(() => cmdAbort(root, ["--role", "coverage"]));
  assert.equal(code, 1);
  assert.match(stderr, /no harness is running/);
  assert.equal(fs.existsSync(abortRequestPath(root, "coverage")), false);
});

test("cmdAbort with a live harness writes the per-role marker", async () => {
  const root = tmpdir();
  markLive(root);
  const { stdout } = await expectOk(() => cmdAbort(root, ["--role", "coverage"]));
  assert.match(stdout, /abort requested for coverage/);
  const marker = readJson(abortRequestPath(root, "coverage"));
  assert.equal(typeof marker["at"], "number");
});

test("cmdAbort for the director warns that its in-flight prompt is discarded", async () => {
  const root = tmpdir();
  markLive(root);
  const { stdout } = await expectOk(() => cmdAbort(root, ["--role", DIRECTOR_ROLE]));
  assert.match(stdout, /in-flight prompt will be discarded/);
});

test("cmdAbort rejects an unknown role id", async () => {
  const root = tmpdir();
  markLive(root);
  const { code, stderr } = await expectFail(() => cmdAbort(root, ["--role", "ghost"]));
  assert.equal(code, 1);
  assert.match(stderr, /unknown role: ghost/);
});

// --- pause / resume ---

test("cmdPause writes the marker, reports no-harness timing, and is idempotent", async () => {
  const root = tmpdir(); // fresh repo: no .tumwater/ yet — ensureParentDir must create it
  const first = await expectOk(() => cmdPause(root));
  assert.match(first.stdout, /fleet paused/);
  assert.match(first.stdout, /no harness is running/);
  assert.ok(fs.existsSync(pausedPath(root)));
  const second = await expectOk(() => cmdPause(root));
  assert.match(second.stdout, /already paused/);
});

test("cmdPause with a live harness promises pickup within ~2s", async () => {
  const root = tmpdir();
  markLive(root);
  const { stdout } = await expectOk(() => cmdPause(root));
  assert.match(stdout, /within ~2s/);
  assert.doesNotMatch(stdout, /no harness is running/);
});

test("cmdResume is a no-op without a marker and lifts one when present", async () => {
  const root = tmpdir();
  const idle = await expectOk(() => cmdResume(root));
  assert.match(idle.stdout, /not paused/);
  await expectOk(() => cmdPause(root));
  assert.ok(fs.existsSync(pausedPath(root)));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /fleet resumed/);
  assert.equal(fs.existsSync(pausedPath(root)), false);
});

test("cmdResume with a live harness promises pickup within ~2s", async () => {
  const root = tmpdir();
  markLive(root);
  await expectOk(() => cmdPause(root));
  const { stdout } = await expectOk(() => cmdResume(root));
  assert.match(stdout, /fleet resumed/);
  assert.match(stdout, /within ~2s/);
  assert.doesNotMatch(stdout, /no harness is running/);
});
