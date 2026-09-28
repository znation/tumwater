import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { defaultConfig } from "../src/config.js";
import { gitInit, sh, tmpdir } from "./repo-fixtures.js";
import { writeScript } from "./fake-commands.js";
import { LoopRunner } from "../src/loop.js";
import { freshLoopState, saveLoopState } from "../src/state.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import type { HarnessEvent } from "../src/types.js";
import { readEvents } from "../src/events.js";
import { startGui } from "../src/ui/gui.js";
import { piLogPath } from "../src/paths.js";
import { FIXED_TS, agentStart, assistantBlocks, userLine } from "./pi-events.js";

/** Collapse all whitespace runs to single spaces: prompts are hard-wrapped and formatting
 * ticks reflow them, so assertions match content with whitespace collapsed — a phrase wrapped
 * across lines must not break a contract check (the first landing of these tests did exactly
 * that: four red unit tests on main). */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ");
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
 * local date parts as a test-local oracle — never through datetime.ts's formatDate — so a drift
 * in the collector's day keying fails an assertion instead of matching its own format. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Write events.jsonl under a fixture root's .tumwater/log/ (strings pass through verbatim —
 * for malformed lines; objects are JSON-encoded like logEvent writes them). */
/** Stamp a marker/request file the way tests simulate CLI/operator side effects: create the
 * parent directories, then write `value` as compact JSON directly to `file` with a plain
 * writeFileSync (not the CLI's tmp+rename pretty-printed writeJsonFile path). The only
 * contract that matters is that the orchestrator's readers can parse the bytes. */
export function writeMarker(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

export function writeEvents(root: string, lines: unknown[]): void {
  const file = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
}

/** Write a synthetic pi session log of `turns` complete runs — the fixture most transcript
 * and tail tests need: run i is agentStart, userLine(`prompt ${i}`) at FIXED_TS + i·60s, and
 * assistantBlocks with text `turn ${i}`. Creates the log's directory and returns the temp root
 * and log file path. Callers that need a shape past the standard turns (a pending separator, a
 * stale marker, per-run noise) append extra lines with fs.appendFileSync instead of hand-rolling
 * the whole loop, and turn-count variants pass a different `turns`. */
export function writeTurnLog(turns: number): { root: string; file: string } {
  const root = tmpdir();
  const file = piLogPath(root, "feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= turns; i++) {
    lines.push(agentStart());
    lines.push(userLine(`prompt ${i}`, FIXED_TS + i * 60_000));
    lines.push(assistantBlocks([{ type: "text", text: `turn ${i}` }]));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { root, file };
}

/** Local wall-clock rendering of an epoch-ms timestamp as `YYYY-MM-DD HH:MM:SS` — the same
 * shape the transcript's run separators print. Test-local oracle: built from raw local date
 * parts, never through datetime.ts's formatDate/formatTime, so the transcript renderers stay
 * pinned against an implementation-independent expectation. */
export function expectedTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}


/** A real LoopRunner for one role — the constructor call every loop test repeats with the
 * same `defaultConfig()` and `"main"` trailing arguments, so those stay implied here and a
 * test states only what differs (config, base branch, abort signal). Cheap by design: the
 * constructor only loads loop state from disk and starts no processes. */
export function makeLoopRunner(
  repo: string,
  role: string,
  config: TumwaterConfig = defaultConfig(),
  mainBranch = "main",
  signal?: AbortSignal,
  sleep?: (ms: number) => Promise<void>,
): LoopRunner {
  return new LoopRunner(repo, role, config, mainBranch, signal, sleep);
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

/** How many times a fixture's test script actually ran (its appends to `counter`). Zero when
 * the counter was never written — an environmental skip ran nothing. */
export function runsOf(counter: string): number {
  try {
    return fs.readFileSync(counter, "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

// --- The fake-command machinery (writeScript/pathPrepend) lives in fake-commands.ts, beside
// the script-shim they install and the fake-* helpers (fake-pi.ts, per-test fake git/npm)
// built on them ---

// --- Live-orchestrator tier scaffolding (FAST_POLL_MS/readSamples/fastConfig/makeFastRepo/
// startLiveOrchestrator/landHead) lives in orchestrator-fixtures.ts ---

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

// --- Counting fs.readFileSync stub (the stat-keyed-cache tests) ---

/** Swap fs.readFileSync for a pass-through that counts matching reads for the duration of
 * `body`, then restore the original — the idiom behind the stat-keyed-cache tests, which
 * assert that a warm cache costs zero reads and a miss exactly one. `match` filters what
 * counts (default: every read); snapshot tests use it to count one state file's reads while
 * the reader touches many. `body` may call the live `readSoFar` getter to assert mid-body —
 * an assertion placed after `body` would also count the reads its own calls trigger.
 * Returns the final matching-read count. */
export function withCountedReads(
  body: (readSoFar: () => number) => void,
  match: (file: unknown) => boolean = () => true,
): number {
  let reads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      if (match(args[0])) reads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    body(() => reads);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }
  return reads;
}

// --- CLI binary scaffolding (cli/cliWithEnv/spawnCli/exitCode) lives in cli-harness.ts ---
// --- The fake pi shim (fakePi/fakePiIdle/recordingFakePi/piRunResult) lives in fake-pi.ts ---

/** Every event of one type in the repo's harness event log. This was the dominant way tests
 * consumed the log — `readEvents(x).filter((e) => e.type === "...")` appeared well over a hundred
 * times — so the filter lives here once and each call site names just the type it wants. */
export function eventsOfType(root: string, type: HarnessEvent["type"]): HarnessEvent[] {
  return readEvents(root).filter((e) => e.type === type);
}

/** The harness's own warnings (loop "harness") — the events tests assert on when pinning that a
 * misbehavior was reported instead of silently swallowed. */
export function harnessWarnings(root: string): HarnessEvent[] {
  return eventsOfType(root, "warning").filter((e) => e.loop === "harness");
}

