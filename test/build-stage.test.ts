import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { readBuildInfo } from "../src/build-info.js";
import { compileStaged, pruneStaleStagings, swapDist, STAGED_PRUNE_AFTER_MS } from "../src/build-stage.js";
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

/** Give `dir` a node_modules/typescript symlink to this repo's real typescript, so a staged
 * compile's tsc resolves the toolchain the way every tumwater worktree does — with no install
 * of its own, borrowing an ancestor's (the BUGS.md 2026-09-08 case above). The one home of
 * the mkdir+symlink pair for the tests here that stage a compilable project. */
function borrowTypeScript(dir: string): void {
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.symlinkSync(typescriptDir(), path.join(dir, "node_modules/typescript"));
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
  borrowTypeScript(root);
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

test("a successful compile prunes superseded stagings past the grace, keeping young and non-SHA entries", async () => {
  const root = makeRepo();
  const head = tinyTsProject(root);
  borrowTypeScript(root);
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  // Two superseded stagings from heads the fleet landed past: one older than the grace
  // (dead weight a blocked restart let pile up), one younger (a live episode's drain hold
  // can still swap it). A non-SHA entry — swapDist's own dist.prev scratch — is never
  // this prune's concern, however old it is.
  const old = stagingDir(root, "a".repeat(40));
  const young = stagingDir(root, "e".repeat(40));
  for (const dir of [old, young, path.join(stagingRootDir(root), "dist.prev")]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker"), "x\n");
  }
  const aged = (Date.now() - STAGED_PRUNE_AFTER_MS - 60_000) / 1000;
  fs.utimesSync(old, aged, aged);
  fs.utimesSync(path.join(stagingRootDir(root), "dist.prev"), aged, aged);

  assert.deepEqual(await compileStaged(root, mirror, head), { ok: true, detail: "" });
  assert.equal(fs.existsSync(old), false, "the superseded staging past the grace is deleted");
  assert.equal(fs.existsSync(young), true, "a staging a live episode could still swap survives");
  assert.equal(fs.existsSync(path.join(stagingRootDir(root), "dist.prev")), true, "non-SHA scratch stays for swapDist's cleanup");
  assert.ok(fs.existsSync(path.join(stagingDir(root, head), "src/a.js")), "the fresh compile itself is untouched");

  // The prune is idempotent and head-scoped when called directly: an already-gone dir is
  // skipped, and the kept dir is never its own victim.
  assert.equal(pruneStaleStagings(root, stagingDir(root, head)), 0, "nothing left past the grace to remove");
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(stagingDir(root, head)), true, "the keep dir is never its own victim");
});

test("pruneStaleStagings swallows every staging-root fault: the prune trails a successful compile and must never fail one", () => {
  // compileStaged prunes after the new build has already succeeded, so a thrown readdir,
  // stat, or rm error here would reject a perfectly good build and pin the fleet on the
  // stale dist (BUGS.md 2026-09-28's verdict-vs-rejection distinction, one step downstream).
  // Each fault below is exercised for real, against the actual filesystem: an absent staging
  // root (the first compile), entries the scan lists but cannot stat, and a stale dir whose
  // removal the filesystem refuses.
  const fresh = tmpdir();
  assert.equal(pruneStaleStagings(fresh, path.join(fresh, "dist")), 0,
    "no staging root yet — the first compile has nothing to prune and must not throw");

  const root = tmpdir();
  const stale = stagingDir(root, "a".repeat(40));
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "marker"), "x\n");
  const aged = (Date.now() - STAGED_PRUNE_AFTER_MS - 60_000) / 1000;
  fs.utimesSync(stale, aged, aged);
  const stagingRoot = stagingRootDir(root);

  // Read without search (0o400): readdir still lists the entry, but every statSync of a child
  // fails with EACCES — the "vanished (or unreadable) mid-scan" branch, no longer a race.
  fs.chmodSync(stagingRoot, 0o400);
  try {
    assert.equal(pruneStaleStagings(root, path.join(root, "dist")), 0,
      "unreadable entries are skipped in place, not fatal");
    // existsSync itself cannot search the 0o400 root, so verify through readdir instead.
    assert.ok(fs.readdirSync(stagingRoot).includes("a".repeat(40)),
      "a stat failure leaves the dir for the next compile");
  } finally {
    fs.chmodSync(stagingRoot, 0o755);
  }

  // Read and search without write (0o555): the stat now succeeds, the dir reads as stale, and
  // the removal itself fails — the "left for the next compile or swap" branch.
  fs.chmodSync(stagingRoot, 0o555);
  try {
    assert.equal(pruneStaleStagings(root, path.join(root, "dist")), 0,
      "a failed removal is swallowed, not thrown");
    assert.equal(fs.existsSync(stale), true, "the unremovable staging survives one tick longer");
  } finally {
    fs.chmodSync(stagingRoot, 0o755);
  }

  // And once the filesystem heals, the same prune removes it: the swallow never wedged anything.
  // (The failed rmSync already unlinked the marker, which freshened the dir's mtime — re-age.)
  fs.utimesSync(stale, aged, aged);
  assert.equal(pruneStaleStagings(root, path.join(root, "dist")), 1);
  assert.equal(fs.existsSync(stale), false);
});

