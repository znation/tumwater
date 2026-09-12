import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { HarnessEventInput } from "../src/events.js";
import type { BuildStaleness } from "../src/build-info.js";
import { readBuildInfo } from "../src/build-info.js";
import { checkMainBaseline } from "../src/build-check.js";
import {
  autoRestartRecord,
  compileStaged,
  mainIsGreen,
  type AutoRestartRecord,
  type RedeployDeps,
  Redeployer,
  RESTART_COOLDOWN_MS,
  RESTART_EXIT_CODE,
  swapDist,
} from "../src/redeploy.js";
import { ensureDetachedWorktree } from "../src/worktree.js";
import { autoRestartStampPath, mirrorWorktreePath, stagingDir, stagingRootDir } from "../src/paths.js";
import { makeRepo, sh, tmpdir } from "./util.js";

// The self-redeploy policy (src/redeploy.ts): drive the state machine with scripted effects so
// every decision branch — stale detection, red main, compile failure, drain, swap — is pinned
// without git, tsc, or a fleet; then the real compile/swap/green-check helpers against a temp
// project, since those are exactly the parts that touch the filesystem and the toolchain.

const BUILD = { sha: "a".repeat(40), builtAt: 1, root: "/proj" };
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

/** A controllable deps object: each effect resolves when the test says so. */
function fakeDeps(over: Partial<RedeployDeps> & { stale?: BuildStaleness | null } = {}) {
  const calls = { compile: [] as string[], swap: [] as string[], green: [] as string[] };
  let resolveGreen: ((v: boolean) => void) | null = null;
  let resolveCompile: ((v: { ok: boolean; detail: string }) => void) | null = null;
  const deps: RedeployDeps = {
    staleness: async () => over.stale ?? { stale: true, aheadCommits: 3 },
    mainGreen: (h) => {
      calls.green.push(h);
      return new Promise((r) => (resolveGreen = r));
    },
    compile: (h) => {
      calls.compile.push(h);
      return new Promise((r) => (resolveCompile = r));
    },
    swap: (h) => {
      calls.swap.push(h);
    },
    ...over,
  };
  return {
    deps,
    calls,
    green(v: boolean) {
      resolveGreen?.(v);
    },
    compiled(ok: boolean, detail = "") {
      resolveCompile?.({ ok, detail });
    },
  };
}

function harness(deps: RedeployDeps, selfHosted = true, drainMaxMs?: number, restartRecord?: AutoRestartRecord) {
  const events: HarnessEventInput[] = [];
  const r = new Redeployer(BUILD, selfHosted, deps, (e) => events.push(e), drainMaxMs, restartRecord);
  return { r, events, types: () => events.map((e) => e.type) };
}

/** Let the tracked background promises settle (one macrotask is enough). */
const settle = () => new Promise((r) => setTimeout(r, 5));

const IDLE = { roleInFlight: 0, directorInFlight: 0 };

/** Drive one episode (green → compile → idle swap) to its completed restart; returns the `now`
 * at which it landed — the cooldown's start for what follows. */
async function driveToRestart(r: Redeployer, f: ReturnType<typeof fakeDeps>, head: string, startNow: number): Promise<number> {
  let t = startNow;
  assert.equal(await r.poll(head, IDLE, true, t), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(head, IDLE, true, (t += 10)), "hold", "green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(head, IDLE, true, (t += 10)), "restart", "idle: swap and go");
  return t;
}

/** This repo's typescript package, resolved the way node itself resolves it — climbing ancestor
 * node_modules from the running test file. Hard-coding `<this checkout>/node_modules/typescript`
 * instead is what broke the fleet on 2026-09-08: no tumwater worktree has an install of its own
 * (node_modules is gitignored), so the symlink dangled, the compile test below failed in every
 * loop worktree, main read red fleet-wide, and the harness could not restart itself (BUGS.md). */
function typescriptDir(): string {
  return path.dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
}

/** A tiny self-contained TS project committed to `root`'s main; returns its head. */
function tinyTsProject(root: string, body = "export const answer: number = 42;\n"): string {
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: ".", strict: true, types: [] }, include: ["src/**/*.ts"] }),
  );
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a.ts"), body);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "tiny project");
  return sh(root, "git", "rev-parse", "HEAD");
}

/** How many times a fixture's check script ran (its appends to `counter`). */
function runsOf(counter: string): number {
  return fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim().split("\n").length : 0;
}

