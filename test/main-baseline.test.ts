import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CHECK_TIER, withCheckPermit } from "../src/build-check.js";
import { checkMainBaseline, noteGreenBaseline } from "../src/main-baseline.js";
import { defaultConfig } from "../src/config.js";
import { baselineFixture, makeRepo, runsOf, sh, tmpdir } from "./util.js";

// Unit coverage for the fleet-shared main-baseline verdict (src/main-baseline.ts): the
// one-run-per-SHA cache, the re-verification policy that keeps one worktree's environmental
// red from blocking the fleet, and green seeding from the landing path. main-red.test.ts
// covers the gate built on top; build-check.test.ts covers the detection, execution, and
// failure-tail presentation this module consumes.

const ROLE = "improve";
/** The live config checkMainBaseline now requires (plans/portability.md §6/7): the tests here
 * all exercise npm auto-detection, so the defaults (no `check` configured) are the fixture. */
const CFG = defaultConfig();

// --- checkMainBaseline: the red-main gate's one-shot, fleet-shared verification of main's own
// suite (PLANS.md "Red-main baseline check"). Unlike build-check.test.ts's plain-directory
// fixtures — enough for detection and execution in isolation — these need a REAL git repo with a worktree
// at the real location (.tumwater/worktrees/<role>): the helper keys its verdict by the
// worktree's HEAD, which must be pristine main.

/** A second linked worktree on the same repo at main: same immutable tree, different
 * environment — the case a provisional red has to distinguish. */
function addWorktree(root: string, role: string): string {
  const wt = path.join(root, ".tumwater", "worktrees", role);
  sh(root, "git", "worktree", "add", "-b", `tumwater/${role}`, wt, "main");
  return wt;
}

test("a red in one worktree is re-verified by the next, and a green there promotes the SHA", async () => {
  const counter = path.join(tmpdir(), "runs");
  // Fails only where an untracked marker sits: identical tree, different environment.
  const { root, wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; if [ -f ./RED_MARKER ]; then echo env-failure; exit 1; fi; echo ok`,
  );
  fs.writeFileSync(path.join(wt, "RED_MARKER"), "");
  const other = addWorktree(root, "dry");

  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red", "the first worktree sees red");
  assert.equal(
    (await checkMainBaseline(other, CFG)).baseline?.status,
    "green",
    "the next worktree re-runs a single-worktree red instead of trusting it",
  );
  assert.equal(runsOf(counter), 2);
  // The promotion is what unblocks the fleet: even the worktree that produced the false red
  // now reads green, without main having to move.
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "green");
  assert.equal(runsOf(counter), 2, "a green is authoritative — nothing re-ran");
});

test("a red confirmed by a second worktree is authoritative: a third trusts the cache", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; echo real-failure; exit 1`);
  const second = addWorktree(root, "dry");
  const third = addWorktree(root, "clean");

  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red");
  assert.equal((await checkMainBaseline(second, CFG)).baseline?.status, "red");
  assert.equal(runsOf(counter), 2, "one confirmation run, paid by the second worktree");
  assert.equal((await checkMainBaseline(third, CFG)).baseline?.status, "red");
  assert.equal(runsOf(counter), 2, "two agreeing worktrees settle it — no run per role");
  // What the flag still buys: the redeploy gate pays for its own opinion even on a red two
  // worktrees already agree on, because stranding the fleet on a stale build costs more.
  assert.equal((await checkMainBaseline(third, CFG, undefined, true)).baseline?.status, "red");
  assert.equal(runsOf(counter), 3, "reverifyRed always runs");
});

