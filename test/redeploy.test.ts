import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { HarnessEventInput } from "../src/events.js";
import type { BuildStaleness } from "../src/build-info.js";
import { readBuildInfo } from "../src/build-info.js";
import { noteGreenBaseline } from "../src/build-check.js";
import {
  compileStaged,
  mainIsGreen,
  type RedeployDeps,
  Redeployer,
  RESTART_EXIT_CODE,
  swapDist,
} from "../src/redeploy.js";
import { ensureDetachedWorktree } from "../src/git.js";
import { mirrorWorktreePath, stagingDir, stagingRootDir } from "../src/paths.js";
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

function harness(deps: RedeployDeps, selfHosted = true, drainMaxMs?: number) {
  const events: HarnessEventInput[] = [];
  const r = new Redeployer(BUILD, selfHosted, deps, (e) => events.push(e), drainMaxMs);
  return { r, events, types: () => events.map((e) => e.type) };
}

/** Let the tracked background promises settle (one macrotask is enough). */
const settle = () => new Promise((r) => setTimeout(r, 5));

test("a non-self-hosted harness never acts, whatever main does", async () => {
  const f = fakeDeps();
  const { r, events } = harness(f.deps, false);
  assert.equal(await r.poll(HEAD_B, 0, true), "none");
  assert.deepEqual(events, []);
  assert.deepEqual(r.status(), { sha: BUILD.sha, builtAt: 1 }, "no staleness verdict is ever computed");
});

test("a fresh build reports not stale and takes no action", async () => {
  const f = fakeDeps({ stale: { stale: false, aheadCommits: 2 } });
  const { r, events } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, 0, true), "none");
  assert.deepEqual(events, []);
  assert.deepEqual(r.status(), { sha: BUILD.sha, builtAt: 1, stale: false, aheadCommits: 2, checkedHead: HEAD_B });
});

test("stale + autoRestart off: one build_stale event, staleness published, no restart", async () => {
  const f = fakeDeps();
  const { r, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, 0, false), "none");
  assert.equal(await r.poll(HEAD_B, 0, false), "none", "the verdict is cached per head");
  assert.deepEqual(types(), ["build_stale"], "one event per newly stale head, not one per poll");
  assert.equal(r.status().stale, true);
  assert.deepEqual(f.calls.green, [], "no green check without autoRestart");
});

test("the happy path: hold through the green check and compile, then restart when idle", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, 2, true), "hold", "the drain starts while the green check runs");
  assert.deepEqual(f.calls.green, [HEAD_B]);
  assert.equal(await r.poll(HEAD_B, 2, true), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, 2, true), "hold", "green: the compile starts");
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.deepEqual(types(), ["build_stale", "restart_pending"]);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, 2, true), "hold", "compiled but ticks still in flight");
  assert.deepEqual(f.calls.swap, []);
  assert.equal(await r.poll(HEAD_B, 0, true), "restart", "idle: swap and go");
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
  assert.equal(await r.poll(HEAD_B, 3, true, now), "hold");
  f.green(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, 3, true, (now += 10)), "hold");
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, 3, true, (now += 500)), "hold", "inside the drain window");
  assert.equal(await r.poll(HEAD_B, 3, true, (now += 600)), "restart", "past it: the caller aborts them");
  assert.equal(events.at(-1)!.abortedTicks, 3);
  assert.equal(events.at(-1)!.drainedMs, 1110);
});

test("a red main blocks the restart for that head with one warning; a moved main retries", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  assert.equal(await r.poll(HEAD_B, 0, true), "hold");
  f.green(false);
  await settle();
  assert.equal(await r.poll(HEAD_B, 0, true), "none");
  assert.deepEqual(types(), ["build_stale", "warning"]);
  assert.match(String(events[1]!.message), /is red — holding the restart/);
  assert.equal(await r.poll(HEAD_B, 0, true), "none", "blocked: no second green check for the same head");
  assert.deepEqual(f.calls.green, [HEAD_B]);
  // Main moves (a fix landed): the new head gets its own green check.
  assert.equal(await r.poll(HEAD_C, 0, true), "hold");
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  assert.deepEqual(types(), ["build_stale", "warning"], "still stale relative to the same build: no second build_stale");
});

test("a failed compile keeps the old build running and warns once", async () => {
  const f = fakeDeps();
  const { r, events, types } = harness(f.deps);
  await r.poll(HEAD_B, 0, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, 0, true);
  f.compiled(false, "tsc exited 2: src/x.ts(1,1): error TS1005");
  await settle();
  assert.equal(await r.poll(HEAD_B, 0, true), "none");
  assert.deepEqual(types(), ["build_stale", "restart_pending", "warning"]);
  assert.match(String(events.at(-1)!.message), /rebuild of bbbbbbbb failed — staying on build aaaaaaaa: tsc exited 2/);
  assert.deepEqual(f.calls.swap, []);
  assert.equal(await r.poll(HEAD_B, 0, true), "none", "and stays blocked for this head");
});

test("a swap failure is reported and blocks like a compile failure", async () => {
  const f = fakeDeps({
    swap: () => {
      throw new Error("EACCES: dist is read-only");
    },
  });
  const { r, events } = harness(f.deps);
  await r.poll(HEAD_B, 0, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, 0, true);
  f.compiled(true);
  await settle();
  assert.equal(await r.poll(HEAD_B, 0, true), "none");
  assert.match(String(events.at(-1)!.message), /swapping the new build into place failed: EACCES/);
});

test("main moving during a pending restart supersedes it: the new head is evaluated afresh", async () => {
  const f = fakeDeps();
  const { r } = harness(f.deps);
  await r.poll(HEAD_B, 0, true);
  f.green(true);
  await settle();
  await r.poll(HEAD_B, 0, true); // compiling HEAD_B
  assert.deepEqual(f.calls.compile, [HEAD_B]);
  assert.equal(await r.poll(HEAD_C, 0, true), "hold", "new head: a new green check, not a swap of the old compile");
  assert.deepEqual(f.calls.green, [HEAD_B, HEAD_C]);
  f.compiled(true); // HEAD_B's compile finishing late changes nothing
  await settle();
  assert.equal(await r.poll(HEAD_C, 0, true), "hold");
  assert.deepEqual(f.calls.swap, [], "the superseded build is never swapped in");
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
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", outDir: "dist", rootDir: ".", strict: true, types: [] }, include: ["src/**/*.ts"] }),
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const answer: number = 42;\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "tiny project");
  const head = sh(root, "git", "rev-parse", "HEAD");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../node_modules/typescript"),
    path.join(root, "node_modules/typescript"),
  );
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

test("compileStaged without typescript installed fails closed with a clear reason", async () => {
  const root = makeRepo();
  const result = await compileStaged(root, root, "d".repeat(40));
  assert.equal(result.ok, false);
  assert.match(result.detail, /typescript is not installed/);
});

test("mainIsGreen: a seeded verdict is used as-is; no declared check reads as green", async () => {
  const root = makeRepo();
  const head = sh(root, "git", "rev-parse", "HEAD");
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  // No package.json anywhere up the tree of this temp repo: nothing to verify, nothing to block on.
  assert.equal(await mainIsGreen(root, mirror, head), true);
  noteGreenBaseline("e".repeat(40));
  assert.equal(await mainIsGreen(root, mirror, "e".repeat(40)), true, "cache hit: no check spawned");
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
