import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { defaultConfig, loadConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { runOrchestrator } from "../src/orchestrator.js";
import { drainMerge, newLandingPipeline, startVet, type LandingPipelineContext } from "../src/landing-drain.js";
import { headLanding } from "../src/land-queue.js";
import { Semaphore } from "../src/semaphore.js";
import { LoopRunner } from "../src/loop.js";
import { SUPERVISED_ENV } from "../src/supervisor.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import type { TickResult } from "../src/types.js";
import { startGui } from "../src/ui/gui.js";

/** Per-process root for every test temp dir: created on first use, torn down synchronously at
 * process exit. A full suite run (one worker process per test file) therefore abandons at most
 * one directory per file instead of one per tmpdir() call (~500 per run), which kept $TMPDIR
 * growing until mkdtemp itself dominated suite runtime. */
let runRoot: string | undefined;

function testRunRoot(): string {
  if (runRoot === undefined) {
    runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-test-run-"));
    process.once("exit", () => {
      if (runRoot === undefined) return;
      try {
        fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Best effort: one leaked root per crashed process is still bounded.
      }
    });
  }
  return runRoot;
}

export function tmpdir(prefix = "tumwater-test-"): string {
  return fs.mkdtempSync(path.join(testRunRoot(), prefix));
}

/** Local-calendar timestamp `daysAgo` days before today, at local `hour` (default 12 — noon
 * keeps a fixture from straddling midnight between seeding and the reader's own clock read).
 * The report/event-window/digest readers bucket by LOCAL day, so fixtures build timestamps
 * from local date parts (never UTC strings) the same way they do. */
export function atLocalTs(daysAgo: number, hour = 12): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/** The local-day key `YYYY-MM-DD` the report/digest collectors bucket by, built from raw
 * local date parts as a test-local oracle — never through text.ts's formatDate — so a drift
 * in the collector's day keying fails an assertion instead of matching its own format. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Write events.jsonl under a fixture root's .tumwater/log/ (strings pass through verbatim —
 * for malformed lines; objects are JSON-encoded like logEvent writes them). */
export function writeEvents(root: string, lines: unknown[]): void {
  const file = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
}

/** Local wall-clock rendering of an epoch-ms timestamp as `YYYY-MM-DD HH:MM:SS` — the same
 * shape the transcript's run separators print. Test-local oracle: built from raw local date
 * parts, never through text.ts's formatDate/formatTime, so the transcript renderers stay
 * pinned against an implementation-independent expectation. */
export function expectedTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trimEnd();
}

/** `git init -b main` in `dir` with the fixtures' commit identity. The identity is appended to
 * .git/config directly — byte for byte what `git config user.name test` and `git config
 * user.email …` write — because fixture repos are made ~600 times a suite and each spawn
 * costs more than the whole append. */
function gitInit(dir: string): void {
  sh(dir, "git", "init", "-b", "main");
  fs.appendFileSync(path.join(dir, ".git", "config"), "[user]\n\tname = test\n\temail = test@example.com\n");
}

/** Create a git repo on branch `main` with one commit — in a fresh temp dir by default, or at
 * `dir` when the test needs a particular location (e.g. nested under an installed root). */
export function makeRepo(dir = tmpdir()): string {
  fs.mkdirSync(dir, { recursive: true });
  gitInit(dir);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  sh(dir, "git", "add", "-A");
  sh(dir, "git", "commit", "-m", "seed");
  return dir;
}

/** A makeRepo'd repo that has run initProject — the standard fixture for tests that drive a
 * full tick or lander against an initialized tumwater project. Shared by the loop e2e slices,
 * which each used to carry their own identical copy. */
export async function initializedRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "A test project.");
  return repo;
}

/** Scratch project for the build-check tests (build-check.test.ts and review.test.ts's gate
 * integration): `root` has package.json + a fake toolchain in node_modules/.bin; `wt` sits
 * INSIDE it at the real worktree location (`.tumwater/worktrees/improve`) with its own tracked
 * package.json and no install — so root is an ancestor, as detectBuildCheck requires. */
