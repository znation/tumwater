import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  checkMainBaseline,
  clipBuildTail,
  detectBuildCheck,
  noteGreenBaseline,
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

// --- checkMainBaseline: the red-main gate's one-shot, fleet-shared verification of main's own
// suite (PLANS.md "Red-main baseline check"). Unlike the fixtures above — plain directories,
// enough for detection and execution in isolation — these need a REAL git repo with a worktree
// at the real location (.tumwater/worktrees/<role>): the helper keys its verdict by the
// worktree's HEAD, which must be pristine main.

/** A git repo whose main is "installed" (package.json + node_modules at root) with a linked
 * worktree checked out to it. `testScript` is committed to main so the worktree's checkout
 * carries it; node_modules stays untracked — the install marker detectBuildCheck walks up to,
 * gitignored in real projects. */
async function baselineFixture(testScript: string): Promise<{ root: string; wt: string }> {
  const base = tmpdir("baseline-");
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  sh(root, "git", "init", "-b", "main");
  sh(root, "git", "config", "user.name", "test");
  sh(root, "git", "config", "user.email", "test@example.com");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: testScript } }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(root, "git", "worktree", "add", "-b", `tumwater/${ROLE}`, wt, "main");
  return { root, wt };
}

/** How many times the fixture's test script actually ran (its appends to `counter`). */
function runsOf(counter: string): number {
  return fs.readFileSync(counter, "utf8").trim().split("\n").length;
}

test("checkMainBaseline reports a red main with the failing script and clipped tail", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = await baselineFixture(`echo baseline-failure; echo run >> ${counter}; exit 1`);
  const result = await checkMainBaseline(wt);
  assert.equal(result.baseline?.status, "red");
  assert.equal(result.baseline?.sha, sh(root, "git", "rev-parse", "main"));
  assert.equal(result.baseline?.script, "test");
  assert.ok((result.baseline?.outputTail ?? []).some((l) => l.includes("baseline-failure")));
});

test("checkMainBaseline caches per SHA: a second call on the same HEAD re-runs nothing", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = await baselineFixture(`echo run >> ${counter}; exit 1`);
  const first = await checkMainBaseline(wt);
  const second = await checkMainBaseline(wt);
  assert.equal(first.baseline?.status, "red");
  assert.equal(second.baseline?.status, "red");
  assert.equal(runsOf(counter), 1, "npm ran once for the SHA — the verdict is cached");
});

test("checkMainBaseline re-checks when main moves to a new SHA", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = await baselineFixture(`echo run >> ${counter}; exit 1`);
  assert.equal((await checkMainBaseline(wt)).baseline?.status, "red");
  // A new commit lands on main (still red) and the worktree resets to it — the next tick's
  // fresh SHA must re-run the check instead of trusting the old verdict.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: `echo run >> ${counter}; exit 2` } }),
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "still red");
  sh(wt, "git", "reset", "--hard", "main");
  const result = await checkMainBaseline(wt);
  assert.equal(result.baseline?.status, "red");
  assert.equal(result.baseline?.sha, sh(root, "git", "rev-parse", "main"));
  assert.equal(runsOf(counter), 2, "the new SHA re-ran the check");
});

test("checkMainBaseline reports a green main without failure details", async () => {
  const { wt } = await baselineFixture("echo ok");
  const result = await checkMainBaseline(wt);
  assert.equal(result.baseline?.status, "green");
  assert.equal(result.baseline?.script, undefined, "red-only field stays absent");
  assert.equal(result.baseline?.outputTail, undefined, "red-only field stays absent");
});

