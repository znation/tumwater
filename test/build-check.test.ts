import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runBuildCheck } from "../src/build/build-check.js";
import { runScopedBuildCheck } from "../src/build/build-check-scoped.js";
import { parseTestCounts } from "../src/build/build-check-counts.js";
import { scriptedSampler, woke } from "./helpers/sleep-clock.js";
import { checkFailureReasons } from "../src/build/build-check-report.js";
import { buildCheckEvent, buildCheckSkipWarning } from "../src/build/build-check-events.js";
import { detectBuildCheck } from "../src/build/build-check-detect.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { buildCheckFixture } from "./fixtures/loop-fixtures.js";
import { pathPrepend, pathReplace, projManifest, writeScript } from "./fakes/fake-commands.js";
import { sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { waitFor } from "./helpers/wait.js";

// Unit coverage for the deterministic build pre-check (src/build/build-check.ts): execution and
// outcome classification, plus the configured-check.command detection boundary. The walk-up
// detection tests live in build-check-detect.test.ts beside their subject, the process-tree
// teardown hygiene (group signals, the SIGKILL escalation, settle bounds) in
// build-check-process.test.ts, and the gate's integration with this check (a healthy build
// reaching the reviewer) is covered in review.test.ts, where it belongs — that test drives
// reviewAheadOfMain end-to-end.

const ROLE = "improve";

test("runBuildCheck resolves the toolchain from the installed root when the worktree has no node_modules", async () => {
  const { root, wt } = buildCheckFixture();
  // Pre-fix this was `sh: buildcheck-tool: command not found` (exit 127) — a deterministic
  // rejection of every code change in any JS project (BUGS.md).
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "passed");
});

test("runBuildCheck still classifies a genuinely failing build as failed with the output tail", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "buildcheck-tool --fail" }),
  );
  writeScript(
    path.join(root, "node_modules", ".bin", "buildcheck-tool"),
    "[ \"$1\" = \"--ok\" ] && echo ok || { echo type error TS9999: boom; exit 1; }",
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
  assert.equal(outcome.status, "failed");
  assert.ok((outcome.outputTail ?? []).some((l) => l.includes("TS9999")));
});

// The harness attests the runner's own summary counts (PLANS.md 2026-09-29): parseTestCounts
// reads the node:test summary block out of combined output, and runBuildCheck carries the
// counts on passed and failed outcomes so no model has to state a total.
test("parseTestCounts reads the node:test summary block, including skipped", () => {
  const out = [
    "earlier output the check printed",
    "ℹ tests 2066",
    "ℹ suites 0",
    "ℹ pass 2065",
    "ℹ fail 0",
    "ℹ cancelled 0",
    "ℹ skipped 1",
    "ℹ todo 0",
    "ℹ duration_ms 73.78325",
  ].join("\n");
  assert.deepEqual(parseTestCounts(out), { tests: 2066, pass: 2065, fail: 0, skipped: 1 });
});

test("parseTestCounts returns undefined when no complete summary block appears", () => {
  assert.equal(parseTestCounts("ok\nnothing summary-shaped\n"), undefined);
  // A block missing any of the four counts is not a summary.
  assert.equal(parseTestCounts("ℹ pass 2\nℹ fail 0\n"), undefined);
});

test("parseTestCounts takes the last complete block when several appear", () => {
  const out = [
    "ℹ tests 3",
    "ℹ pass 3",
    "ℹ fail 0",
    "ℹ skipped 0",
    "later run's summary:",
    "ℹ tests 9",
    "ℹ pass 7",
    "ℹ fail 1",
    "ℹ skipped 1",
  ].join("\n");
  assert.deepEqual(parseTestCounts(out), { tests: 9, pass: 7, fail: 1, skipped: 1 });
});

test("runBuildCheck carries the runner's summary counts on passed and failed outcomes", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "buildcheck-tool" }),
  );
  const tool = path.join(root, "node_modules", ".bin", "buildcheck-tool");
  writeScript(tool, 'echo "ℹ tests 3"; echo "ℹ pass 3"; echo "ℹ fail 0"; echo "ℹ skipped 0"');
  const ok = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
  assert.equal(ok.status, "passed");
  assert.deepEqual(ok.counts, { tests: 3, pass: 3, fail: 0, skipped: 0 });
  writeScript(tool, 'echo "ℹ tests 3"; echo "ℹ pass 1"; echo "ℹ fail 2"; echo "ℹ skipped 0"; exit 1');
  const bad = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
  assert.equal(bad.status, "failed");
  assert.deepEqual(bad.counts, { tests: 3, pass: 1, fail: 2, skipped: 0 });
});

