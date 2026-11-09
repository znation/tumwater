/** The team-shared main-baseline verdict cache (src/baseline/main-baseline.ts): what a check of
 * main reports, one run per SHA (a repeat or concurrent call re-runs nothing, a new SHA
 * re-checks), direct green seeding (noteGreenBaseline), the cap on cached SHAs, and the runs it
 * never caches as red: environmental skips and runs the host slept through. Sibling slices:
 * main-baseline-reverify.test.ts (a one-worktree red re-run by the next worktree),
 * main-baseline-check.test.ts (which check verifies main, and the check permit),
 * main-baseline-inherit.test.ts (the doc-only green carry-over) and
 * main-baseline-persist.test.ts (the verdict file). main-red.test.ts covers the red-main
 * verdict and heal hand-off built on top; build-check.test.ts covers the detection, execution,
 * and failure-tail presentation this module consumes. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cachedBaselineVerdict, checkMainBaseline, noteGreenBaseline } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { gitOnlyBinDir, headSha, mainSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { pathReplace, projManifest } from "./fakes/fake-commands.js";
import { scriptedSampler, woke } from "./helpers/sleep-clock.js";

const ROLE = "improve";
/** The live config checkMainBaseline now requires (plans/portability.md §6/7): the tests here
 * all exercise npm auto-detection, so the defaults (no `check` configured) are the fixture. */
const CFG = defaultConfig();

// --- checkMainBaseline: the one-shot, team-shared verification of main's own
// suite. Unlike build-check.test.ts's plain-directory
// fixtures — enough for detection and execution in isolation — these need a REAL git repo with
// a worktree
// at the real location (.tumwater/worktrees/<role>): the helper keys its verdict by the
// worktree's HEAD, which must be pristine main.

test("checkMainBaseline reports a red main with the failing script and clipped tail", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo baseline-failure; echo run >> ${counter}; exit 1`);
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "red");
  assert.equal(result.baseline?.sha, mainSha(root));
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
  // A new commit merges on main (still red) and the worktree resets to it — the next run's fresh
  // SHA must re-run the check instead of trusting the old verdict.
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: `echo run >> ${counter}; exit 2` }),
  );
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "still red");
  sh(wt, "git", "reset", "--hard", "main");
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "red");
  assert.equal(result.baseline?.sha, mainSha(root));
  assert.equal(runsOf(counter), 2, "the new SHA re-ran the check");
});

test("checkMainBaseline reports a green main without failure details", async () => {
  const { wt } = baselineFixture(ROLE, "echo ok");
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "green");
  assert.equal(result.baseline?.script, undefined, "red-only field stays absent");
  assert.equal(result.baseline?.outputTail, undefined, "red-only field stays absent");
});

test("checkMainBaseline never caches red for an environmental skip: with npm missing it reports the skip, and re-runs once npm returns", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);

  // A PATH that keeps git (the helper keys by HEAD) but drops npm — the real-world shape of a
  // machine without node.
  const partialBin = gitOnlyBinDir("no-npm-");
  const restorePath = pathReplace(partialBin);
  try {
    const skipped = await checkMainBaseline(wt, CFG);
    assert.equal(skipped.baseline, null, "a skip yields no verdict");
    assert.equal(skipped.skipReason, "no-npm");
  } finally {
    restorePath();
  }

  // npm is back: the same SHA must be RE-CHECKED (the skip was never cached) and now reports red.
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "red");
  assert.equal(runsOf(counter), 1, "exactly one real run — the skipped attempt ran nothing");
});

test("checkMainBaseline reads a toolchain-failing suite as an environmental skip, never red", async () => {
  // BUGS.md 2026-09-15: the harness's own suite failed with an Xcode license error in its
  // output, the red verdict latched, and the team sat on a stale build until main moved. The
  // incident's suite path, in miniature: git works (rev-parse keys the check), the suite runs
  // and dies on the toolchain — the verdict must be a skip, not a red.
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; echo "You have not agreed to the Xcode license agreements."; exit 1`,
  );
  const skipped = await checkMainBaseline(wt, CFG);
  assert.equal(skipped.baseline, null, "a toolchain skip yields no verdict and never wedges a restart");
  assert.equal(skipped.skipReason, "toolchain");
  // The skip is never cached: once the toolchain is fixed the SAME SHA must be re-checked —
  // this is the latch the incident left, and a cached red would rebuild it.
  fs.rmSync(counter, { force: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ test: `echo run >> ${counter}; echo ok` }),
  );
  const rechecked = await checkMainBaseline(wt, CFG);
  assert.equal(rechecked.baseline?.status, "green", "the fixed toolchain re-checks the same SHA");
  assert.equal(runsOf(counter), 1, "one real run — the skip cached nothing");
});