test("a non-self-hosted harness never acts, whatever main does", async () => {
  const f = fakeDeps();
  const { r, events } = harness(f.deps, false);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(events, []);
  assert.deepEqual(r.status(), { sha: BUILD.sha, builtAt: 1 }, "no staleness verdict is ever computed");
});

test("a fresh build reports not stale and takes no action", async () => {
  const f = fakeDeps({ stale: { stale: false, aheadCommits: 2 } });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(events, []);
  assert.deepEqual(r.status(), { sha: BUILD.sha, builtAt: 1, stale: false, aheadCommits: 2, checkedHead: HEAD_B });
});

test("stale + autoRestart off: one build_stale event, staleness published, no restart", async () => {
  const f = fakeDeps();
  const { r, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, false), "none");
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, false), "none", "the verdict is cached per head");
  assert.deepEqual(types(), ["build_stale"], "one event per newly stale head, not one per poll");
  assert.equal(r.status().stale, true);
  assert.deepEqual(f.calls.green, [], "no green check without autoRestart");
});

test("the happy path: hold through the green check and compile, then restart when idle", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold", "the drain starts while the green check runs");
  assert.deepEqual(f.calls.green, [HEAD_B]);
  assert.equal(r.status().restartPending, true, "a stale build with a restart under way says so");
  assert.equal(r.status().restartBlocked, undefined);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold", "green: the compile starts");
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.deepEqual(types(), ["build_stale", "restart_pending"]);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 2, directorInFlight: 0 }, true), "hold", "compiled but ticks still in flight");
  assert.deepEqual(f.calls.swap, []);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "restart", "idle: swap and go");
  assert.deepEqual(f.calls.swap, [HEAD_B]);
  const restart = events.at(-1)!;
  assert.equal(restart.type, "restart");
  assert.equal(restart.from, BUILD.sha);
  assert.equal(restart.to, HEAD_B);
  assert.equal(restart.abortedTicks, 0);
});

test("the drain cap aborts in-flight ticks: restart anyway, counting them", async () => {
  const f = fakeDeps();
  const { r, events } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, now), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 10)), "hold");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 500)), "hold", "inside the drain window");
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 600)), "restart", "past it: the caller aborts them");
  assert.equal(events.at(-1)!.abortedTicks, 3);
  assert.equal(events.at(-1)!.drainedMs, 1110);
});

test("a director tick in flight holds past the drain window without a cap; the swap lands once it clears", async () => {
  // The 2026-09-08 incident: median ticks run ~35 min, so a long director prompt routinely
  // outlived the 30-minute drain and was aborted mid-task. A human prompt outranks the redeploy:
  // no swap and no abort until it finishes (BUGS.md).
  const f = fakeDeps();
  const { r, events } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 1 }, true, now), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 1 }, true, (now += 50)), "hold");
  f.compiled(true);
  await settle();
  // Far past the window with the prompt still running — a role tick would have been aborted here.
  assert.equal(
    await r.poll(HEAD_B, { roleInFlight: 1, directorInFlight: 1 }, true, (now += 5000)),
    "hold",
    "the director extends the hold without a cap",
  );
  // The prompt finishes; one role tick is still running but its window is long gone — it lands now.
  assert.equal(
    await r.poll(HEAD_B, { roleInFlight: 1, directorInFlight: 0 }, true, (now += 10)),
    "restart",
    "only then does the restart land",
  );
  const ev = events.at(-1)!;
  assert.equal(ev.abortedTicks, 1, "the remaining role tick is counted; the finished director is not");
  assert.ok(Number(ev.drainedMs) > 5000, `a director-extended hold reports its true length (${String(ev.drainedMs)}ms)`);
});

test("a main move during the drain does not restart the clock: the same ticks get one window", async () => {
  // A busy self-hosting fleet merges while it drains — the 2026-09-08 restart superseded its
  // pending head once and then held for 38 minutes under a 30-minute cap (BUGS.md). Nothing new
  // starts during a hold, so the ticks the drain waits on are the ones it began with; a new head
  // inherits the window rather than opening its own.
  const f = fakeDeps();
  const { r, events } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, now), "hold", "the drain starts here");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 400)), "hold");
  f.compiled(true);
  await settle();
  // 800 ms in, main moves: the pending restart is superseded, the drain is not.
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 400)), "hold");
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 100)), "hold", "the new head still needs its own compile");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 200)), "restart", "past the original deadline, not a fresh one");
  assert.deepEqual(f.calls.swap, [HEAD_C], "and it is the new head's build that goes in");
  assert.equal(events.at(-1)!.drainedMs, 1100, "reported from the first hold, not the last head");
});