export function buildCheckFixture(): { root: string; wt: string } {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "project");
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  writeScript(path.join(binDir, "buildcheck-tool"), "echo buildcheck-ok");

  const wt = path.join(root, ".tumwater", "worktrees", "improve");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  return { root, wt };
}

/** A git repo whose main is "installed" (package.json + node_modules at root) with a linked
 * worktree checked out to it — the shape checkMainBaseline expects (a pristine main HEAD) —
 * shared by main-red.test.ts and main-baseline.test.ts. `testScript` is committed to main so
 * the worktree's checkout carries it; node_modules stays untracked — the install marker
 * detectBuildCheck walks up to, gitignored in real projects. Each fixture gets its own temp
 * dir, hence its own SHA: the gate's verdict cache and red-SHA warning state are module-level,
 * so tests must never share a HEAD. */
export function baselineFixture(role: string, testScript: string): { root: string; wt: string } {
  const root = path.join(tmpdir("baseline-"), "project");
  fs.mkdirSync(root, { recursive: true });
  gitInit(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: testScript } }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", role);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(root, "git", "worktree", "add", "-b", `tumwater/${role}`, wt, "main");
  return { root, wt };
}

/** How many times a fixture's test script actually ran (its appends to `counter`). Zero when
 * the counter was never written — an environmental skip ran nothing. */
/** Seed a role's state file with non-zero counters plus scheduling fields. */
export function seedCounters(repo: string, role: string): void {
  const s = freshLoopState(role);
  s.ticks = 7;
  s.commits = 3;
  s.generatedTokens = 424242;
  s.totalCostUsd = 1.5;
  s.peakContextTokens = 65536; // last tick's peak — cleared by the reset
  s.nextRunAt = Date.now() + 60_000;
  s.backoffSeconds = 15;
  s.lastMainHead = "deadbeef";
  saveLoopState(repo, s);
}

export function runsOf(counter: string): number {
  try {
    return fs.readFileSync(counter, "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

/** The suite's one committed executable (test/fixtures/script-shim): every fake command a
 * test installs through writeScript is a symlink to it. Resolved from the source tree, which
 * sits beside dist/ whenever the compiled tests run. */
const SCRIPT_SHIM = fileURLToPath(new URL("../../test/fixtures/script-shim", import.meta.url));
// Read-only, so a test that writes to a fake's path (instead of calling writeScript again)
// fails on EACCES right there, rather than writing through the symlink and silently turning
// every other fake in the run into its body. Git records only the executable bit, so this
// never shows up as a change.
try {
  fs.chmodSync(SCRIPT_SHIM, 0o555);
} catch {
  // A read-only checkout already is; the fakes still run.
}

/** Install a fake command at `file` that runs `body` under /bin/sh exactly as a `#!/bin/sh`
 * script holding it would — same process, $0 and arguments — without creating a new
 * executable: macOS scans each newly created executable on its first exec (~150 ms apiece,
 * far more under load), which hundreds of per-test fakes turned into minutes of suite time.
 * `file` becomes a symlink to the committed script-shim, which sources `<file>.sh`. To change
 * a fake, call this again: writing to `file` itself would write through the link into the
 * shim. */
export function writeScript(file: string, body: string): void {
  fs.writeFileSync(`${file}.sh`, `${body}\n`);
  fs.rmSync(file, { force: true });
  fs.symlinkSync(SCRIPT_SHIM, file);
}

/** Install a fake `pi` executable at the front of PATH for the duration of a test.
 * The script runs with the worktree as cwd. Returns a restore function. */
export function fakePi(script: string): () => void {
  const dir = tmpdir("fake-pi-");
  writeScript(path.join(dir, "pi"), script);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

/** Wrap fs.openSync so the first open of `file` unlinks it instead — simulating a log
 * rotation rename landing between a reader's stat and its open (the race tail readers must
 * survive as "no data", not an ENOENT throw). Returns an undo function. */
export function vanishOnOpen(file: string): () => void {
  const orig = fs.openSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).openSync = (p: unknown, flags: string) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return (orig as (x: unknown, f: string) => number)(p, flags);
  };
  return () => {
    (fs as Record<string, unknown>).openSync = orig;
  };
}

/** The rotation twin of vanishOnOpen where the path comes back before open: on the first
 * open of `file`, rename the old file away and recreate it with `content` (smaller than the
 * original in every use so far), then open — simulating a rotation rename plus a fresh append
 * landing between a reader's stat and its open. Returns an undo function. */
export function recreateSmallerOnOpen(file: string, content: string): () => void {
  const orig = fs.openSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).openSync = (p: unknown, flags: string) => {
    if (!hit && p === file) {
      hit = true;
      fs.renameSync(file, file + ".1");
      fs.writeFileSync(file, content);
    }
    return (orig as (x: unknown, f: string) => number)(p, flags);
  };
  return () => {
    (fs as Record<string, unknown>).openSync = orig;
  };
}

/** The readFileSync twin of vanishOnOpen — for readers that stat and then read a small file
 * whole. Returns an undo function. */
export function vanishOnReadFile(file: string): () => void {
  const orig = fs.readFileSync.bind(fs);
  let hit = false;
  (fs as Record<string, unknown>).readFileSync = (p: unknown, ...rest: unknown[]) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return (orig as (x: unknown, ...r: unknown[]) => Buffer)(p, ...rest);
  };
  return () => {
    (fs as Record<string, unknown>).readFileSync = orig;
  };
}