test("buildCheckEvent carries the counts when the outcome has them", () => {
  const withCounts = buildCheckEvent(
    "feature",
    "gate",
    { status: "passed", script: "test", counts: { tests: 3, pass: 3, fail: 0, skipped: 0 } },
    5,
  );
  assert.deepEqual(withCounts.counts, { tests: 3, pass: 3, fail: 0, skipped: 0 });
  const without = buildCheckEvent("feature", "gate", { status: "skipped", script: "test" }, 5);
  assert.equal("counts" in without, false, "no counts field when the outcome has none");
});

test("runBuildCheck skips (not fails closed) when the script times out", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "sleep 5" }),
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 400);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "timeout");
});

// A check that dies on a signal the harness did not send (another run's pkill, an operator's
// cleanup) must not be reported as a timeout: the 2026-09-23 gate incident logged "timed out
// after 300s" for a check killed by pkill at 7.4s and sent the change to review unverified.
// npm re-raises a script child's signal death, so the group leader itself closes with the
// signal — no timeout has fired, and the classification is a distinct "killed" skip naming it.
test("a check killed by an external signal is skipped as killed, naming the signal (regression)", async () => {
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ test: "kill -9 $$" }),
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "test" }, 30_000);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "killed");
  assert.equal(outcome.killedBy, "SIGKILL");
});

// The measured cause of BUGS.md 2026-09-21: the host slept through the deadline. libuv's clock
// on macOS counts sleep, so the timer fires at the first wake — minutes past the bound, often
// after seconds of real work — and the warning still said "timed out after 300s". A Date-only
// mock makes the wall clock jump the way it does across that sleep while the real timer keeps
// its schedule; the run must report when its deadline really fired, on the event and in the
// warning.
test("a deadline the host slept through is reported as when it really fired, on the event and in the warning (regression)", async (t) => {
  const { root } = buildCheckFixture();
  const wt = tmpdir();
  const first = path.join(wt, "first-attempt");
  const second = path.join(wt, "second-attempt");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const pending = runScopedBuildCheck(root, ROLE, "gate", wt, {
    check: {
      command: "if [ -f first-attempt ]; then touch second-attempt; sleep 30; else touch first-attempt; sleep 30; fi",
      timeoutSeconds: 2,
    },
  });
  await waitFor(() => fs.existsSync(first), "the first attempt's marker", 10_000);
  assert.ok(fs.existsSync(first), "the check spawned before the deadline");
  t.mock.timers.tick(412_000); // the host sleeps 412 s through the 2 s deadline
  // The gate owes one retry after a late-deadline timeout; drive it through its own late fire.
  await waitFor(() => fs.existsSync(second), "the retry's marker", 10_000);
  t.mock.timers.tick(412_000);
  const result = await pending;
  assert.equal(result!.outcome.skipReason, "timeout");
  assert.equal(result!.outcome.run?.deadlineLateMs, 410_000, "the deadline fired 410 s past its 2 s bound");
  const events = readEvents(root);
  const checks = events.filter((e) => e.type === "build_check");
  assert.equal(checks.length, 2, "the first late attempt and its retry each logged a build_check event");
  const check = checks[0];
  assert.equal(check?.durationMs, 412_000);
  assert.equal(check?.timeoutMs, 2_000, "the event names the bound that was armed");
  assert.equal(check?.deadlineLateMs, 410_000, "and how late it actually fired");
  assert.equal(typeof check?.spawnedAt, "number");
  assert.equal(typeof check?.settledAt, "number");
  const warning = events.find((e) => e.type === "warning");
  assert.equal(
    warning?.message,
    "build check timed out after 412s (its 2s deadline fired 410s late: the host was asleep or " +
      "the harness stalled); proceeding to model review",
  );
});

