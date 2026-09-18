import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  clipBuildTail,
  detectBuildCheck,
  resolveFromNodeModules,
  runBuildCheck,
} from "../src/build-check.js";
import { sh, tmpdir } from "./util.js";

// Unit coverage for the deterministic build pre-check (src/build-check.ts): detection by
// walk-up to the installed root and execution/outcome classification. The gate's integration
// with this check (a healthy build reaching the reviewer) is covered in review.test.ts, where
// it belongs — that test drives reviewAheadOfMain end-to-end.

const ROLE = "improve";

/** Scratch project: `root` has package.json + a fake toolchain in node_modules/.bin; `wt`
 * sits INSIDE it at the real worktree location (`.tumwater/worktrees/<role>`) with its own
 * tracked package.json and no install — so root is an ancestor, as detectBuildCheck requires. */
function buildCheckFixture(): { root: string; wt: string } {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "project");
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  const tool = path.join(binDir, "buildcheck-tool");
  fs.writeFileSync(tool, "#!/bin/sh\necho buildcheck-ok\n");
  fs.chmodSync(tool, 0o755);

  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --ok" } }),
  );
  return { root, wt };
}

test("runBuildCheck resolves the toolchain from the installed root when the worktree has no node_modules", async () => {
  const { root, wt } = buildCheckFixture();
  // Pre-fix this was `sh: buildcheck-tool: command not found` (exit 127) — a deterministic
  // rejection of every code change in any JS project (BUGS.md).
  const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "passed");
});

test("runBuildCheck still classifies a genuinely failing build as failed with the output tail", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --fail" } }),
  );
  const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
  fs.writeFileSync(
    tool,
    "#!/bin/sh\n[ \"$1\" = \"--ok\" ] && echo ok || { echo type error TS9999: boom; exit 1; }\n",
  );
  const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "failed");
  assert.ok((outcome.outputTail ?? []).some((l) => l.includes("TS9999")));
});

test("runBuildCheck skips (not fails closed) when the script times out", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "sleep 5" } }),
  );
  const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 400);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "timeout");
});

test("runBuildCheck skips (not fails closed) when npm is missing from PATH", async () => {
  const { root, wt } = buildCheckFixture();

  // A spawn failure before anything ran must classify as environmental: a machine without npm
  // would otherwise fail-closed and discard every code change through the strike cap.
  const emptyBin = tmpdir("no-npm-");
  const oldPath = process.env.PATH;
  process.env.PATH = emptyBin; // no npm (execFile resolves bare commands via PATH)
  try {
    const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "no-npm");
  } finally {
    process.env.PATH = oldPath;
  }
});

/** A scratch bin dir holding a `git` that fails the way the 2026-09-15 incident's did:
 * the xcrun shim of an invalidated Xcode license, exit 69 with the license message. */
function brokenGitBin(): string {
  const bin = tmpdir("broken-git-");
  const git = path.join(bin, "git");
  fs.writeFileSync(git, "#!/bin/sh\necho \"xcrun: error: SDK root does not exist\" >&2\necho \"You have not agreed to the Xcode license agreements.\" >&2\nexit 69\n");
  fs.chmodSync(git, 0o755);
  return bin;
}