/** A pi JSON line for an assistant message_end. */
export function assistantLine(
  text: string,
  opts: { tokens?: number; output?: number; cost?: number; stopReason?: string } = {},
): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { totalTokens: opts.tokens ?? 0, output: opts.output ?? 0, cost: { total: opts.cost ?? 0 } },
    stopReason: opts.stopReason ?? "stop",
  };
  return JSON.stringify({ type: "message_end", message });
}

/** A pi JSON line for an assistant message_end whose content is thinking-only — the
 * signature of a generation cut off mid-stream (e.g. output clamped to the sliver left
 * under the declared context window); a compliant finish always ends with a text block. */
export function thinkingOnlyLine(
  thinking: string,
  opts: { tokens?: number; output?: number } = {},
): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
      usage: { totalTokens: opts.tokens ?? 0, output: opts.output ?? 0, cost: { total: 0 } },
      stopReason: "stop",
    },
  });
}

/** A pi JSON line for an assistant message_end that ended in a server error. */
export function errorLine(errorMessage: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  });
}

/** A fixed epoch-ms timestamp for transcript fixtures, so run separators render deterministically. */
export const FIXED_TS = 1787222691956;

/** A pi JSON line for an agent_start event — the only event that separates runs in a transcript (src/ui/transcript.ts). */
export function agentStart(): string {
  return JSON.stringify({ type: "agent_start" });
}

/** A pi JSON line for a user message_end (the tick prompt). Its content is never rendered, but its timestamp drives the run separator. */
export function userLine(text: string, timestamp: number = FIXED_TS): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp },
  });
}

/** A pi JSON line for an assistant message_end with arbitrary content blocks (thinking/text/toolCall) and no usage — the richer fixture transcript rendering tests need, in contrast to assistantLine above. */
export function assistantBlocks(content: unknown[]): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "stop" } });
}

// --- Live-orchestrator test helpers (shared by the orchestrator e2e tier, orchestrator*.e2e.test.ts) ---

/** The real setTimeout, captured when this module loads — before any test installs node:test
 * mock timers — so the wait helpers below keep polling in real time under a test that mocks
 * setTimeout itself (watchdogClock with `timeouts`). */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));

/** Poll until `fn` holds. `ms` is a DEADLINE, not a sleep — this returns the moment the
 * condition is true, so a generous budget costs nothing on the success path and buys only
 * slower reporting of a genuine hang. The default was 20s until 2026-09-18, when it became the
 * proximate cause of landing rejections: the fleet runs this suite concurrently with its own
 * ticks, and waits that complete in ~2s idle took past 20s loaded (BUGS.md). */