test("a blocked restart ends the drain: the next one gets its clock back", async () => {
  const f = fakeDeps();
  const { r } = harness(f.deps, true, 1000);
  let now = 100_000;
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, now), "hold");
  f.green(false);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 400)), "none", "red: the fleet schedules again");
  // Main moves long after the old cap would have expired; the new drain still gets its window.
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 5000)), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 10)), "hold");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 10)), "hold", "inside the NEW window, not the abandoned one");
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, (now += 1000)), "restart");
});

test("a red main blocks the restart for that head with one warning; a moved main retries", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "hold");
  f.green(false);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(types(), ["build_stale", "warning"]);
  assert.match(String(events[1]!.message), /is red — holding the restart/);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none", "blocked: no second green check for the same head");
  assert.deepEqual(f.calls.green, [HEAD_B]);
  // Published, not just warned about once: nothing will change until main moves, and a bare
  // `stale: true` cannot be told apart from a restart that is seconds away (BUGS.md).
  assert.equal(r.status().restartBlocked, "main bbbbbbbb is red");
  assert.equal(r.status().restartPending, undefined, "blocked and pending are mutually exclusive");
  // Main moves (a fix landed): the new head gets its own green check.
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 0, directorInFlight: 0 }, true), "hold");
  assert.equal(r.status().restartBlocked, undefined, "the new head starts clean");
  assert.equal(r.status().restartPending, true);
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  assert.deepEqual(types(), ["build_stale", "warning"], "still stale relative to the same build: no second build_stale");
});

test("a failed compile keeps the old build running and warns once", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.compiled(false, "tsc exited 2: src/x.ts(1,1): error TS1005");
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.deepEqual(types(), ["build_stale", "restart_pending", "warning"]);
  assert.match(String(events.at(-1)!.message), /rebuild of bbbbbbbb failed — staying on build aaaaaaaa: tsc exited 2/);
  assert.equal(r.status().restartBlocked, "rebuild of bbbbbbbb failed");
  assert.deepEqual(f.calls.swap, []);
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none", "and stays blocked for this head");
});

test("a swap failure is reported and blocks like a compile failure", async () => {
  const f = fakeDeps({
    swap: () => {
      throw new Error("EACCES: dist is read-only");
    },
  });
  const { r, events } = harness(f.deps);
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true), "none");
  assert.match(String(events.at(-1)!.message), /swapping the new build into place failed: EACCES/);
  assert.equal(r.status().restartBlocked, "swapping the new build into place failed");
});

test("main moving during a pending restart supersedes it: the new head is evaluated afresh", async () => {
  const f = fakeDeps();
  const { r } = harness(f.deps);
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, { roleInFlight: 0, directorInFlight: 0 }, true); // compiling HEAD_B
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 0, directorInFlight: 0 }, true), "hold", "new head: a new green check, not a swap of the old compile");
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  f.compiled(true); // HEAD_B's compile finishing late changes nothing
  await settle();
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 0, directorInFlight: 0 }, true), "hold");
  assert.deepEqual(f.calls.swap, [], "the superseded build is never swapped in");
});

test("within the cooldown a second stale episode is deferred: no hold, status carries the deadline", async () => {
  // The 2026-09-11 churn complaint in miniature: main moves again an hour after a completed
  // swap — inside the 12 h window the fleet keeps ticking on the stale build instead of holding
  // for another drain (BUGS.md).
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(
    await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, swappedAt + 60 * 60_000),
    "none",
    "no hold: ticks continue on the stale build",
  );
  assert.deepEqual(f.calls.green, [HEAD_B], "no green check for the deferred head");
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  const status = r.status(swappedAt + 60 * 60_000);
  assert.equal(status.stale, true, "staleness stays visible");
  assert.equal(
    status.restartBlocked,
    `cooldown until ${new Date(swappedAt + RESTART_COOLDOWN_MS).toISOString()}`,
    "the deadline is published through the restartBlocked channel",
  );
  assert.equal(status.restartPending, undefined);
  // One warning per episode, not one per poll.
  assert.equal(await r.poll(HEAD_C, { roleInFlight: 3, directorInFlight: 0 }, true, swappedAt + 61 * 60_000), "none");
  const warnings = events.filter((e) => e.type === "warning");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]!.message), /cooldown until/);
  assert.deepEqual(types(), ["build_stale", "restart_pending", "restart", "warning"]);
});