test("a landing- or batch-scope timeout is a deterministic reject, not an environmental skip", async () => {
  // BUGS.md 2026-09-18: the landing check is the last gate before main, so a suite that never
  // finished must not read as "environmental" and merge the unverified tree. The gate scope
  // stays fail-open because the model reviewer and the landing check still stand behind it.
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "sleep 5" }),
  );

  for (const scope of ["landing", "batch"] as const) {
    const result = await runScopedBuildCheck(root, ROLE, scope, wt, undefined, 400);
    assert.equal(result!.outcome.status, "failed", `${scope}: a timeout rejects`);
    assert.match(
      result!.outcome.outputTail?.[0] ?? "",
      /timed out after 0\.4s; the tree is unverified/,
    );
  }
  const events = readEvents(root);
  assert.ok(
    events.some((e) => e.type === "build_check" && e.scope === "landing" && e.status === "failed"),
    "the rejected timeout is priced as a failed check in the feed",
  );
  assert.equal(
    events.filter((e) => e.type === "build_check" && e.scope !== "gate").length,
    2,
    "an on-time timeout rejects on its first occurrence — no retry is owed",
  );
  assert.ok(
    events.some((e) => e.type === "warning" && /rejecting the merge/.test(String(e.message))),
    "the operator sees why the landing did not proceed",
  );

  const gate = await runScopedBuildCheck(root, ROLE, "gate", wt, undefined, 400);
  assert.equal(gate!.outcome.status, "skipped");
  assert.equal(gate!.outcome.skipReason, "timeout");
});

// A gate check killed by an external signal says nothing about the tree: one retry, whose
// verdict stands (the 2026-09-23 incident — a build-fix run's `pkill` killed organize's gate
// check and the change went to review unverified). Each attempt is priced as its own event.
test("a gate check killed by an external signal is retried once, and the retry's verdict stands", async () => {
  const { root, wt } = buildCheckFixture();
  // wt needs its own node_modules or detectBuildCheck walks up to the fixture root's package.json.
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ test: "if [ -f killed-once ]; then exit 0; else touch killed-once; kill -9 $$; fi" }),
  );
  const result = await runScopedBuildCheck(root, ROLE, "gate", wt, undefined, 30_000);
  assert.equal(result!.outcome.status, "passed", "the clean retry's verdict stands");
  const events = eventsOfType(root, "build_check");
  assert.equal(events.length, 2, "each attempt is priced as its own build_check event");
  assert.equal(events[0]?.status, "skipped");
  assert.equal(events[1]?.status, "passed");
});

// A persistently killed check at a merge scope is unverified, not environmental: it rejects
// deterministically, and the reason names the signal and the real duration — never the
// timeout bound, which did not fire.
test("a merge-scope check killed by an external signal rejects, naming the signal and real duration", async () => {
  const { root, wt } = buildCheckFixture();
  // wt needs its own node_modules or detectBuildCheck walks up to the fixture root's package.json.
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ test: "kill -9 $$" }),
  );
  const result = await runScopedBuildCheck(root, ROLE, "batch", wt, undefined, 30_000);
  assert.equal(result!.outcome.status, "failed", "an unverified tree must not land");
  assert.match(result!.outcome.outputTail?.[0] ?? "", /was killed by SIGKILL after \d+(?:\.\d+)?s; the tree is unverified/);
  const warning = readEvents(root).find((e) => e.type === "warning");
  assert.match(String(warning?.message ?? ""), /was killed by SIGKILL after \d+(?:\.\d+)?s/);
  assert.doesNotMatch(String(warning?.message ?? ""), /timed out/);
});

// A merge-scope timeout whose deadline demonstrably fired late is the same weather a kill is:
// the harness's own evidence (deadlineLateMs) says the host slept through the deadline, so the
// check ran seconds and was killed at a wake — no verdict about the tree, and not a slow suite
// (BUGS.md 2026-09-28). It owes the killed path's one retry, whose verdict stands; each
// attempt is priced as its own event.
test("a merge-scope timeout the host slept through is retried once, and the clean retry's verdict stands", async (t) => {
  const { root, wt } = buildCheckFixture();
  // The 2026-09-21 pattern: a Date-only mock jumps the wall clock the way a host sleep does,
  // while the real deadline timer keeps its schedule — so the timer fires minutes late.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const pending = runScopedBuildCheck(root, ROLE, "landing", wt, {
    check: { command: "if [ -f retried ]; then exit 0; else touch retried; sleep 30; fi", timeoutSeconds: 2 },
  });
  await waitFor(() => fs.existsSync(path.join(wt, "retried")), "the first attempt's retried marker", 10_000);
  t.mock.timers.tick(10_000); // the host sleeps 10 s through the 2 s deadline
  const result = await pending;
  assert.equal(result!.outcome.status, "passed", "the clean retry's verdict stands");
  const events = eventsOfType(root, "build_check");
  assert.equal(events.length, 2, "each attempt is priced as its own build_check event");
  assert.equal(events[0]?.status, "skipped");
  assert.equal(events[1]?.status, "passed");
});