export async function waitFor(fn: () => boolean, what: string, ms = 60_000): Promise<void> {
  // performance.now(), not Date.now(): a test on watchdogClock has Date frozen between its
  // advances, and a deadline read off it would never expire.
  const deadline = performance.now() + ms;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Poll until `file` exists (bounded), so a test can act only after the fake pi run has
 * done its work — a fixed sleep races process startup when the suite runs in parallel.
 * 30s: the landing gate runs the whole suite concurrently on a saturated machine, where
 * worktree setup plus fake-pi startup can blow a 10s budget (BUGS.md load-sensitive tests). */
export async function waitForFile(file: string, timeoutMs = 30_000): Promise<void> {
  const start = performance.now(); // monotonic, and live under watchdogClock (see waitFor)
  while (!fs.existsSync(file)) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${file}`);
    await sleep(25);
  }
}

/** Put runPi's watchdog (src/pi.ts: the quiet kill and the stall warning) on logical time for
 * the rest of test `t`. The watchdog is a setInterval that reads Date.now(), and open tool
 * calls are stamped with Date.now() (pi-event-line.ts); both become node:test mock timers,
 * started at the real current time. setTimeout stays real, so everything else a run or tick
 * does — spawns, git, locks, the tick timeout — keeps the wall clock. `timeouts: true` puts
 * setTimeout on the same clock, for a test of the tick timeout itself; it is safe only on a
 * path with no other timer to wait out (no contended lock, no rate-limit wait, no build
 * check). The wait helpers here poll on a real timer captured at load, so they work either way.
 *
 * The test moves the watchdog's time with `advance(ms)` at the points it chooses — once the
 * run's raw log shows what it is waiting on (waitForLogLines) — and every check due in that
 * span runs, in order, before advance returns. A real-time watchdog test can only pick
 * margins, which a loaded machine eats (BUGS.md 2026-09-18, 2026-09-21); logical time has no
 * jitter to eat, and a ten-second window costs nothing to cross. `release()` hands the clock
 * back early, for a later phase whose regression should end in a real-time kill rather than
 * hang on a clock nobody advances. */
export function watchdogClock(
  t: TestContext,
  opts: { timeouts?: boolean } = {},
): { advance(ms: number): void; release(): void } {
  t.mock.timers.enable({
    apis: opts.timeouts ? ["Date", "setInterval", "setTimeout"] : ["Date", "setInterval"],
    now: Date.now(),
  });
  return {
    // In steps of the watchdog's shortest check interval (250 ms): one tick(ms) sets the clock
    // to the END of the span before running what fell due, so every check in it would read the
    // same Date.now() and never see silence grow.
    advance: (ms) => {
      for (let left = ms; left > 0; left -= 250) t.mock.timers.tick(Math.min(250, left));
    },
    release: () => t.mock.timers.reset(),
  };
}

/** Wait, in real time, until `file` holds at least `count` lines containing `needle` — how a
 * watchdogClock test knows runPi has parsed the fake pi's output before it advances the
 * clock: runPi writes each stdout line to its raw log in the same synchronous step that feeds
 * the parser, so a line on disk is a line the watchdog has already seen. Resolves true once
 * the lines are there — or false as soon as `stop()` holds, for a test that interleaves
 * advances with fresh output until the run it drives has ended and will print nothing more. */
export async function waitForLogLines(
  file: string,
  needle: string,
  count = 1,
  stop?: () => boolean,
): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    let n = 0;
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) if (line.includes(needle)) n++;
    } catch {
      // Not written yet.
    }
    if (n >= count) return true;
    if (stop?.()) return false;
    if (performance.now() - start > 30_000)
      throw new Error(`timed out waiting for ${count} line(s) containing ${JSON.stringify(needle)} in ${file}`);
    await sleep(10);
  }
}

/** Fast poll interval for live-orchestrator tests whose assertions don't depend on the real
 * 2s cadence: multi-cycle behavior (config reloads, marker consumption, wake events) resolves
 * in ~100ms instead of seconds. Tests that verify timing margins against the real cadence —
 * shutdown latency vs POLL_MS, and maxConcurrent's hold < poll boundary — keep the default.
 * Safe because idle ticks back off 1s (fastConfig), so no assertion relies on a >=2s gap
 * between polls to prevent back-to-back ticks. */
export const FAST_POLL_MS = 100;

/** The in-flight counts a concurrency-recording fake pi wrote, one per run start (empty before
 * any run). */
export function readSamples(runDir: string): number[] {
  try {
    return fs.readFileSync(path.join(runDir, "samples.log"), "utf8").trim().split("\n").map(Number);
  } catch {
    return [];
  }
}

/** A fake pi that records each run's --provider/--model flags — and its session name, which
 * carries the role — to argsFile and declares nothing-to-do (so no commit happens). `cost`
 * makes each run report that many dollars of spend, for tests that drive the daily budget
 * gate while watching which model each run used. */
export function recordingFakePi(argsFile: string, opts: { cost?: number } = {}): () => void {
  return fakePi(
    [
      `m=""; p=""; n=""`,
      `while [ $# -gt 0 ]; do case "$1" in --model) m="$2";; --provider) p="$2";; -n) n="$2";; esac; shift; done`,
      `echo "run: model=$m provider=$p session=$n" >> "${argsFile}"`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO", { cost: opts.cost ?? 0 })}'`,
    ].join("\n"),
  );
}