test("checkMainBaseline returns null (no block) when no build check is declared", async () => {
  const base = tmpdir("baseline-none-");
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  sh(root, "git", "init", "-b", "main");
  sh(root, "git", "config", "user.name", "test");
  sh(root, "git", "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(root, "seed.txt"), "x\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(root, "git", "worktree", "add", "-b", `tumwater/${ROLE}`, wt, "main");

  const result = await checkMainBaseline(wt);
  assert.equal(result.baseline, null, "nothing to verify → nothing to block on");
  assert.equal(result.skipReason, undefined, "a missing check is not an environmental skip");
});

test("checkMainBaseline never caches red for an environmental skip: with npm missing it reports the skip, and re-runs once npm returns", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = await baselineFixture(`echo run >> ${counter}; exit 1`);

  // A PATH that keeps git (the helper keys by HEAD) but drops npm — the real-world shape of a
  // machine without node.
  const partialBin = tmpdir("no-npm-");
  fs.symlinkSync(sh(wt, "which", "git"), path.join(partialBin, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = partialBin;
  try {
    const skipped = await checkMainBaseline(wt);
    assert.equal(skipped.baseline, null, "a skip never blocks authoring");
    assert.equal(skipped.skipReason, "no-npm");
  } finally {
    process.env.PATH = oldPath;
  }

  // npm is back: the same SHA must be RE-CHECKED (the skip was never cached) and now reports red.
  const result = await checkMainBaseline(wt);
  assert.equal(result.baseline?.status, "red");
  assert.equal(runsOf(counter), 1, "exactly one real run — the skipped attempt ran nothing");
});

test("checkMainBaseline dedups concurrent checks of one new SHA into a single run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = await baselineFixture(`echo run >> ${counter}; exit 1`);
  // A fresh main move wakes every blocked role at once: their concurrent checks must share one
  // npm invocation, not race N of them.
  const [a, b] = await Promise.all([checkMainBaseline(wt), checkMainBaseline(wt)]);
  assert.equal(a.baseline?.status, "red");
  assert.equal(b.baseline?.status, "red");
  assert.equal(runsOf(counter), 1, "one npm run for concurrent callers of the same SHA");
});

test("a red is provisional: reverifyRed re-runs it in the caller's own worktree and a pass promotes the SHA", async () => {
  // The 2026-09-08 shape: one worktree's environment, not the tree, produced the red — here a
  // `marker` file standing in for the missing node_modules — and it became the fleet's verdict.
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = await baselineFixture(
    `echo run >> ${counter}; node -e "process.exit(require('fs').existsSync('marker') ? 0 : 1)"`,
  );
  assert.equal((await checkMainBaseline(wt)).baseline?.status, "red");
  assert.equal((await checkMainBaseline(wt)).baseline?.status, "red", "and it is cached for ordinary callers");
  assert.equal(runsOf(counter), 1);

  // A second worktree of the same SHA where the check passes.
  const other = path.join(root, ".tumwater", "worktrees", "other");
  sh(root, "git", "worktree", "add", "-q", "--detach", other, "main");
  fs.writeFileSync(path.join(other, "marker"), "");
  assert.equal((await checkMainBaseline(other)).baseline?.status, "red", "without the flag it inherits the red");
  assert.equal(runsOf(counter), 1, "…and runs nothing");

  const reverified = await checkMainBaseline(other, undefined, true);
  assert.equal(reverified.baseline?.status, "green");
  assert.equal(runsOf(counter), 2, "the re-verification ran the suite here");
  assert.equal(
    (await checkMainBaseline(wt)).baseline?.status,
    "green",
    "green is authoritative: it promotes the SHA even for the worktree that reported red",
  );
  assert.equal(runsOf(counter), 2);
  assert.equal((await checkMainBaseline(wt, undefined, true)).baseline?.status, "green", "a green is never re-run");
  assert.equal(runsOf(counter), 2);
});

// --- noteGreenBaseline: the landing path (src/merge.ts) seeds this cache with the post-rebase
// head after a green check, so a merged tree is never re-verified by checkMainBaseline.

test("noteGreenBaseline records a directly-observed green verdict: checkMainBaseline returns it without running the suite", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = await baselineFixture(`echo run >> ${counter}; echo ok`);
  // The landing path just verified this exact tree (branch HEAD == main here) and passed:
  // record that verdict the way verifyLanding does after a green runBuildCheck.
  noteGreenBaseline(sh(root, "git", "rev-parse", "HEAD"));
  const result = await checkMainBaseline(wt);
  assert.equal(result.baseline?.status, "green");
  assert.ok(!fs.existsSync(counter), "the suite never ran — the landing path's verdict is trusted for this SHA");
});