// The gate earns the same retry as a merge scope: the lateness is the harness's own evidence the
// host slept, so the check says nothing about the tree there either, and the gate's reviewer
// would otherwise judge the change unverified. The gate stays fail-open — a retry that also
// times out is still skipped — so the clean retry's verdict stands. BUGS.md 2026-10-07.
test("a gate-scope timeout the host slept through is retried once, and the clean retry's verdict stands", async (t) => {
  const { root, wt } = buildCheckFixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const pending = runScopedBuildCheck(root, ROLE, "gate", wt, {
    check: { command: "if [ -f retried ]; then exit 0; else touch retried; sleep 30; fi", timeoutSeconds: 2 },
  });
  await waitFor(() => fs.existsSync(path.join(wt, "retried")), "the first attempt's retried marker", 10_000);
  t.mock.timers.tick(10_000); // the host sleeps 10 s through the 2 s deadline
  const result = await pending;
  assert.equal(result!.outcome.status, "passed", "the clean retry's verdict stands");
  const events = eventsOfType(root, "build_check");
  assert.equal(events.length, 2, "each attempt is priced as its own build_check event");
  assert.equal(events[0]?.status, "skipped");
  assert.equal(events[1]?.status, "passed");
});

// When the weather persists, the retry's verdictless timeout still rejects — never merge
// unverified — but the reason must not wear the "build check failed" prefix a genuine red
// gets: the tree is unverified, not red, and the prefix would send the author hunting a test
// failure that never happened (BUGS.md 2026-09-28).
test("a merge-scope timeout late on both attempts rejects unverified, without the red-build prefix", async (t) => {
  const { root, wt } = buildCheckFixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const pending = runScopedBuildCheck(root, ROLE, "landing", wt, {
    check: {
      command: "if [ -f retried ]; then touch retried2; sleep 30; else touch retried; sleep 30; fi",
      timeoutSeconds: 2,
    },
  });
  await waitFor(() => fs.existsSync(path.join(wt, "retried")), "the first attempt's retried marker", 10_000);
  t.mock.timers.tick(10_000); // the first deadline fires 8s late → one retry is owed
  await waitFor(() => fs.existsSync(path.join(wt, "retried2")), "the retry's retried2 marker", 10_000);
  t.mock.timers.tick(10_000); // the retry's deadline fires late too → its verdict stands
  const result = await pending;
  assert.equal(result!.outcome.status, "failed", "an unverified tree must not land");
  assert.match(
    result!.outcome.outputTail?.[0] ?? "",
    /landing build check timed out after 10s \(its 2s deadline fired 8s late: the host was asleep or the harness stalled\); the tree is unverified/,
  );
  const reasons = checkFailureReasons(result!.check, result!.outcome);
  assert.equal(reasons[0], result!.outcome.outputTail?.[0], "the reason keeps its own wording verbatim");
  assert.doesNotMatch(reasons[0] ?? "", /^build check failed/);
  const events = eventsOfType(root, "build_check");
  assert.equal(events.length, 2, "the verdictless first attempt and the retry each priced one event");
  assert.equal(events[0]?.status, "skipped");
  assert.equal(events[1]?.status, "failed");
  const warning = readEvents(root).find((e) => e.type === "warning");
  assert.match(String(warning?.message ?? ""), /rejecting the merge/);
});

test("a gate check killed on every attempt stays skipped, and the warning names the signal — not the timeout", async () => {
  // The killed-skip warning's with-info arm: the gate scope (fail-open, one retry) is the only
  // surface that can still be "skipped" after a kill — a merge scope remaps the kill to a
  // deterministic failure and a single kill that recovers on retry never warns at all, so
  // without this test the message the operator actually reads had no coverage.
  const { root, wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ test: "kill -9 $$" }),
  );
  const result = await runScopedBuildCheck(root, ROLE, "gate", wt, undefined, 30_000);
  assert.equal(result!.outcome.status, "skipped", "the gate stays fail-open on an environmental kill");
  assert.equal(result!.outcome.skipReason, "killed");
  assert.equal(result!.outcome.killedBy, "SIGKILL");
  // Both attempts are priced as build_check events (the feed answers how long a check took).
  const checks = eventsOfType(root, "build_check");
  assert.equal(checks.length, 2, "the killed attempt and the retry each priced one event");
  const warning = readEvents(root).find((e) => e.type === "warning");
  assert.match(String(warning?.message ?? ""),
    /build check was killed by SIGKILL after \d+(?:\.\d+)?s; proceeding to model review/);
  assert.doesNotMatch(String(warning?.message ?? ""), /timed out/);
});