test("checkMainBaseline dedups concurrent checks of one new SHA into a single run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  // A fresh main move sends every role's verifier at the new SHA at once: their concurrent
  // checks must share one npm invocation, not race N of them.
  const [a, b] = await Promise.all([checkMainBaseline(wt, CFG), checkMainBaseline(wt, CFG)]);
  assert.equal(a.baseline?.status, "red");
  assert.equal(b.baseline?.status, "red");
  assert.equal(runsOf(counter), 1, "one npm run for concurrent callers of the same SHA");
});

// --- noteGreenBaseline: a caller records a directly observed green for a SHA, so a later
// checkMainBaseline of that tree is a cache hit (no merge path has seeded since parts 4l/3).

test("noteGreenBaseline records a directly-observed green verdict: checkMainBaseline returns it without running the suite", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; echo ok`);
  // A caller just observed this exact tree pass (branch HEAD == main here): record that verdict
  // directly, as the gate pre-check did when it ran green (no merge path seeds since 4l/3).
  noteGreenBaseline(headSha(root));
  const result = await checkMainBaseline(wt, CFG);
  assert.equal(result.baseline?.status, "green");
  assert.ok(!fs.existsSync(counter), "the suite never ran — the recorded verdict is trusted for this SHA");
});

// BUGS.md 2026-09-30: a FAILED baseline run the host slept through made no verdict about the
// tree — the sleep expired a test's own wait and the suite exited 1 inside the deadline — so
// it must not be cached as the team's authoritative red main.
test("a baseline run the host slept through is unverified and never cached red", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; if [ -f ./SLEEP_RED_MARKER ]; then echo env-failure; exit 1; fi; echo ok`,
  );
  fs.writeFileSync(path.join(wt, "SLEEP_RED_MARKER"), "");
  // Both attempts open awake and close after a 119 s sleep: the retry sleeps too.
  const slept = scriptedSampler([
    woke(1_000),
    woke(121_000, 2_000),
    woke(121_000),
    woke(241_000, 122_000),
  ]);
  const first = await checkMainBaseline(wt, CFG, undefined, false, false, slept);
  assert.equal(first.baseline, null, "a slept run caches nothing");
  assert.equal(first.unverified, true, "the caller is told the run was unverified, not skipped");
  assert.equal(runsOf(counter), 2, "the slept failure owed one clean retry before it stood");

  // The next consult re-runs (nothing was cached) and the clean attempt's verdict settles the
  // SHA exactly as before — here green, which the cache then holds for everyone.
  fs.unlinkSync(path.join(wt, "SLEEP_RED_MARKER"));
  const clean = scriptedSampler([woke(1_000), woke(1_500)]);
  const second = await checkMainBaseline(wt, CFG, undefined, false, false, clean);
  assert.equal(second.baseline?.status, "green");
  assert.equal(runsOf(counter), 3, "the slept failure did not latch the red into the cache");
  assert.equal((await checkMainBaseline(wt, CFG)).baseline?.status, "green");
  assert.equal(runsOf(counter), 3, "the clean green is cached as always");
});

// The baseline owes the same one clean retry runScopedBuildCheck gives every other scope: a
// failure the host slept through is weather, and a clean second attempt settles the SHA.
test("a slept baseline failure is retried once and the clean retry's verdict stands", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { wt } = baselineFixture(ROLE,
    `echo run >> ${counter}; if [ "$(wc -l < ${counter})" -lt 2 ]; then echo flaky; exit 1; fi; echo ok`,
  );
  const sampler = scriptedSampler([
    woke(1_000),
    woke(121_000, 2_000),
    woke(121_000),
    woke(121_500),
  ]);
  const seen: number[] = [];
  const res = await checkMainBaseline(wt, CFG, () => seen.push(1), false, false, sampler);
  assert.equal(res.baseline?.status, "green", "the retry's pass verifies main");
  assert.equal(runsOf(counter), 2);
  assert.equal(seen.length, 2, "the verdict-less first attempt is priced as its own run");
});

// The verdict cache is keyed by every merged code SHA, so without a cap the orchestrator would hold
// one entry per merge for the life of the process. It keeps the most recent capped set and evicts
// the oldest; eviction costs at most one redundant suite run if that SHA is consulted again, which
// is why it is safe to bound. Inserting twice the cap makes the assertion independent of whatever
// earlier tests left in the cache.
test("the baseline verdict cache is bounded: pushing past the cap evicts the oldest SHAs", () => {
  const CAP = 256;
  const shas = Array.from({ length: CAP * 2 }, (_, i) => `cache-cap-sha-${i}`);
  for (const sha of shas) noteGreenBaseline(sha);
  assert.equal(cachedBaselineVerdict(shas[CAP - 1]!), undefined, "the oldest SHAs were evicted");
  assert.equal(cachedBaselineVerdict(shas[CAP]!), "green", "the newest capped set is retained");
  assert.equal(cachedBaselineVerdict(shas[CAP * 2 - 1]!), "green", "the most recent verdict survives");
  // A re-seed of a still-cached SHA updates in place and must not evict another entry.
  noteGreenBaseline(shas[CAP]!);
  assert.equal(cachedBaselineVerdict(shas[CAP + 1]!), "green", "an in-place update evicts nothing");
});
