import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkMainBaseline, failureHeadline, noteGreenBaseline } from "../src/main-baseline.js";
import { sh, tmpdir } from "./util.js";

// Unit coverage for the fleet-shared main-baseline verdict (src/main-baseline.ts): the
// one-run-per-SHA cache, the re-verification policy that keeps one worktree's environmental
// red from blocking the fleet, green seeding from the landing path, and the presentation of a
// red's failure tail. main-red.test.ts covers the gate built on top; build-check.test.ts
// covers the detection and execution this module consumes.

const ROLE = "improve";

// --- checkMainBaseline: the red-main gate's one-shot, fleet-shared verification of main's own
// suite (PLANS.md "Red-main baseline check"). Unlike build-check.test.ts's plain-directory
// fixtures — enough for detection and execution in isolation — these need a REAL git repo with a worktree
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

/** A second linked worktree on the same repo at main: same immutable tree, different
 * environment — the case a provisional red has to distinguish. */
function addWorktree(root: string, role: string): string {
  const wt = path.join(root, ".tumwater", "worktrees", role);
  sh(root, "git", "worktree", "add", "-b", `tumwater/${role}`, wt, "main");
  return wt;
}

test("failureHeadline names what broke, not the frame it broke in", () => {
  // clipBuildTail keeps the LAST ten lines, so an unhandled rejection's tail opens mid-stack.
  assert.equal(
    failureHeadline([
      "at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      "at async Promise.all (index 0)",
      "AssertionError [ERR_ASSERTION]: actual: 'quiet_killed', expected: 'no_change'",
    ]),
    "AssertionError [ERR_ASSERTION]: actual: 'quiet_killed', expected: 'no_change'",
  );
  assert.equal(failureHeadline(["at a (f:1:1)", "at b (f:2:2)"]), "at a (f:1:1)", "all frames: print something");
  assert.equal(failureHeadline([]), undefined);
  assert.equal(failureHeadline(undefined), undefined);
});

test("a red in one worktree is re-verified by the next, and a green there promotes the SHA", async () => {
  const counter = path.join(tmpdir(), "runs");
  // Fails only where an untracked marker sits: identical tree, different environment.
  const { root, wt } = await baselineFixture(
    `echo run >> ${counter}; if [ -f ./RED_MARKER ]; then echo env-failure; exit 1; fi; echo ok`,
  );
  fs.writeFileSync(path.join(wt, "RED_MARKER"), "");
  const other = addWorktree(root, "dry");

  assert.equal((await checkMainBaseline(wt)).baseline?.status, "red", "the first worktree sees red");
  assert.equal(
    (await checkMainBaseline(other)).baseline?.status,
    "green",
    "the next worktree re-runs a single-worktree red instead of trusting it",
  );
  assert.equal(runsOf(counter), 2);
  // The promotion is what unblocks the fleet: even the worktree that produced the false red
  // now reads green, without main having to move.
  assert.equal((await checkMainBaseline(wt)).baseline?.status, "green");
  assert.equal(runsOf(counter), 2, "a green is authoritative — nothing re-ran");
});

test("a red confirmed by a second worktree is authoritative: a third trusts the cache", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = await baselineFixture(`echo run >> ${counter}; echo real-failure; exit 1`);
  const second = addWorktree(root, "dry");
  const third = addWorktree(root, "clean");

  assert.equal((await checkMainBaseline(wt)).baseline?.status, "red");
  assert.equal((await checkMainBaseline(second)).baseline?.status, "red");
  assert.equal(runsOf(counter), 2, "one confirmation run, paid by the second worktree");
  assert.equal((await checkMainBaseline(third)).baseline?.status, "red");
  assert.equal(runsOf(counter), 2, "two agreeing worktrees settle it — no run per role");
  // What the flag still buys: the redeploy gate pays for its own opinion even on a red two
  // worktrees already agree on, because stranding the fleet on a stale build costs more.
  assert.equal((await checkMainBaseline(third, undefined, true)).baseline?.status, "red");
  assert.equal(runsOf(counter), 3, "reverifyRed always runs");
});

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

test("checkMainBaseline reads a toolchain-failing suite as an environmental skip, never red", async () => {
  // BUGS.md 2026-09-15: the harness's own suite failed with an Xcode license error in its
  // output, the red verdict latched, and the fleet sat on a stale build until main moved. The
  // incident's suite path, in miniature: git works (rev-parse keys the check), the suite runs
  // and dies on the toolchain — the verdict must be a skip, not a red.
  const counter = path.join(tmpdir(), "runs");
  const { wt } = await baselineFixture(
    `echo run >> ${counter}; echo "You have not agreed to the Xcode license agreements."; exit 1`,
  );
  const skipped = await checkMainBaseline(wt);
  assert.equal(skipped.baseline, null, "a toolchain skip never blocks authoring or a restart");
  assert.equal(skipped.skipReason, "toolchain");
  // The skip is never cached: once the toolchain is fixed the SAME SHA must be re-checked —
  // this is the latch the incident left, and a cached red would rebuild it.
  fs.rmSync(counter, { force: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: `echo run >> ${counter}; echo ok` } }),
  );
  const rechecked = await checkMainBaseline(wt);
  assert.equal(rechecked.baseline?.status, "green", "the fixed toolchain re-checks the same SHA");
  assert.equal(runsOf(counter), 1, "one real run — the skip cached nothing");
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

test("a red is provisional: the next worktree re-runs it unasked, and a pass promotes the SHA", async () => {
  // The 2026-09-08 shape: one worktree's environment, not the tree, produced the red — here a
  // `marker` file standing in for the missing node_modules — and it became the fleet's verdict.
  // Since 2026-09-18 no caller has to ASK for that second opinion: the role loops never passed
  // the flag, so one environmental red blocked every code role until main moved — which it could
  // not, because blocking the code roles is what stops main moving (BUGS.md).
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = await baselineFixture(
    `echo run >> ${counter}; node -e "process.exit(require('fs').existsSync('marker') ? 0 : 1)"`,
  );
  assert.equal((await checkMainBaseline(wt)).baseline?.status, "red");
  assert.equal((await checkMainBaseline(wt)).baseline?.status, "red", "the worktree that saw it does not re-run it");
  assert.equal(runsOf(counter), 1);

  // A second worktree of the same SHA where the check passes.
  const other = path.join(root, ".tumwater", "worktrees", "other");
  sh(root, "git", "worktree", "add", "-q", "--detach", other, "main");
  fs.writeFileSync(path.join(other, "marker"), "");
  assert.equal(
    (await checkMainBaseline(other)).baseline?.status,
    "green",
    "the next worktree re-verifies a one-worktree red without being asked",
  );
  assert.equal(runsOf(counter), 2, "…paying exactly one confirmation run");
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