test("the killed skip warning without signal info names an external signal, never the timeout", () => {
  // The main-red baseline passes no killed info: its wording must still say "killed by an
  // external signal" rather than claiming the timeout bound fired (BUGS.md 2026-09-23).
  assert.equal(
    buildCheckSkipWarning("killed", "main baseline check", "proceeding with authoring unverified", 30_000),
    "main baseline check was killed by an external signal; proceeding with authoring unverified",
  );
});

test("runBuildCheck skips (not fails closed) when npm is missing from PATH", async () => {
  const { root, wt } = buildCheckFixture();

  // A spawn failure before anything ran must classify as environmental: a machine without npm
  // would otherwise fail-closed and discard every code change through the strike cap.
  const emptyBin = tmpdir("no-npm-");
  const restorePath = pathReplace(emptyBin); // no npm (execFile resolves bare commands via PATH)
  try {
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "no-npm");
  } finally {
    restorePath();
  }
});

/** A scratch bin dir holding a `git` that fails the way the 2026-09-15 incident's did:
 * the xcrun shim of an invalidated Xcode license, exit 69 with the license message. */
function brokenGitBin(): string {
  const bin = tmpdir("broken-git-");
  writeScript(
    path.join(bin, "git"),
    "echo \"xcrun: error: SDK root does not exist\" >&2\necho \"You have not agreed to the Xcode license agreements.\" >&2\nexit 69",
  );
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
    projManifest({ build: `echo run >> ${counter}` }),
  );
  const restore = pathPrepend(brokenGitBin()); // the broken git shadows the real one; npm stays
  try {
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skipReason, "toolchain");
    assert.ok(!fs.existsSync(counter), "the check itself never ran — the probe short-circuited it");
  } finally {
    restore();
  }
});

test("runBuildCheck reads a toolchain error in a failed run's output as skipped, not failed", async () => {
  // The incident's suite path: git ran the probe fine, the suite ran, and the suite's own
  // git calls died on the license error — the nonzero exit is noise from the environment,
  // not a verdict about the tree. Both signatures the incident produced must classify.
  const { root, wt } = buildCheckFixture();
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: 'echo "You have not agreed to the Xcode license agreements."; echo "xcrun: error: missing input"; exit 1' }),
  );
  const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
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
  const restorePath = pathReplace(bin); // node + npm + sh, no git
  try {
    const outcome = await runBuildCheck(wt, { kind: "npm", rootDir: root, script: "build" }, 30_000);
    assert.equal(outcome.status, "passed");
  } finally {
    restorePath();
  }
});

// --- A configured check.command (plans/portability.md §6/7): the walk-up cannot know how a
// Python, Rust, or Go repo verifies itself, so `check` in tumwater.json names it and the same
// detection → run → classification machinery executes it. No npm assumed anywhere.

test("detectBuildCheck returns the configured check.command first, with cwd and timeout resolved", () => {
  const { root, wt } = buildCheckFixture();
  assert.deepEqual(detectBuildCheck(wt, { check: { command: "pytest -q" } }), {
    kind: "command",
    command: "pytest -q",
    cwd: wt,
    timeoutMs: 300_000,
  });
  assert.deepEqual(
    detectBuildCheck(wt, { check: { command: "cargo test", cwd: "crates/core", timeoutSeconds: 5 } }),
    { kind: "command", command: "cargo test", cwd: path.join(wt, "crates", "core"), timeoutMs: 5_000 },
  );
  // A blank command is no command — validation rejects one, but a degraded default config
  // could still carry it; the walk-up detection takes over instead of running nonsense.
  assert.deepEqual(detectBuildCheck(wt, { check: { command: "   " } }), {
    kind: "npm",
    rootDir: root,
    script: "build",
  });
  // No config at all: today's npm auto-detection, unchanged.
  assert.deepEqual(detectBuildCheck(wt), { kind: "npm", rootDir: root, script: "build" });
});