test("past the cooldown deadline the same head proceeds to a restart without main moving again", async () => {
  // Re-evaluated on every poll rather than latched like blockedHead: once the deadline passes,
  // the current head proceeds even if main never moves again (BUGS.md 2026-09-11).
  const f = fakeDeps();
  const { r } = harness(f.deps);
  const swappedAt = await driveToRestart(r, f, HEAD_B, 1_000_000);
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS - 1), "none", "one ms short of the deadline still defers");
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS),
    "hold",
    "past it: the new episode starts its green check",
  );
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 10), "hold", "green: the compile starts");
  f.compiled(true);
  await settle();
  assert.equal(
    await r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS + 20),
    "restart",
    "the second restart lands past the deadline",
  );
  assert.deepEqual(f.calls.swap, [HEAD_B, HEAD_C]);
});

test("the completion timestamp survives process restart via its state file", async () => {
  // Auto-restart kills the orchestrator and the supervisor respawns it — the cooldown's start
  // must outlive that exit, so it lives in its own state file, not orchestrator.json (BUGS.md).
  const root = tmpdir();
  assert.equal(autoRestartRecord(root).lastAt, null, "a missing file reads as no completed restart yet");
  const f1 = fakeDeps();
  const h1 = harness(f1.deps, true, undefined, autoRestartRecord(root));
  const swappedAt = await driveToRestart(h1.r, f1, HEAD_B, 2_000_000);
  assert.ok(fs.existsSync(autoRestartStampPath(root)), "the timestamp is written on swap");

  // A second process: a fresh Redeployer reading the same file honors the cooldown...
  const f2 = fakeDeps();
  const h2 = harness(f2.deps, true, undefined, autoRestartRecord(root));
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, swappedAt + 60 * 60_000), "none", "the respawned process defers the second episode");
  assert.match(String(h2.r.status(swappedAt + 60 * 60_000).restartBlocked ?? ""), /cooldown until/);
  // ...and past the deadline it proceeds, overwriting the file with the new completion.
  const secondSwap = swappedAt + RESTART_COOLDOWN_MS + 20;
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, swappedAt + RESTART_COOLDOWN_MS), "hold", "past the deadline: the green check starts");
  f2.green(true);
  await settle();
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, secondSwap - 10), "hold", "green: the compile starts");
  f2.compiled(true);
  await settle();
  assert.equal(await h2.r.poll(HEAD_C, IDLE, true, secondSwap), "restart");
  const stored = JSON.parse(fs.readFileSync(autoRestartStampPath(root), "utf8")) as { at: number };
  assert.equal(stored.at, secondSwap, "the file holds the LATEST completion for the next process");
});

test("RESTART_EXIT_CODE is EX_TEMPFAIL, distinct from success, fail(), and a forced Ctrl+C", () => {
  assert.equal(RESTART_EXIT_CODE, 75);
});

// ── Real effects ───────────────────────────────────────────────────────────────────────────

test("swapDist replaces dist with the staged build, restores on failure, and cleans other stagings", () => {
  const root = tmpdir();
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "old.js"), "old");
  const staged = stagingDir(root, HEAD_B);
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "new.js"), "new");
  fs.mkdirSync(stagingDir(root, HEAD_C), { recursive: true }); // a superseded staging
  swapDist(root, dist, HEAD_B);
  assert.deepEqual(fs.readdirSync(dist), ["new.js"]);
  assert.deepEqual(fs.readdirSync(stagingRootDir(root)), [], "prev and superseded stagings are gone");
  assert.throws(() => swapDist(root, dist, HEAD_C), /no staged build for cccccccc/);
  assert.deepEqual(fs.readdirSync(dist), ["new.js"], "a failed swap leaves dist untouched");
});

test("compileStaged compiles the mirror worktree with the project's tsc and stamps the result", async () => {
  // A tiny self-contained TS project whose node_modules borrows this repo's typescript.
  const root = makeRepo();
  const head = tinyTsProject(root);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(typescriptDir(), path.join(root, "node_modules/typescript"));
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  const result = await compileStaged(root, mirror, head);
  assert.deepEqual(result, { ok: true, detail: "" });
  const staged = stagingDir(root, head);
  assert.ok(fs.existsSync(path.join(staged, "src/a.js")), "compiled output lands in the staging dir");
  assert.equal(readBuildInfo(staged)?.sha, head, "stamped with the compiled head");
  assert.equal(readBuildInfo(staged)?.root, path.resolve(root), "the stamp names the project root, not the mirror");

  // A type error fails the compile with the compiler's tail in the detail.
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const answer: number = 'no';\n");
  sh(root, "git", "commit", "-q", "-am", "break it");
  const bad = sh(root, "git", "rev-parse", "HEAD");
  const mirror2 = await ensureDetachedWorktree(root, mirrorWorktreePath(root), bad);
  const failed = await compileStaged(root, mirror2, bad);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /tsc exited 2.*TS2322/);
});