test("runBuildCheck skips (not fails closed) when the toolchain probe fails, and the check never runs", async () => {
  // BUGS.md 2026-09-15 in miniature: git exits 69 before any check runs. Pre-fix every such
  // run was classified `failed` — a deterministic rejection at the gate, a red baseline at the
  // main-red gate, a latched \"main is red\" at the redeploy — all of them about the toolchain,
  // none of them about the tree.
  const { root, wt } = buildCheckFixture();
  const counter = path.join(tmpdir(), "runs");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: `echo run >> ${counter}` } }),
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${brokenGitBin()}:${oldPath}`; // the broken git shadows the real one; npm stays
  try {
    const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "toolchain");
    assert.ok(!fs.existsSync(counter), "the check itself never ran — the probe short-circuited it");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runBuildCheck reads a toolchain error in a failed run's output as skipped, not failed", async () => {
  // The incident's suite path: git ran the probe fine, the suite ran, and the suite's own
  // git calls died on the license error — the nonzero exit is noise from the environment,
  // not a verdict about the tree. Both signatures the incident produced must classify.
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({
      name: "proj",
      version: "1.0.0",
      scripts: { build: 'echo "You have not agreed to the Xcode license agreements."; echo "xcrun: error: missing input"; exit 1' },
    }),
  );
  const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "toolchain");
});

test("runBuildCheck proceeds when git is missing from PATH: a check that never touches git still runs", async () => {
  // The probe must tell "no git at all" (missing) from "git refuses to work" (broken): this
  // project's check has no git in it, so a git-less machine is not an environmental skip.
  const { root, wt } = buildCheckFixture();
  const bin = tmpdir("no-git-");
  for (const tool of ["node", "npm", "sh"]) {
    const found = sh(wt, "which", tool).trim();
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  const oldPath = process.env.PATH;
  process.env.PATH = bin; // node + npm + sh, no git
  try {
    const outcome = await runBuildCheck(wt, { rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "passed");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("detectBuildCheck walks up from a worktree without node_modules to the installed project root", () => {
  const { root, wt } = buildCheckFixture();
  assert.deepEqual(detectBuildCheck(wt), { rootDir: root, script: "build" });
});

// --- detectBuildCheck semantics: preference, first-qualifying-directory-wins, and failure modes.
// These are documented in src/build-check.ts but were untested; the first-qualifier rule is the
// load-bearing one — skipping past a scriptless installed project to an unrelated ancestor would
// run THAT project's build script against this worktree (or nothing of this project at all).

test("detectBuildCheck prefers test over typecheck and build when all three scripts are declared", () => {
  const base = tmpdir("buildcheck-pref-");
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

  // All three declared: test wins — npm convention makes `npm test` the canonical verify command.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "b", typecheck: "t", test: "x" } }),
  );
  assert.deepEqual(detectBuildCheck(root), { rootDir: root, script: "test" });

  // Without a test script the old preference stands: typecheck over build.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "b", typecheck: "t" } }),
  );
  assert.deepEqual(detectBuildCheck(root), { rootDir: root, script: "typecheck" });
});

test("detectBuildCheck stops at the first qualifying directory even when it declares no check script", () => {
  const base = tmpdir("buildcheck-first-qualifies-");
  const outer = path.join(base, "outer"); // installed and HAS a build script — must never be used
  fs.mkdirSync(path.join(outer, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(outer, "package.json"),
    JSON.stringify({ name: "other", version: "1.0.0", scripts: { build: "echo other-project" } }),
  );
  const project = path.join(outer, "project"); // installed but scriptless — the first qualifier
  fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0" }),
  );
  const wt = path.join(project, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(wt, { recursive: true });

  assert.equal(detectBuildCheck(wt), null, "no check — the scriptless project wins over its ancestor");
});

test("detectBuildCheck tolerates a malformed or scriptless package.json without throwing", () => {
  const base = tmpdir("buildcheck-malformed-");
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

  // Unparseable JSON at the qualifying directory: no check, and detection never throws into the gate.
  fs.writeFileSync(path.join(root, "package.json"), "{ not json ");
  assert.equal(detectBuildCheck(root), null);

  // A scripts object with neither a usable test, typecheck, nor build (empty string / non-string) is no check.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "", build: "", typecheck: null } }),
  );
  assert.equal(detectBuildCheck(root), null);
});

test("detectBuildCheck honors the maxLevels bound and terminates at the filesystem root", () => {
  // No install anywhere up a plain tmpdir chain. Walking 10 levels from here passes through /
  // (tmpdir is only a few levels deep), so this also pins the parent===dir termination: a
  // regression that kept walking past root would loop forever and hang the suite.
  const base = tmpdir("buildcheck-none-");
  const deep = path.join(base, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(detectBuildCheck(deep, 10), null);

  // The bound is inclusive: an install exactly maxLevels up is found; one level further out is not.
  const chain = tmpdir("buildcheck-bound-");
  let dir = path.join(chain, "l1", "l2", "l3");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(chain, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(chain, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "echo ok" } }),
  );
  assert.deepEqual(detectBuildCheck(dir, 3), { rootDir: chain, script: "build" });
  assert.equal(detectBuildCheck(dir, 2), null);
});

// --- clipBuildTail: what of a chatty build's output survives into persisted state and the
// reviewer-injected note — blanks and npm's own banners must not count against the ten-line cap.

test("clipBuildTail keeps only the last ten meaningful lines, dropping blanks and npm banners", () => {
  const noise = Array.from({ length: 30 }, (_, i) => `error line ${i}`);
  const output = ["> proj@1.0.0 build", "> tsc --noEmit", "", ...noise.slice(0, 5), "   ", ...noise.slice(5)].join("\n");
  const tail = clipBuildTail(output);
  assert.equal(tail.length, 10, "capped at ten lines");
  assert.deepEqual(tail, noise.slice(-10), "the LAST ten meaningful lines survive");
});

test("clipBuildTail clips each surviving line to the reason cap with an ellipsis", () => {
  const long = "x".repeat(400);
  const tail = clipBuildTail(`ok\n${long}\nshort`);
  assert.equal(tail.length, 3);
  const clipped = tail[1] ?? "";
  assert.equal(clipped.length, 300, "clipped to MAX_REASON_CHARS");
  assert.ok(clipped.endsWith("…"), "marked with the ellipsis");
  assert.equal(tail[2], "short", "lines that fit are unchanged");
});

// --- resolveFromNodeModules: the same walk-up detectBuildCheck makes, for a dependency the
// harness must locate itself (redeploy's tsc) rather than let npm's PATH walk find.

test("resolveFromNodeModules climbs to an ancestor's install and gives up past the level cap", () => {
  const base = tmpdir("walkup-");
  fs.mkdirSync(path.join(base, "node_modules", "typescript", "bin"), { recursive: true });
  const tsc = path.join(base, "node_modules", "typescript", "bin", "tsc");
  fs.writeFileSync(tsc, "#!/usr/bin/env node\n");
  const nested = path.join(base, "a", "b", "c");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(resolveFromNodeModules(base, path.join("typescript", "bin", "tsc")), tsc, "found at the start dir");
  assert.equal(resolveFromNodeModules(nested, path.join("typescript", "bin", "tsc")), tsc, "and three levels down");
  assert.equal(resolveFromNodeModules(nested, path.join("typescript", "bin", "tsc"), 2), null, "cap reached first");
  assert.equal(resolveFromNodeModules(nested, "nonesuch"), null, "nothing to find");
});