test("a configured command runs through a shell in its cwd, classified like an npm check", async () => {
  const { wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "sub"));
  fs.writeFileSync(path.join(wt, "sub", "marker.txt"), "x");

  // `&&` composition and a pipe prove shell semantics — split into argv this would ENOENT,
  // and without the cwd it would look in the wrong directory and fail.
  const passing = await runBuildCheck(
    wt,
    { kind: "command", command: "cat marker.txt | grep x && echo done", cwd: path.join(wt, "sub"), timeoutMs: 30_000 },
    30_000,
  );
  assert.equal(passing.status, "passed");
  assert.equal(passing.script, "cat marker.txt | grep x && echo done");

  const failing = await runBuildCheck(
    wt,
    { kind: "command", command: "echo type error TS9999: boom; exit 1", cwd: wt, timeoutMs: 30_000 },
    30_000,
  );
  assert.equal(failing.status, "failed", "a nonzero exit is a deterministic rejection");
  assert.ok((failing.outputTail ?? []).some((l) => l.includes("TS9999")), "the tail carries the failure");
});

test("a configured command times out at its own timeoutSeconds, not the caller's", async () => {
  const { wt } = buildCheckFixture();
  const outcome = await runBuildCheck(wt, { kind: "command", command: "sleep 5", cwd: wt, timeoutMs: 400 }, 30_000);
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.skipReason, "timeout");
});

test("runScopedBuildCheck remaps a configured command's merge-scope timeout exactly as an npm one", async () => {
  const { root, wt } = buildCheckFixture();
  const config = { check: { command: "sleep 5", timeoutSeconds: 0.4 } };
  for (const scope of ["landing", "batch"] as const) {
    const result = await runScopedBuildCheck(root, ROLE, scope, wt, config, 30_000);
    assert.equal(result!.outcome.status, "failed", `${scope}: a timeout rejects`);
    assert.match(result!.outcome.outputTail?.[0] ?? "", /timed out after 0\.4s; the tree is unverified/);
  }
  const events = readEvents(root);
  const check = events.find((e) => e.type === "build_check" && e.scope === "landing");
  assert.equal((check as { script?: string } | undefined)?.script, "sleep 5", "the event names the command");
});

// --- check.gateCommand (PLANS.md Land-queue speed 3e): an opt-in cheaper check for the review
// gate's per-change pre-check only. The landing and batch scopes — the checks that decide what
// reaches main — keep running the full check, or a weaker gate would land an unverified tree.

test("runScopedBuildCheck runs check.gateCommand at the gate scope only; landing and batch keep check.command", async () => {
  const { root, wt } = buildCheckFixture();
  // The full check is red and the gate command green, so each scope's verdict names which ran.
  const config = { check: { command: "echo full; exit 1", gateCommand: "echo gate-only" } };
  const gate = await runScopedBuildCheck(root, ROLE, "gate", wt, config, 30_000);
  assert.equal(gate!.outcome.status, "passed");
  assert.deepEqual(gate!.check, { kind: "command", command: "echo gate-only", cwd: wt, timeoutMs: 300_000 });
  for (const scope of ["landing", "batch"] as const) {
    const result = await runScopedBuildCheck(root, ROLE, scope, wt, config, 30_000);
    assert.equal(result!.outcome.status, "failed", `${scope}: the full check still runs`);
    assert.equal(result!.outcome.script, "echo full; exit 1");
  }
  const scripts = readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => [e.scope, (e as { script?: string }).script]);
  assert.deepEqual(scripts, [
    ["gate", "echo gate-only"],
    ["landing", "echo full; exit 1"],
    ["batch", "echo full; exit 1"],
  ]);
});