/** A config where only the given roles tick quickly (no min gap, 1s backoff) so several
 * ticks land within a few poll cycles. */
export function fastConfig(roles: string[], model?: string): TumwaterConfig {
  const c = defaultConfig();
  if (model) c.model = model;
  c.minTickIntervalSeconds = 0;
  c.idleBackoff = { initialSeconds: 1, factor: 1, maxSeconds: 1 };
  for (const id of Object.keys(c.roles)) c.roles[id]!.enabled = roles.includes(id);
  return c;
}

/** Start a live orchestrator on `repo` with the config currently on disk, for tests that
 * drive it while running. Returns its exit promise plus `stop`, which aborts the run and
 * awaits its exit — swallowing shutdown noise so the test's own failure (if any) stays
 * visible; call `stop` from finally after other cleanup (e.g. restoring a fake pi). */
export function startLiveOrchestrator(
  repo: string,
  pollMs?: number,
  modelsPath?: string,
): { done: Promise<unknown>; stop: () => Promise<void> } {
  const controller = new AbortController();
  const done = runOrchestrator({
    root: repo,
    config: loadConfig(repo),
    mainBranch: "main",
    signal: controller.signal,
    pollMs,
    // pi's model definitions, for the budget gate's fallback check (plans/fallback-model.md):
    // tests that exercise it write their own catalog instead of reading the real ~/.pi one.
    ...(modelsPath ? { modelsPath } : {}),
  });
  return {
    done,
    async stop() {
      controller.abort();
      try {
        await done;
      } catch {
        // The test's own failure (if any) takes precedence over shutdown noise.
      }
    },
  };
}

/** Land a commit on main that counts as "work" for need-based prioritization, so deferrable
 * maintenance roles wake and re-tick. Tests that pin scheduling-adjacent behavior (config
 * reloads, resets, gates) use it to keep their maintenance roles ticking — the deferral rule
 * itself is pinned in its own test in orchestrator.e2e.test.ts. */
export function landWork(repo: string): void {
  fs.writeFileSync(
    path.join(repo, `work-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`),
    "work\n",
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "tumwater(feature): test work landing");
}