test("compileStaged borrows an ancestor's typescript: a project with no install of its own still rebuilds", async () => {
  // The shape of every tumwater worktree — no node_modules of its own, an installed root above
  // it — and the case that must not fail closed: demanding a local install here is what left
  // the fleet unable to compile its own new build (BUGS.md).
  const outer = tmpdir();
  borrowTypeScript(outer);
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
  borrowTypeScript(root);
  const result = await compileStaged(root, path.join(root, "mirror-went-away"), "f".repeat(40));
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.match(result.detail, /could not start the compile/);
});

test("compileStaged still rebuilds through tsc's shebang when the node binary vanished under the running build", async () => {
  // The live fleet's catch-22 (BUGS.md 2026-09-29): a long-running build's process.execPath can
  // name a binary an upgrade removed, killing only the spawns that use it directly while every
  // PATH-resolved spawn (git, npm, pi) keeps working — so the fleet cannot redeploy at all. The
  // retry through tsc's own shebang (env node, resolved at spawn time) is what lets the next
  // rebuild succeed and break the pin. The stale path is injected through the execPath seam.
  const root = makeRepo();
  const head = tinyTsProject(root);
  borrowTypeScript(root);
  const mirror = await ensureDetachedWorktree(root, mirrorWorktreePath(root), head);
  const result = await compileStaged(root, mirror, head, undefined, "/nonexistent/node/removed-by-an-upgrade");
  assert.deepEqual(result, { ok: true, detail: "" }, "the shebang fallback compiled the tree");
});

test("compileStaged names every missing spawn input when the compile cannot start", async () => {
  // A spawn failure's child leaves no output, so the error carries no evidence of its own: the
  // rejection must name which of the interpreter, the cwd, and the toolchain did not exist —
  // the diagnosis the live `tsc exited ENOENT` cluster never had (BUGS.md 2026-09-29).
  const root = makeRepo();
  borrowTypeScript(root);
  const result = await compileStaged(root, path.join(root, "mirror-went-away"), "f".repeat(40), undefined, "/nonexistent/node");
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.match(result.detail, /could not start the compile/);
  assert.match(result.detail, /missing: the node binary at \/nonexistent\/node; the compile cwd at /);
});

test("compileStaged reads a tsc that died by signal as a rejection even with output attached", async () => {
  // The old condition (`code not a number AND no output`) read a non-numeric exit that carried
  // output as a compiler verdict — exactly the shape a spawn failure with buffered output would
  // latch as a false verdict about a good commit (BUGS.md 2026-09-29). A tsc that prints and
  // then dies by signal (a null exit code) proves output no longer manufactures a verdict.
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules/typescript/bin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "node_modules/typescript/bin/tsc"),
    "require('node:fs').writeSync(1, 'verdict-shaped output\\n');\nprocess.kill(process.pid, 'SIGKILL');\n",
  );
  const result = await compileStaged(root, root, "e".repeat(40));
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true, "no exit code was chosen — this is not a verdict about the tree");
  assert.match(result.detail, /signal SIGKILL/);
});

test("compileStaged reads the fallback tsc's numeric exit as a verdict, not a rejection", async () => {
  // The shebang fallback obeys the same invariant as the primary spawn: when the fallback tsc
  // runs and chooses a numeric exit, that is a compiler verdict about the tree — the
  // misclassification that read it as `rejected: true` / "could not start the compile" made the
  // redeployer drop a genuinely failing head and re-attempt it forever instead of blocking on
  // it (review objection 2026-09-29). A shebang'd shim exiting 7, reached only because the
  // injected interpreter is gone, pins the verdict shape.
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules/typescript/bin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "node_modules/typescript/bin/tsc"),
    "#!/usr/bin/env node\nprocess.exit(7);\n",
  );
  fs.chmodSync(path.join(root, "node_modules/typescript/bin/tsc"), 0o755); // the shebang spawn needs the exec bit
  const result = await compileStaged(root, root, "e".repeat(40), undefined, "/nonexistent/node");
  assert.deepEqual(result, { ok: false, detail: "tsc exited 7" });
  assert.equal(result.rejected, undefined, "a numeric exit from the fallback tsc is a verdict, never a rejection");
});

test("compileStaged reports the fallback's own spawn failure as a rejection naming both attempts", async () => {
  // When the fallback's shebang cannot resolve an interpreter either, neither attempt produced
  // a process: the rejection must say the fallback was tried and failed, not just the primary
  // spawn — an operator repairing the environment needs to know both paths are dead.
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules/typescript/bin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "node_modules/typescript/bin/tsc"),
    "#!/nonexistent/interpreter\nprocess.exit(7);\n",
  );
  fs.chmodSync(path.join(root, "node_modules/typescript/bin/tsc"), 0o755); // the EACCES shape must not mask the ENOENT one
  const result = await compileStaged(root, root, "e".repeat(40), undefined, "/nonexistent/node");
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true, "neither spawn produced a process — no verdict exists");
  assert.match(result.detail, /could not start the compile/);
  assert.match(result.detail, /shebang fallback also failed/);
});

test("compileStaged reports a timeout instead of hanging when tsc runs past its cap", async () => {
  // The redeploy's only guard against a wedged compiler: a tsc that never returns must fail the
  // compile with a clear reason (so the stale build keeps running with `restart BLOCKED: tsc timed
  // out`) rather than hang the drain forever. `timeoutMs` is the seam that lets the 5-minute
  // production cap be exercised at all; a 1 ms cap guarantees the (slow-to-start) tsc is killed.
  const root = makeRepo();
  const head = tinyTsProject(root);
  borrowTypeScript(root);
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
