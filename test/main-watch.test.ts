/** The main watch on each new head of main: one check per head, covering every commit since the
 * last; a doc-only head inheriting green; a held team starting none; an unreadable main warning
 * once; and the culprit a red tip names (itself, with its merging runner and failing tests) and
 * the heal prompt it queues for ci. Confirming a red, main's known failures and quarantine live
 * in main-watch-failures.test.ts, red spells in main-watch-spells.test.ts, and the diff rules on
 * each tip in main-watch-rules.test.ts; the four share fixtures/main-watch-fixtures.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { mainTipVerdict, queueCulpritHeal } from "../src/baseline/main-red.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { defaultConfig } from "../src/config/config.js";
import type { CheckConfig } from "../src/config/config-schema.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { change, clockAt, culpritFixture, watchAt, watchAtWith } from "./fixtures/main-watch-fixtures.js";

// The hourly cadence (part 2b/4): every watch here carries an injected clock, and a test
// advances it past the interval (an hour) before each head that must run the full check — the
// per-head cadence these tests assert is now the hourly cadence with the clock moved past it.
const HOUR = 7_200_000; // 2h: clears the seed run's checkedAt (real Date.now, stamped after the clock starts)
import { logEvent } from "../src/events/events.js";
import { shortSha } from "../src/text/format.js";

// The main watch (src/baseline/main-watch.ts) records the full check's verdict on main's tip in the
// background. The suite's process-wide verdict cache is keyed by SHA, and every fixture repo has
// its own, so these tests share no state.

test("a new head is checked once and logged as one passed main_check; a repeat poll does nothing", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root);
  await watchAt(watch, root);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, "passed");
  assert.equal(checks[0]?.sha, headSha(root));
  assert.equal(runsOf(counter), 1);
});

test("two merges before a run cover both commits in one watch run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root);
  change(root, "a.txt", "a");
  const tip = change(root, "b.txt", "b");
  clock.advance(HOUR);
  await watchAt(watch, root);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2);
  assert.equal(checks[1]?.sha, tip);
  assert.equal(checks[1]?.covered, 2);
  assert.equal(runsOf(counter), 2);
});

test("a doc-only commit on a checked head inherits green without a run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root);
  change(root, "README.md", "docs");
  // Within the hour: the doc-only head settles its inherited green without a run (as today),
  // the full check is due for a code head, not a doc-only one.
  await watchAt(watch, root);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2);
  assert.equal(checks[1]?.status, "passed");
  assert.equal(
    checks[1]?.sha,
    headSha(root),
    "the green main_check keeps the doc tip's sha, not an earlier commit",
  );
  assert.equal(checks[1]?.inherited, true);
  assert.equal(runsOf(counter), 1);
});

test("a held team starts no watch run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const watch = createMainWatch(root, "main", undefined, clockAt().now);
  await watchAt(watch, root, true);
  assert.equal(eventsOfType(root, "main_check").length, 0);
  assert.equal(runsOf(counter), 0);
});

test("a main whose branch is unreadable warns once through the poll catch and is not retried until the head moves", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const head = headSha(root); // capture before the ref is gone: HEAD no longer resolves once deleted
  const watch = createMainWatch(root, "main");
  // Knock out the branch ref the watch resolves its tip from, so branchHead("main") is null and
  // withMainTipWorktree rejects — the one path that records no verdict and warns per head.
  sh(root, "git", "update-ref", "-d", "refs/heads/main");
  watch.poll(head, false, defaultConfig());
  await watch.idle();
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes("main watch could not check main") && m.includes("main is unreadable")),
    warnings.join("|"),
  );
  assert.equal(
    warnings.filter((m) => m.includes("main watch could not check main")).length,
    1,
    "the rules pass and the full pass warn once for the same head",
  );
  assert.equal(eventsOfType(root, "main_check").length, 0, "an unreadable main records no verdict");
});

// The red tip's own attribution ("Every commit is verified on main, part 2/3"): the watch checks
// each new tip, so the newest head is the culprit for whatever it finds. culpritFixture's check
// fails while bad.txt is tracked, so a test turns main red with a commit and asserts the tip
// names itself.

test("a red tip names itself as the culprit, with its merging runner and the failing tests", async () => {
  const { root } = culpritFixture();
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit G: green, cached
  const b = change(root, "bad.txt", "b"); // the red tip itself
  logEvent(root, { source: "improve", type: "merged", commit: b, summary: "breaks a test" });
  clock.advance(HOUR); // past the interval: the code head is checked
  await watchAt(watch, root);
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1);
  assert.equal(culprits[0]?.commit, b);
  assert.equal(culprits[0]?.runner, "improve");
  assert.deepEqual(culprits[0]?.failingTests, ["first", "second", "third"]);
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "a repeat poll does not attribute again");
});

test("the watch's onCulprit hands a red culprit straight to ci's heal queue and reverts nothing", async () => {
  // The orchestrator's wiring (src/orchestrator/orchestrator.ts): a named red-main culprit goes
  // to ci's heal queue with the existing wording, and nothing is ever reverted (Forward, never
  // back, part 4/6).
  const { root } = culpritFixture();
  const clock = clockAt();
  const watch = createMainWatch(root, "main", (culprit) => {
    queueCulpritHeal(root, culprit.tip, { culprit: culprit.commit, failingTests: culprit.failingTests });
  }, clock.now);
  await watchAt(watch, root); // the seed commit G: green, cached
  const b = change(root, "bad.txt", "b"); // the red tip itself
  clock.advance(HOUR);
  await watchAt(watch, root);
  const queued = queuedRolePrompts(root, "ci");
  assert.equal(queued.length, 1, "the red culprit queued exactly one heal prompt for ci");
  const prompt = queued[0]!;
  assert.ok(prompt.includes(mainRedCulpritClause(b)), queued.join("\n"));
  assert.ok(prompt.includes("Failing: first; second; third."), prompt);
  assert.equal(eventsOfType(root, "operator_revert").length, 0, "nothing is reverted");
});

test("a culprit's heal prompt names the command that re-runs only its failing tests", async () => {
  const { root } = culpritFixture();
  fs.writeFileSync(path.join(root, "tumwater.json"), JSON.stringify({ check: { rerunCommand: "npm run test:rerun --" } }));
  const clock = clockAt();
  const watch = createMainWatch(root, "main", (culprit) => {
    queueCulpritHeal(root, culprit.tip, { culprit: culprit.commit, failingTests: culprit.failingTests });
  }, clock.now);
  await watchAt(watch, root);
  change(root, "bad.txt", "b");
  clock.advance(HOUR);
  await watchAt(watch, root);
  const prompt = queuedRolePrompts(root, "ci")[0] ?? "";
  assert.ok(prompt.includes("with: npm run test:rerun -- '#first' '#second' '#third'"), prompt);
});

function mainRedCulpritClause(sha: string): string {
  return `The watch named ${shortSha(sha)} as the commit that turned it red`;
}

test("a red tip with no merged event is named without a runner", async () => {
  const { root } = culpritFixture();
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root);
  const b = change(root, "bad.txt", "b");
  clock.advance(HOUR);
  await watchAt(watch, root);
  const culprit = eventsOfType(root, "main_culprit")[0];
  assert.equal(culprit?.commit, b, "the tip is its own culprit");
  assert.equal("runner" in (culprit ?? {}), false);
  assert.deepEqual(culprit?.failingTests, ["first", "second", "third"]);
});

test("a multi-commit batch whose breaker is intermediate names the breaking commit, not the newest tip", async () => {
  const { root } = culpritFixture();
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit G: green, cached
  const breaker = change(root, "bad.txt", "b"); // the intermediate commit that actually breaks the build
  logEvent(root, { source: "improve", type: "merged", commit: breaker, summary: "breaks a test" });
  change(root, "good.txt", "g"); // a later commit on top, same poll batch; its tree is still red
  clock.advance(HOUR);
  await watchAt(watch, root);
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1);
  // BUGS.md 2026-11-04: the watch checks only the newest tip per poll, so the breaker that is
  // two first-parent commits behind the tip must be attributed by walking each merged tree.
  assert.equal(culprits[0]?.commit, breaker, "the breaking commit is named, not the newest red tip");
  assert.equal(culprits[0]?.runner, "improve");
  assert.deepEqual(culprits[0]?.failingTests, ["first", "second", "third"]);
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "a repeat poll does not attribute again");
});

// The hourly full-check cadence (Hourly full check, part 2b/4): the full check runs at most once
// per check.fullIntervalMinutes (default 60), on main's latest tip, and only while a non-exempt
// code commit sits above the newest verdict a full check actually produced (checkedAt, part 2a/4).
// A doc-only range inherits green and starts no run; a verdict without checkedAt reads as due now;
// 0 restores one full run per new code head. The deterministic diff rules still run on every new
// head, even while the full check is suspended — so the skip path is the one that proves the
// rules are judged independently of the build's verdict.

test("within the interval, a code head above a green anchor suspends the full check but still runs the rules", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit: green, checkedAt stamped
  change(root, "a.txt", "a"); // a code head above the green anchor, within the interval
  // A conflict marker in the same commit proves the diff rules ran on this head even though the
  // full check is suspended — the rules are judged independently of the build's verdict.
  change(root, "bad.txt", "line one\n<<<<<<< HEAD\n");
  await watchAt(watch, root); // within the interval: no run, but the rules still judge the tip
  // A repeat poll of the same suspended head must be a no-op: re-judging the range would log
  // the same rule warning again every poll until the interval passes.
  await watchAt(watch, root);
  assert.equal(runsOf(counter), 1, "the full check is suspended within the interval");
  assert.equal(eventsOfType(root, "main_check").length, 1, "no new verdict while the full check is suspended");
  // The diff rules still ran on the tip despite the suspended full check, exactly once.
  const warnings = warningMessages(root).filter((m) => m.includes("conflict markers remain in"));
  assert.equal(warnings.length, 1, "the diff rules judge the suspended head once, not once per poll");
});

test("a suspended head another check records red is settled without waiting for the interval", async () => {
  const { root } = culpritFixture();
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit: green, checkedAt stamped
  change(root, "bad.txt", "b"); // a code head that is actually red, above the green anchor
  await watchAt(watch, root); // within the interval: suspended, so the watch has not seen the red
  assert.equal(eventsOfType(root, "main_check").length, 1, "the watch itself made no verdict yet");
  // The gate's main-tip attribution shares the same per-SHA cache and can observe this red while
  // the watch waits out the interval (mainTipVerdict's checkMainBaseline).
  assert.equal((await mainTipVerdict(root, "improve", "main", defaultConfig())).status, "red");
  await watchAt(watch, root); // the same head: the cached red must be settled now, not in an hour
  assert.equal(eventsOfType(root, "main_check").length, 2, "the suspended head's red is recorded");
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "the red names its culprit at once");
});

test("after the interval passes, the full check covers every commit above the anchor it skipped past", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit: green, checkedAt stamped
  change(root, "a.txt", "a"); // a code head above the green anchor, within the interval
  await watchAt(watch, root); // suspended: no run
  assert.equal(runsOf(counter), 1, "within the interval the full check is suspended");
  clock.advance(HOUR); // the interval passes
  await watchAt(watch, root); // due now: the check covers the commit above the anchor
  assert.equal(runsOf(counter), 2, "the full check ran once the interval passed");
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2);
  assert.equal(checks[1]?.covered, 1, "the check covers the code commit above the anchor");
});

test("fullIntervalMinutes 0 restores one full run per new code head", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const clock = clockAt();
  // The command stays undeclared (the fixture's package.json drives npm detection); only the
  // cadence is set. CheckConfig requires `command` in its type, but the watch reads
  // fullIntervalMinutes independently, so the cast is honest.
  const config = { ...defaultConfig(), check: { fullIntervalMinutes: 0 } as CheckConfig };
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAtWith(watch, root, config); // the seed commit: green, checkedAt stamped
  change(root, "a.txt", "a"); // a code head, immediately (the clock is not advanced)
  await watchAtWith(watch, root, config);
  assert.equal(runsOf(counter), 2, "interval 0: every new code head runs the full check");
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2);
  assert.equal(checks[1]?.covered, 1);
});

test("a restart honoring a saved checkedAt starts no full run until the interval passes", async () => {
  // The acceptance criterion's restart: a full verdict saved 20 minutes before a restart starts no
  // full run in the first 40 minutes after it, and the first poll past the hour starts one. The
  // baseline cache is process-wide, so a second watch object (the "restart") reads the checkedAt
  // the first watch stamped, and the injected clock plays the wall time since that stamp.
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const firstClock = clockAt();
  const first = createMainWatch(root, "main", undefined, firstClock.now);
  await watchAt(first, root); // the seed commit: green, checkedAt stamped (real time)
  const restart = clockAt(); // the wall clock 20 minutes on (well inside the hour)
  restart.advance(20 * 60_000);
  const second = createMainWatch(root, "main", undefined, restart.now); // the restart
  change(root, "a.txt", "a"); // a code head above the green anchor
  await watchAt(second, root); // still within 40 minutes of the saved verdict: suspended
  assert.equal(runsOf(counter), 1, "the restart does not re-run the full check within the interval");
  assert.equal(eventsOfType(root, "main_check").length, 1, "no new verdict while the interval holds");
  restart.advance(45 * 60_000); // now 65 minutes on: past the hour
  await watchAt(second, root);
  assert.equal(runsOf(counter), 2, "the first poll past the hour runs the full check");
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2);
  assert.equal(checks[1]?.covered, 1);
});

// The full check runs in its own in-flight pass (Hourly full check, part 2c/4): `idle()` waits
// for the full-check pass as well as the per-head rules pass, so a slow full run is not left
// behind when a caller drains the watch.
test("idle() drains a slow full run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; sleep 1`);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit: green
  change(root, "a.txt", "a"); // a code head: its full check is due and slow
  clock.advance(HOUR);
  watch.poll(headSha(root), false, defaultConfig()); // starts the rules pass and the full pass
  const done = watch.idle(); // must wait for the slow full run, not just the rules pass
  await done;
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2, "the slow full run settled before idle() resolved");
  assert.equal(checks[1]?.status, "passed");
  assert.equal(runsOf(counter), 2);
});
