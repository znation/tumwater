import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { readBuildInfo } from "../src/build-info.js";
import { compileStaged, swapDist } from "../src/build-stage.js";
import { ensureDetachedWorktree } from "../src/worktree.js";
import { mirrorWorktreePath, stagingDir, stagingRootDir } from "../src/paths.js";
import { makeRepo, sh, tmpdir } from "./repo-fixtures.js";

// The build-stage helpers (src/build-stage.ts) — the redeploy's real filesystem effects, exercised
// against temp projects: swapDist's dist replacement and restore-on-failure invariants, and
// compileStaged's real tsc runs (stamping, toolchain discovery, spawn failures, timeouts). The
// redeployer's state machine itself stays in test/redeploy.test.ts, driven by scripted effects.
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

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

test("swapDist throws when the staged build cannot land and leaves nothing half-swapped", () => {
  // The catch's restore path needs a live dist to put back; with none, the failure must still
  // propagate (the Redeployer blocks on it) without touching the staged build. A regular file in
  // the dist path's ancestry makes the rename fail ENOTDIR.
  const root = tmpdir();
  fs.mkdirSync(stagingDir(root, HEAD_B), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(root, HEAD_B), "new.js"), "new");
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "a file where a directory must be");
  assert.throws(() => swapDist(root, path.join(blocker, "sub", "dist"), HEAD_B), /ENOTDIR|not a directory/);
  assert.ok(
    fs.existsSync(path.join(stagingDir(root, HEAD_B), "new.js")),
    "the staged build is untouched when nothing was moved aside",
  );
});

test("swapDist puts the old dist back when the staged rename fails after stepping it aside", (t) => {
  // The module's invariant: dist/ is never left missing. The previous test only covers a live
  // dist being absent; here one exists and the second rename (staged -> dist) fails, so the
  // catch's restore branch (prev -> dist) must run before the error propagates. A rename mock
  // fails exactly that step, the way a cross-device or permissions error would.
  const root = tmpdir();
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "old.js"), "old");
  const staged = stagingDir(root, HEAD_B);
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "new.js"), "new");

  const real = fs.renameSync as (src: fs.PathLike, dest: fs.PathLike) => void;
  t.mock.method(fs, "renameSync", ((src: fs.PathLike, dest: fs.PathLike) => {
    if (path.resolve(String(src)) === path.resolve(staged)) throw new Error("EACCES: simulated rename failure");
    return real(src, dest);
  }) as typeof fs.renameSync);
  try {
    assert.throws(() => swapDist(root, dist, HEAD_B), /simulated rename failure/);
  } finally {
    t.mock.restoreAll();
  }

  assert.deepEqual(fs.readdirSync(dist), ["old.js"], "the old build is put back before the error propagates");
  assert.ok(fs.existsSync(path.join(staged, "new.js")), "the staged build survives for a retry");
  assert.ok(!fs.existsSync(path.join(stagingRootDir(root), "dist.prev")), "the stepped-aside tree is gone, not left behind");
});

test("swapDist names the lost dist and its dist.prev backup when even the restore fails", (t) => {
  // The restore itself can fail (a rename racing an unrelated fs change): the old behavior
  // threw the restore's raw error alone, which never says dist/ is now MISSING or that the
  // old build sits at dist.prev — exactly what an operator recovering a wedged self-redeploy
  // needs. The message must carry both errors, the head, and the backup path.
  const root = tmpdir();
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "old.js"), "old");
  const staged = stagingDir(root, HEAD_B);
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "new.js"), "new");
  const prev = path.join(stagingRootDir(root), "dist.prev");

  const real = fs.renameSync as (src: fs.PathLike, dest: fs.PathLike) => void;
  t.mock.method(fs, "renameSync", ((src: fs.PathLike, dest: fs.PathLike) => {
    if (path.resolve(String(src)) === path.resolve(staged)) throw new Error("EACCES: simulated rename failure");
    if (path.resolve(String(dest)) === path.resolve(dist)) throw new Error("EIO: simulated restore failure");
    return real(src, dest);
  }) as typeof fs.renameSync);
  try {
    assert.throws(
      () => swapDist(root, dist, HEAD_B),
      (err: unknown) => {
        const message = String((err as Error).message);
        return (
          /simulated rename failure/.test(message) &&
          /simulated restore failure/.test(message) &&
          message.includes("dist is missing") &&
          message.includes(prev)
        );
      },
    );
  } finally {
    t.mock.restoreAll();
  }

  assert.ok(!fs.existsSync(dist), "dist is left missing when the restore also failed");
  assert.ok(fs.existsSync(path.join(prev, "old.js")), "the old build is where the message says it is");
});