test("compileStaged borrows an ancestor's typescript: a project with no install of its own still rebuilds", async () => {
  // The shape of every tumwater worktree — no node_modules of its own, an installed root above
  // it — and the case that must not fail closed: demanding a local install here is what left
  // the fleet unable to compile its own new build (BUGS.md).
  const outer = tmpdir();
  fs.mkdirSync(path.join(outer, "node_modules"));
  fs.symlinkSync(typescriptDir(), path.join(outer, "node_modules/typescript"));
  const root = makeRepo(path.join(outer, "nested", "project"));
  const head = tinyTsProject(root);
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  assert.deepEqual(await compileStaged(root, mirror, head), { ok: true, detail: "" });
  assert.ok(fs.existsSync(path.join(stagingDir(root, head), "src/a.js")));
});

test("compileStaged without typescript installed anywhere above the project fails closed with a clear reason", async () => {
  const root = makeRepo();
  const result = await compileStaged(root, root, "d".repeat(40));
  assert.equal(result.ok, false);
  assert.match(result.detail, /typescript is not installed/);
});

test("mainIsGreen: no declared check reads as green", async () => {
  const root = makeRepo();
  const head = sh(root, "git", "rev-parse", "HEAD");
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  // No package.json anywhere up the tree of this temp repo: nothing to verify, nothing to block on.
  assert.equal(await mainIsGreen(mirror), true);
});

test("mainIsGreen re-verifies another worktree's red in the mirror, and its green promotes the SHA fleet-wide", async () => {
  // The 2026-09-08 failure in miniature: one worktree's ENVIRONMENT, not the tree, decides the
  // verdict — here a `marker` file standing in for the missing node_modules. A red from such a
  // worktree must not be what blocks the harness's own restart (BUGS.md).
  const counter = path.join(tmpdir(), "runs");
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "proj",
      version: "1.0.0",
      scripts: { test: `echo run >> ${counter}; node -e "process.exit(require('fs').existsSync('marker') ? 0 : 1)"` },
    }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker detectBuildCheck walks up to
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "project");
  const head = sh(root, "git", "rev-parse", "HEAD");

  // A role worktree without the marker judges main red and caches that verdict.
  const role = path.join(root, ".tumwater", "worktrees", "role");
  fs.mkdirSync(path.dirname(role), { recursive: true });
  sh(root, "git", "worktree", "add", "-q", "--detach", role, head);
  assert.equal((await checkMainBaseline(role)).baseline?.status, "red");

  // The redeploy gate's mirror, where the same tree passes: it re-runs instead of inheriting.
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  fs.writeFileSync(path.join(mirror, "marker"), "");
  assert.equal(await mainIsGreen(mirror), true, "the red is re-verified here, not believed");
  assert.equal(runsOf(counter), 2);

  assert.equal(await mainIsGreen(mirror), true);
  assert.equal(runsOf(counter), 2, "a cached green short-circuits — re-verification is for reds only");
  assert.equal(
    (await checkMainBaseline(role)).baseline?.status,
    "green",
    "and the green promotes the SHA for every other gate, unblocking the role loops too",
  );
  assert.equal(runsOf(counter), 2, "the promotion re-runs nothing");
});

test("ensureDetachedWorktree pins the mirror at a ref and re-points an existing one", async () => {
  const root = makeRepo();
  const first = sh(root, "git", "rev-parse", "HEAD");
  const dir = mirrorWorktreePath(root);
  assert.equal(await ensureDetachedWorktree(root, dir, first), dir);
  assert.equal(sh(dir, "git", "rev-parse", "HEAD"), first);
  fs.writeFileSync(path.join(root, "seed.txt"), "moved\n");
  sh(root, "git", "commit", "-q", "-am", "move main");
  const second = sh(root, "git", "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "stray.txt"), "stray"); // dirt in the mirror is discarded
  await ensureDetachedWorktree(root, dir, second);
  assert.equal(sh(dir, "git", "rev-parse", "HEAD"), second);
  assert.equal(fs.existsSync(path.join(dir, "stray.txt")), false);
  assert.equal(fs.readFileSync(path.join(dir, "seed.txt"), "utf8"), "moved\n");
});