/** Land the head of the durable land queue through the orchestrator's own landing pipeline
 * (landing-drain.ts). Loop-level tests call `runner.tick()` directly — no poll loop — so the
 * entry a changed tick enqueues needs a driver: this vets the head alone (startVet, on a
 * one-permit semaphore) and, once vetted, merges it (drainMerge), leaving every other queued
 * entry untouched — a test that ticks a second role meanwhile lands that one with its own call.
 * `signal` stands in for harness shutdown (the orchestrator's stop signal). Returns the
 * landing's outcome as folded into `runner`'s state; the entry is dropped after every outcome,
 * exactly as the pipeline does. */
export async function landHead(
  repo: string,
  runner: LoopRunner,
  config: TumwaterConfig,
  role: string,
  branch = "main",
  signal: AbortSignal = new AbortController().signal,
): Promise<TickResult> {
  const head = headLanding(repo);
  if (!head) throw new Error("expected a queued landing");
  assert.equal(head.entry.role, role, "the queue head belongs to the expected role");
  assert.equal(runner.role, role, "the landing folds into its own role's runner");
  const ctx: LandingPipelineContext = {
    root: repo,
    mainBranch: branch,
    signal,
    semaphore: new Semaphore(1),
    runners: [runner],
    liveConfig: config,
    roleConfig: config,
    startHeld: () => false,
  };
  const pipeline = newLandingPipeline();
  startVet(ctx, pipeline, head.entry, head.file);
  await Promise.all([...pipeline.vetting.values()].map((v) => v.promise));
  drainMerge(ctx, pipeline);
  await pipeline.merge?.promise;
  if (fs.existsSync(head.file)) throw new Error(`the landing of ${role} ended without an outcome`);
  const result = runner.state.lastResult;
  if (result === undefined) throw new Error(`the landing of ${role} recorded no result`);
  return result;
}

// --- GUI server scaffolding ---

/** Start the GUI server on an ephemeral port and return it with its `http://127.0.0.1:<port>`
 * base URL: the same three lines (startGui on port 0, narrow the address, build the base)
 * every GUI test needs before it can talk to the server, shared so the narrowing and URL
 * cannot drift between the four gui*.test.ts files. Socket-level tests take `port` via
 * startGui directly; `token` starts a token-protected server for the auth-gate tests. */
export async function startLocalGui(
  root: string,
  token = "",
): Promise<{ server: Server; base: string; port: number }> {
  const server = await startGui(root, 0, false, token);
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return { server, base: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

// --- CLI binary scaffolding: the CLI is tested as a child process ---

// The CLI runs main() on import and reports failures via process.exit, so it is
// tested as a child process: the built dist/src/cli.js with cwd set to a temp repo.
export const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with an explicit env override (merged over process.env). The timeout
 * bounds tests that would otherwise hang if a command regresses to not exiting. */
export function cliWithEnv(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<CliResult> {
  const merged = { ...process.env, ...env };
  // Hermeticity: the supervised marker leaks from any tumwater orchestrator into pi's (and
  // this test process') environment; without stripping it, `run` skips its supervisor half.
  delete merged[SUPERVISED_ENV];
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: merged, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

export function cli(cwd: string, ...args: string[]): Promise<CliResult> {
  return cliWithEnv(cwd, {}, args);
}

export interface SpawnedCli {
  out: () => string;
  /** Resolves once `pred` matches the captured stdout; fails the test with the output on timeout. */
  waitFor(pred: (out: string) => boolean, what: string, ms?: number): Promise<void>;
  kill(): void;
}

export function spawnCli(cwd: string, args: string[]): { child: ChildProcess } & SpawnedCli {
  const env = { ...process.env };
  delete env[SUPERVISED_ENV]; // same hermeticity as cliWithEnv: `run` must take the supervisor path
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
  let buffer = "";
  child.stdout?.on("data", (d) => (buffer += d));
  return {
    child,
    out: () => buffer,
    waitFor(pred, what, ms = 10_000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (pred(buffer)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > ms) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for ${what}; output so far:\n${buffer}`));
          }
        }, 100);
      });
    },
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    },
  };
}

/** Wait for the child's exit code; null on timeout so a hung command fails the test instead of hanging it. */
export function exitCode(child: ChildProcess, ms = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    child.once("close", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}