test("swapDist retries transient directory races on dist.prev instead of aborting the redeploy", (t) => {
  // BUGS.md 2026-09-18: a transient ENOTEMPTY on dist.prev (an entry appearing between
  // rmSync's walk and its rmdir — Spotlight, .DS_Store) threw and blocked the restart. The
  // fix routes the swap's recursive deletes through removeTree, which passes Node's retry
  // options; this pins that dist.prev specifically is cleared with retries enabled.
  const root = tmpdir();
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "old.js"), "old");
  fs.mkdirSync(stagingDir(root, HEAD_B), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(root, HEAD_B), "new.js"), "new");

  const prevRemovals: fs.RmOptions[] = [];
  const real = fs.rmSync as (p: fs.PathLike, o?: fs.RmOptions) => void;
  t.mock.method(fs, "rmSync", ((p: fs.PathLike, opts?: fs.RmOptions) => {
    if (String(p).endsWith("dist.prev")) prevRemovals.push(opts ?? {});
    return real(p, opts);
  }) as typeof fs.rmSync);
  try {
    swapDist(root, dist, HEAD_B);
  } finally {
    t.mock.restoreAll();
  }

  assert.ok(prevRemovals.length > 0, "the swap clears dist.prev");
  for (const opts of prevRemovals) {
    assert.ok((opts.maxRetries ?? 0) > 0, "dist.prev removal retries a transient ENOTEMPTY");
    assert.ok((opts.retryDelay ?? 0) > 0, "retries are spaced out");
  }
  assert.deepEqual(fs.readdirSync(dist), ["new.js"], "the swap still lands the new build");
});

test("compileStaged compiles the mirror worktree with the project's tsc and stamps the result", async () => {
  // A tiny self-contained TS project whose node_modules borrows this repo's typescript.
  const root = makeRepo();
  const head = tinyTsProject(root);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(typescriptDir(), path.join(root, "node_modules/typescript"));
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  // A stale staging dir left by an earlier attempt at the same head (an interrupted run, a
  // crashed compile) is replaced before the compile, never merged with: nothing it held may
  // survive into the fresh build.
  fs.mkdirSync(stagingDir(root, head), { recursive: true });
  fs.writeFileSync(path.join(stagingDir(root, head), "stale.js"), "old\n");
  const result = await compileStaged(root, mirror, head);
  assert.deepEqual(result, { ok: true, detail: "" });
  const staged = stagingDir(root, head);
  assert.ok(fs.existsSync(path.join(staged, "src/a.js")), "compiled output lands in the staging dir");
  assert.equal(fs.existsSync(path.join(staged, "stale.js")), false, "the fresh compile wiped the stale dir, not merged with it");
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
  // tsc still emits output for code that merely has type errors, so a failed compile leaves
  // partial files in the staging dir — but never a stamp: ok:true and the stamp stand or fall
  // together, so nothing downstream can mistake a failed attempt's dir for a real build.
  assert.ok(fs.existsSync(path.join(stagingDir(root, bad), "src/a.js")), "the failed compile still emits partial output");
  assert.equal(readBuildInfo(stagingDir(root, bad)), null, "a failed compile leaves the staging dir unstamped");
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
  assert.equal(result.rejected, true, "a missing toolchain is a rejection, not a compiler verdict");
});

test("compileStaged reports a spawn failure as a rejection, not a verdict about the tree", async () => {
  // A mirror worktree that vanished (or a node binary an upgrade replaced) makes the spawn
  // itself fail with ENOENT and empty streams: the compile never ran, so the result must say so
  // instead of reading as `tsc exited ENOENT` — a compiler verdict about the commit that never
  // got one (BUGS.md 2026-09-28).
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(typescriptDir(), path.join(root, "node_modules/typescript"));
  const result = await compileStaged(root, path.join(root, "mirror-went-away"), "f".repeat(40));
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.match(result.detail, /could not start the compile/);
});

test("compileStaged reports a timeout instead of hanging when tsc runs past its cap", async () => {
  // The redeploy's only guard against a wedged compiler: a tsc that never returns must fail the
  // compile with a clear reason (so the stale build keeps running with `restart BLOCKED: tsc timed
  // out`) rather than hang the drain forever. `timeoutMs` is the seam that lets the 5-minute
  // production cap be exercised at all; a 1 ms cap guarantees the (slow-to-start) tsc is killed.
  const root = makeRepo();
  const head = tinyTsProject(root);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(typescriptDir(), path.join(root, "node_modules/typescript"));
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  const result = await compileStaged(root, mirror, head, 1);
  assert.deepEqual(result, { ok: false, detail: "tsc timed out after 0.001s" });
});

test("compileStaged still names the exit code when tsc fails without any output", async () => {
  // The detail's tail is optional: a compiler that dies silently (OOM-kill shim, broken
  // install printing nothing) must not produce an empty "tsc exited" message — the exit code
  // alone is what the redeploy state machine surfaces as `restart BLOCKED: …`.
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules/typescript/bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/typescript/bin/tsc"), "process.exit(7);\n");
  const result = await compileStaged(root, root, "e".repeat(40));
  assert.deepEqual(result, { ok: false, detail: "tsc exited 7" });
});