test("checkMainBaseline reports a red main with the failing script and clipped tail", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo baseline-failure; echo run >> ${counter}; exit 1`);
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "red");
  assert.equal(result.baseline?.sha, sh(root, "git", "rev-parse", "main"));
  assert.equal(result.baseline?.script, "test");
  assert.ok((result.baseline?.outputTail ?? []).some((l) => l.includes("baseline-failure")));
});

test("checkMainBaseline caches per SHA: a second call on the same HEAD re-runs nothing", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  const first = await checkMainBaseline(wt, CFG);
  const second = await checkMainBaseline(wt, CFG);
  assert.equal(first.baseline?.status, "red");
  assert.equal(second.baseline?.status, "red");
  assert.equal(runsOf(counter), 1, "npm ran once for the SHA — the verdict is cached");
});

test("checkMainBaseline re-checks when main moves to a new SHA", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red");
  // A new commit lands on main (still red) and the worktree resets to it — the next tick's
  // fresh SHA must re-run the check instead of trusting the old verdict.
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: `echo run >> ${counter}; exit 2` } }),
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "still red");
  sh(wt, "git", "reset", "--hard", "main");
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "red");
  assert.equal(result.baseline?.sha, sh(root, "git", "rev-parse", "main"));
  assert.equal(runsOf(counter), 2, "the new SHA re-ran the check");
});

test("checkMainBaseline reports a green main without failure details", async () => {
  const { wt } = baselineFixture(ROLE, "echo ok");
  const result = await checkMainBaseline(wt, CFG);
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

  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline, null, "nothing to verify → nothing to block on");
  assert.equal(result.skipReason, undefined, "a missing check is not an environmental skip");
});

test("checkMainBaseline never caches red for an environmental skip: with npm missing it reports the skip, and re-runs once npm returns", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);

  // A PATH that keeps git (the helper keys by HEAD) but drops npm — the real-world shape of a
  // machine without node.
  const partialBin = tmpdir("no-npm-");
  fs.symlinkSync(sh(wt, "which", "git"), path.join(partialBin, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = partialBin;
  try {
    const skipped = await checkMainBaseline(wt, CFG);
    assert.equal(skipped.baseline, null, "a skip never blocks authoring");
    assert.equal(skipped.skipReason, "no-npm");
  } finally {
    process.env.PATH = oldPath;
  }

  // npm is back: the same SHA must be RE-CHECKED (the skip was never cached) and now reports red.
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "red");
  assert.equal(runsOf(counter), 1, "exactly one real run — the skipped attempt ran nothing");
});

test("checkMainBaseline reads a toolchain-failing suite as an environmental skip, never red", async () => {
  // BUGS.md 2026-09-15: the harness's own suite failed with an Xcode license error in its
  // output, the red verdict latched, and the fleet sat on a stale build until main moved. The
  // incident's suite path, in miniature: git works (rev-parse keys the check), the suite runs
  // and dies on the toolchain — the verdict must be a skip, not a red.
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; echo "You have not agreed to the Xcode license agreements."; exit 1`,
  );
  const skipped = await checkMainBaseline(wt, CFG);
  assert.equal(skipped.baseline, null, "a toolchain skip never blocks authoring or a restart");
  assert.equal(skipped.skipReason, "toolchain");
  // The skip is never cached: once the toolchain is fixed the SAME SHA must be re-checked —
  // this is the latch the incident left, and a cached red would rebuild it.
  fs.rmSync(counter, { force: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: `echo run >> ${counter}; echo ok` } }),
  );
  const rechecked = await checkMainBaseline(wt, CFG);
  assert.equal(rechecked.baseline?.status, "green", "the fixed toolchain re-checks the same SHA");
  assert.equal(runsOf(counter), 1, "one real run — the skip cached nothing");
});