test("check.gateCommand shares the check's cwd and timeout, and overrides the npm walk-up at the gate too", async () => {
  const { root, wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "sub"));
  fs.writeFileSync(path.join(wt, "sub", "marker.txt"), "x");
  const withCwd = await runScopedBuildCheck(
    root,
    ROLE,
    "gate",
    wt,
    { check: { command: "exit 1", gateCommand: "test -f marker.txt", cwd: "sub", timeoutSeconds: 7 } },
    30_000,
  );
  assert.equal(withCwd!.outcome.status, "passed", "the gate command ran in check.cwd");
  assert.deepEqual(withCwd!.check, {
    kind: "command",
    command: "test -f marker.txt",
    cwd: path.join(wt, "sub"),
    timeoutMs: 7_000,
  });
  // No check.command (an npm repo — validation allows the key to be absent): the gate runs the
  // gate command, the landing scope the npm walk-up exactly as before.
  const npmRepo = { check: { gateCommand: "echo gate-only" } } as { check: { command: string; gateCommand: string } };
  const gate = await runScopedBuildCheck(root, ROLE, "gate", wt, npmRepo, 30_000);
  assert.equal(gate!.outcome.script, "echo gate-only");
  const landing = await runScopedBuildCheck(root, ROLE, "landing", wt, npmRepo, 30_000);
  assert.deepEqual(landing!.check, { kind: "npm", rootDir: root, script: "build" });
});

test("an unset or blank check.gateCommand leaves the gate running check.command", async () => {
  const { root, wt } = buildCheckFixture();
  for (const gateCommand of [undefined, "", "   "]) {
    const result = await runScopedBuildCheck(
      root,
      ROLE,
      "gate",
      wt,
      { check: { command: "echo full", ...(gateCommand === undefined ? {} : { gateCommand }) } },
      30_000,
    );
    assert.equal(result!.outcome.script, "echo full", `gateCommand ${JSON.stringify(gateCommand)} is off`);
  }
});

// BUGS.md 2026-09-30: a sleep shorter than the check's remaining deadline but longer than a
// test's own wait expires that wait at the wake; the suite exits 1 inside the deadline, the
// run carries no deadlineLateMs, and the failure reads as a deterministic rejection of the
// change. With a measured sleptMs on the run it owes the same clean retry a late-deadline
// timeout already gets — and a clean retry's verdict stands, exactly like a first-time pass.
test("a failed check that spanned a host sleep is retried once, and the clean retry's verdict stands", async () => {
  const { root, wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ test: "if [ -f slept-once ]; then exit 0; else touch slept-once; exit 1; fi" }),
  );
  // Attempt 1 opens awake and closes after a 119 s sleep; attempt 2 never sleeps.
  const sampler = scriptedSampler([woke(1_000), woke(121_000, 2_000), woke(121_000), woke(121_500)]);
  const result = await runScopedBuildCheck(root, ROLE, "gate", wt, undefined, 30_000, sampler);
  assert.equal(result!.outcome.status, "passed", "the clean retry's pass is the verdict");
  const events = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "gate");
  assert.equal(events.length, 2, "the slept failure and the retry are each priced as their own event");
  assert.equal(events[0]!.status, "failed");
  assert.equal(events[0]!.sleptMs, 119_000, "the first attempt's event carries the measured sleep");
  assert.equal(events[1]!.status, "passed");
});

// The other half of the same bug: a retry that ALSO slept made no clean verdict either, so it
// is recorded as unverified at a merge scope — not a deterministic failure of the change.
test("a retry that also slept is recorded as unverified, not as the change's own failure", async () => {
  const { root, wt } = buildCheckFixture();
  fs.mkdirSync(path.join(wt, "node_modules"));
  fs.writeFileSync(path.join(wt, "package.json"), projManifest({ test: "exit 1" }));
  const sampler = scriptedSampler([woke(1_000), woke(121_000, 2_000), woke(122_000), woke(241_000, 3_000)]);
  const result = await runScopedBuildCheck(root, ROLE, "landing", wt, undefined, 30_000, sampler);
  assert.equal(result!.outcome.status, "failed", "an unverified landing still rejects — the tree must not merge");
  assert.equal(result!.outcome.unverified, true, "the rejection is unverified, not attributed to the tree");
  // The retry's sleep began before its window opened, so the measured in-window span is
  // clamped to 119 s — the sleep is still evidenced, never counted outside the run.
  assert.match(result!.outcome.outputTail?.[0] ?? "", /host slept 119s mid-run/);
  const events = readEvents(root).filter((e) => e.type === "build_check" && e.scope === "landing");
  assert.equal(events.length, 2);
  assert.equal(events[1]!.sleptMs, 119_000, "the retry's own sleep is on its event too");
  assert.ok(
    readEvents(root).some((e) => e.type === "warning" && /host slept 119s mid-run.*rejecting the merge/.test(String(e.message))),
    "the operator sees the sleep, not a flaky test",
  );
});