test("checkMainBaseline dedups concurrent checks of one new SHA into a single run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  // A fresh main move wakes every blocked role at once: their concurrent checks must share one
  // npm invocation, not race N of them.
  const [a, b] = await Promise.all([checkMainBaseline(wt, CFG), checkMainBaseline(wt, CFG)]);
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
  const { root, wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; node -e "process.exit(require('fs').existsSync('marker') ? 0 : 1)"`,
  );
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red");
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "red", "the worktree that saw it does not re-run it");
  assert.equal(runsOf(counter), 1);

  // A second worktree of the same SHA where the check passes.
  const other = path.join(root, ".tumwater", "worktrees", "other");
  sh(root, "git", "worktree", "add", "-q", "--detach", other, "main");
  fs.writeFileSync(path.join(other, "marker"), "");
  assert.equal(
    (await checkMainBaseline(other, CFG)).baseline?.status,
    "green",
    "the next worktree re-verifies a one-worktree red without being asked",
  );
  assert.equal(runsOf(counter), 2, "…paying exactly one confirmation run");
  assert.equal(
    (await checkMainBaseline(wt, CFG)).baseline?.status,
    "green",
    "green is authoritative: it promotes the SHA even for the worktree that reported red",
  );
  assert.equal(runsOf(counter), 2);
  assert.equal((await checkMainBaseline(wt, CFG, undefined, true)).baseline?.status, "green", "a green is never re-run");
  assert.equal(runsOf(counter), 2);
});

// --- noteGreenBaseline: the landing path (src/merge.ts) seeds this cache with the post-rebase
// head after a green check, so a merged tree is never re-verified by checkMainBaseline.

test("noteGreenBaseline records a directly-observed green verdict: checkMainBaseline returns it without running the suite", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; echo ok`);
  // The landing path just verified this exact tree (branch HEAD == main here) and passed:
  // record that verdict the way verifyLanding does after a green runBuildCheck.
  noteGreenBaseline(sh(root, "git", "rev-parse", "HEAD"));
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "green");
  assert.ok(!fs.existsSync(counter), "the suite never ran — the landing path's verdict is trusted for this SHA");
});

test("a configured check.command verifies main on a repo with no npm install anywhere", async () => {
  // plans/portability.md §6/7: a Python/Rust/Go repo has no install for the walk-up to find;
  // the red-main baseline must still run the project's declared check, from tumwater.json.
  const counter = path.join(tmpdir(), "runs-cmd-baseline");
  const root = makeRepo();
  const checkScript = path.join(root, "check.sh");
  fs.writeFileSync(checkScript, `#!/bin/sh\necho run >> ${counter}; echo 'pytest: 1 failing'; exit 1\n`);
  fs.chmodSync(checkScript, 0o755);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-q", "-m", "check");
  const wt = addWorktree(root, ROLE);

  const cfg = { ...defaultConfig(), check: { command: `${checkScript} -q` } };
  const runs: { outcome: { status?: string; script?: string }; durationMs: number }[] = [];
  const result = await checkMainBaseline(wt, cfg, ({ outcome, durationMs }) => runs.push({ outcome, durationMs }));
  assert.equal(result.baseline?.status, "red", "the configured command's failure blocks authoring");
  assert.equal(result.baseline.status === "red" ? result.baseline.script : undefined, `${checkScript} -q`, "the red names the configured command");
  assert.equal(runsOf(counter), 1, "the command ran once");
  assert.equal(runs[0]?.outcome.status, "failed", "the hook saw the classified failure");
  assert.equal(runs[0]?.outcome.script, `${checkScript} -q`, "the event's script field names the command");
});

test("a baseline run takes the same process-wide check permit as the scoped checks", { timeout: 30_000 }, async () => {
  // PLANS.md "Land-queue speed 2b": checkMainBaseline runs the suite directly, not through
  // runScopedBuildCheck, so it must count against maxConcurrentChecks on its own.
  const counter = path.join(tmpdir(), "runs-permit");
  const { wt } = baselineFixture(ROLE, `echo run >> ${counter}; echo ok`);
  const one = { ...CFG, maxConcurrentChecks: 1 };
  let release!: () => void;
  const held = withCheckPermit(one, CHECK_TIER.merge, () => new Promise<void>((resolve) => (release = resolve)));
  const pending = checkMainBaseline(wt, one);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(runsOf(counter), 0, "the suite waits while the only permit is held");
  release();
  await held;
  const result = await pending;
  assert.equal(result.baseline?.status, "green");
  assert.equal(runsOf(counter), 1, "and runs once the permit frees");
});
