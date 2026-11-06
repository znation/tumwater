/** The main watch's red spell (INV-AZ4): an open red keeps the tip that opened it as its named
 * culprit, so a doc-exempt tip that re-checks it names no one new, and a settled green closes the
 * spell so the next red names its own opener. The culprit a red tip names on its own lives in
 * main-watch.test.ts, confirming a red and quarantine in main-watch-failures.test.ts, the diff
 * rules in main-watch-rules.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch, knownMainFailures } from "../src/baseline/main-watch.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineFixture } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { change, clockAt, culpritFixture, FAILING_OUTPUT, watchAt } from "./fixtures/main-watch-fixtures.js";
import { logEvent } from "../src/events/events.js";

// The main watch (src/baseline/main-watch.ts) records the full check's verdict on main's tip in the
// background. The suite's process-wide verdict cache is keyed by SHA, and every fixture repo has
// its own, so these tests share no state. The hourly cadence (part 2b/4): every watch here carries
// an injected clock, and a test advances it past the interval before each head whose check must
// actually run — a red anchor is re-checked on every new head, never delayed by the hour.
const HOUR = 7_200_000; // 2h: clears the seed run's checkedAt (real Date.now, stamped after the clock starts)

test("a doc-exempt tip that lands after a red keeps the opener as the named culprit", async () => {
  const { root } = culpritFixture();
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit G: green, cached
  const b = change(root, "bad.txt", "b"); // the tip that opens the red
  logEvent(root, { source: "improve", type: "merged", commit: b, summary: "breaks a test" });
  clock.advance(HOUR);
  await watchAt(watch, root);
  const doc = change(root, "README.md", "docs"); // a doc-only tip after the red opened
  await watchAt(watch, root);
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1, "the re-check names the culprit once, for the spell");
  assert.equal(culprits[0]?.commit, b, "the opener stays the named culprit, not the doc-exempt tip");
  assert.equal(culprits[0]?.runner, "improve", "the runner is the one that merged the opener");
  assert.deepEqual(culprits[0]?.failingTests, ["first", "second", "third"]);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 3, "seed green, red tip, doc re-check");
  assert.equal(checks[2]?.sha, doc, "the re-check settled on the doc tip");
  assert.equal(checks[2]?.status, "failed");
});

test("a settled green closes the red spell, so the next red names its own opener", async () => {
  const flag = path.join(tmpdir(), "red");
  const script = `if [ -f ${flag} ]; then ${FAILING_OUTPUT}; exit 1; fi; echo ok`;
  const { root } = baselineFixture("improve", script);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root); // the seed commit: green (no flag)
  fs.writeFileSync(flag, ""); // the failure goes live
  change(root, "a.txt", "a"); // the tip that opens the red
  clock.advance(HOUR);
  await watchAt(watch, root);
  fs.rmSync(flag); // the failure goes away
  change(root, "b.txt", "g"); // the tip that turns main green (the red anchor is re-checked, hour or not)
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_check")[2]?.status, "passed", "the green tip settled");
  assert.equal(eventsOfType(root, "main_culprit").length, 1);
  fs.writeFileSync(flag, ""); // the failure returns on a NEW red
  const c = change(root, "c.txt", "c");
  clock.advance(HOUR);
  await watchAt(watch, root);
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 2, "the reopened red names its own culprit");
  assert.equal(culprits[1]?.commit, c, "the new spell's opener is named, not the old one");
  assert.equal(eventsOfType(root, "main_check")[3]?.status, "failed");
});

test("a doc-exempt tip re-checking an open red does not re-name the culprit: the spell's opener stays blamed", async () => {
  // The red opens at one tip and a later DOC-EXEMPT tip (its diff touches only review-exempt
  // paths, so it cannot change the suite) re-checks the same open red: the watch re-runs the
  // check but names the opener once, so G1 and the heal prompt keep blaming the commit that
  // turned main red (INV-AZ4). A committed flag file in the tree flips the suite's verdict, so
  // the red/green state is explicit per tip and the mirror checkout carries it.
  const root = baselineFixture(
    "improve",
    `[ -f .red-flag ] && { ${FAILING_OUTPUT}; exit 1; }; echo ok`,
  ).root;
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  const poll = async () => {
    watch.poll(headSha(root), false, defaultConfig());
    await watch.idle();
  };
  await poll(); // the seed commit: no flag, green, cached
  fs.writeFileSync(path.join(root, ".red-flag"), "red\n");
  sh(root, "git", "add", "--", ".red-flag");
  change(root, "notes.md", "doc one\n");
  clock.advance(HOUR);
  await poll();
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1, "the first red tip is named exactly once");
  const opener = headSha(root);
  assert.equal(culprits[0]?.commit, opener, "the first red tip opens the spell and names itself");
  const recheck = change(root, "notes.md", "doc one\ndoc two\n"); // a doc-exempt tip re-checking the open red
  assert.notEqual(recheck, opener);
  await poll();
  const after = eventsOfType(root, "main_culprit");
  assert.equal(after.length, 1, "the doc-exempt re-check does not re-name the culprit");
  assert.equal(after[0]?.commit, opener, "the opener stays the blamed commit, not the later tip");
  await poll();
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "a repeat poll does not attribute again");
});

test("a bisected opener stays the spell's culprit across a doc re-check", async () => {
  // Hourly full check part 3a/4 plus INV-AZ4: a fresh red's opener is bisected to the commit at
  // which its failing tests first fail (an intermediate commit, not the newest tip), and a
  // later doc-exempt tip re-checking the open red keeps that bisected opener blamed.
  const root = baselineFixture("improve", `[ -f bad.txt ] && { ${FAILING_OUTPUT}; exit 1; }; echo ok`).root;
  const file = path.join(tmpdir(), "rerun.sh");
  fs.writeFileSync(file, `[ -f bad.txt ] && { ${FAILING_OUTPUT}; exit 1; }; exit 0`);
  const config = { ...defaultConfig(), check: { command: "", rerunCommand: `sh ${file}` } };
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  const poll = async (): Promise<void> => {
    watch.poll(headSha(root), false, config);
    await watch.idle();
  };
  await poll(); // seed: green, cached
  const broken = change(root, "bad.txt", "b"); // opens the red
  change(root, "notes.md", "doc"); // a doc-exempt tip on top, same interval
  logEvent(root, { source: "improve", type: "merged", commit: broken, summary: "breaks a test" });
  clock.advance(HOUR);
  await poll(); // the watch checks the doc tip; the bisection names the code commit
  let culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1);
  assert.equal(culprits[0]?.commit, broken, "the bisected code commit is the culprit");
  const doc2 = change(root, "README.md", "docs more"); // another doc-exempt tip, re-checking the open red
  await poll();
  culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1, "the doc re-check does not re-name");
  assert.equal(culprits[0]?.commit, broken, "the bisected opener stays blamed");
  assert.equal(headSha(root), doc2);
});

test("a doc-exempt tip on top of a code commit that broke main names the code commit as the opener", async () => {
  // The 2026-11-02 guardrail mis-attribution: the code commit that broke main and a doc-exempt
  // commit land in one poll interval, so the watch checks the DOC tip (the tree is still red) and
  // never checks the code tip in isolation. The doc tip's diff cannot have changed the suite, so
  // the red it reports was opened by the code commit: the watch names the code commit as the
  // culprit (the spell opener, the main_culprit event, and the recorded main_check), not the doc
  // tip. (INV-AZ4's doc-exempt re-check of an already-open spell keeps the opener; this is the
  // case where the spell's own opener is a doc tip and must be attributed back to code.)
  const root = baselineFixture(
    "improve",
    `[ -f .red-flag ] && { ${FAILING_OUTPUT}; exit 1; }; echo ok`,
  ).root;
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  const poll = async () => {
    watch.poll(headSha(root), false, defaultConfig());
    await watch.idle();
  };
  await poll(); // the seed commit: no flag, green, cached
  fs.writeFileSync(path.join(root, ".red-flag"), "red\n");
  sh(root, "git", "add", "--", ".red-flag");
  const code = change(root, ".red-flag", "red\n"); // the code commit that breaks the suite
  logEvent(root, { source: "improve", type: "merged", commit: code, summary: "breaks a test" });
  const doc = change(root, "README.md", "a doc-only move\n"); // a doc-exempt tip on top, same interval
  logEvent(root, { source: "improve", type: "merged", commit: doc, summary: "doc only" });
  clock.advance(HOUR);
  await poll(); // the watch checks the doc tip; the tree is red
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1, "the red is attributed exactly once");
  assert.equal(culprits[0]?.commit, code, "the code commit opens the red, not the doc tip");
  assert.equal(culprits[0]?.runner, "improve", "the runner is the one that merged the opener");
  assert.deepEqual(culprits[0]?.failingTests, ["first", "second", "third"]);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2, "seed green, then the doc-tip red");
  assert.equal(checks[1]?.status, "failed");
  assert.equal(checks[1]?.sha, code, "the red main_check is re-attributed to the code commit, not the doc tip");
});

test("a green that closes the open red lets a later red name its own opener again", async () => {
  const root = baselineFixture(
    "improve",
    `[ -f .red-flag ] && { ${FAILING_OUTPUT}; exit 1; }; echo ok`,
  ).root;
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  const poll = async () => {
    watch.poll(headSha(root), false, defaultConfig());
    await watch.idle();
  };
  await poll(); // the seed commit: no flag, green, cached
  fs.writeFileSync(path.join(root, ".red-flag"), "red\n");
  sh(root, "git", "add", "--", ".red-flag");
  const red1 = change(root, "notes.md", "r1\n");
  clock.advance(HOUR);
  await poll();
  assert.equal(eventsOfType(root, "main_culprit")[0]?.commit, red1);
  sh(root, "git", "rm", "-q", "--", ".red-flag");
  const green1 = change(root, "notes.md", "r1\ng\n"); // removes the flag: a fresh green closes the spell
  await poll();
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "the green clears the spell without naming");
  fs.writeFileSync(path.join(root, ".red-flag"), "red again\n");
  sh(root, "git", "add", "--", ".red-flag");
  const red2 = change(root, "notes.md", "r1\ng\nr2\n");
  clock.advance(HOUR);
  await poll();
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 2, "the later red names its own opener");
  assert.equal(culprits[1]?.commit, red2);
  assert.notEqual(red2, green1);
});

/** A rerun config that fails the named tests (fixture titles) and logs its arguments. The watch's
 * rule (part 3b/4) is that the built check itself is the source of truth on the confirming head;
 * the rerun here only ever names the open tests. */
function rerunScriptOf(failing: readonly string[]): string {
  const cases = failing.map((t) => `*#${t}) echo '✖ ${t} (1ms)'; fail=1;;`).join(" ");
  return `for a in "$@"; do case "$a" in ${cases} *) ;; esac; done; exit \${fail:-0}\n`;
}

function rerunConfig(script: string): ReturnType<typeof defaultConfig> {
  const file = path.join(tmpdir(), `rerun-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, script);
  return { ...defaultConfig(), check: { command: "", rerunCommand: `sh ${file}` } };
}

/** A project whose check and rerun both read a committed flag: the check fakes the full suite
 * failing while the flag is tracked, and passes on the confirming head once the flag is gone.
 * The rerun fails whatever `failing` names on a head that still has the flag. */
test("an open red is cleared with a cleared main_check and confirmed by one full run starting at once", async () => {
  // Hourly full check, part 3b/4: the spell's open failures all pass on a new head (the fix
  // lands), the red clears as `{ status: "passed", cleared: true }` — no full verdict written,
  // so the head is not yet deployable — and one confirming full run starts at once on that head
  // to confirm it. That confirming run's green makes the head deployable.
  const flag = path.join(tmpdir(), "spell-flag");
  fs.writeFileSync(flag, "");
  const counter = path.join(tmpdir(), "spell-runs");
  const { root } = baselineFixture(
    "improve",
    `echo run >> ${counter}; if [ -f ${flag} ]; then ${FAILING_OUTPUT}; exit 1; fi; echo ok`,
  );
  const watch = createMainWatch(root, "main");
  // 1. Open the red: the full check fails (flag set) and its confirming re-run fails all three.
  watch.poll(headSha(root), false, rerunConfig(rerunScriptOf(["first", "second", "third"])));
  await watch.idle();
  assert.deepEqual(eventsOfType(root, "main_culprit")[0]?.failingTests, ["first", "second", "third"]);
  assert.equal(runsOf(counter), 1);
  // 2. The fix lands (flag removed): a new head re-runs only the open failures. With the flag
  // gone the rerun finds none failing, so the red clears and one confirming full run starts.
  fs.rmSync(flag);
  change(root, "fix.txt", "fix");
  watch.poll(headSha(root), false, rerunConfig(rerunScriptOf([])));
  await watch.idle();
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.filter((c) => c.cleared === true).length, 1, "exactly one cleared main_check");
  const cleared = checks.find((c) => c.cleared === true);
  assert.equal(cleared?.status, "passed");
  assert.equal(cleared?.cleared, true);
  assert.equal(cleared?.durationMs, 0, "a clear is a re-run, not a full verdict: no duration to print");
  // The confirming full run ran at once (one more full run) and recorded a real green.
  assert.equal(runsOf(counter), 2, "the confirming full run started at once");
  const confirm = checks.at(-1);
  assert.notEqual(confirm?.cleared, true, "the confirming green is a real full verdict");
  assert.equal(confirm?.status, "passed");
});

test("a confirming full run that turns red opens a new spell on its own failure", async () => {
  // Hourly full check, part 3b/4: the open failures pass on a new head (the spell clears and a
  // full run confirms), but the full suite names a NEW failure on that same head. The cleared
  // spell must not swallow it: the confirming red opens a fresh spell naming that failure.
  const threeFlag = path.join(tmpdir(), "spell-three");
  fs.writeFileSync(threeFlag, "");
  const counter = path.join(tmpdir(), "spell-red-runs");
  const fourth = "printf '✖ fourth (1ms)\\n✖ failing tests:\\n✖ fourth (1ms)\\n'";
  const { root } = baselineFixture(
    "improve",
    `echo run >> ${counter}; if [ -f ${threeFlag} ]; then ${FAILING_OUTPUT}; exit 1; fi; ` +
      `if [ -f four.flag ]; then ${fourth}; exit 1; fi; echo ok`,
  );
  const watch = createMainWatch(root, "main");
  // 1. Open the red on first/second/third; its confirming re-run fails all three.
  watch.poll(headSha(root), false, rerunConfig(rerunScriptOf(["first", "second", "third"])));
  await watch.idle();
  assert.deepEqual(knownMainFailures(root), ["first", "second", "third"]);
  // 2. The head heals those three and adds a fourth failure. The narrowing re-run passes the
  // open set, so the spell clears; the confirming full run is red on fourth.
  fs.rmSync(threeFlag);
  change(root, "four.flag", "4");
  const rerunFile = path.join(tmpdir(), `rerun-four-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(rerunFile, `[ -f four.flag ] || exit 0\n${rerunScriptOf(["fourth"])}`);
  watch.poll(headSha(root), false, { ...defaultConfig(), check: { command: "", rerunCommand: `sh ${rerunFile}` } });
  await watch.idle();
  assert.equal(eventsOfType(root, "main_check").filter((c) => c.cleared === true).length, 1, "the old red cleared");
  assert.deepEqual(knownMainFailures(root), ["fourth"], "the confirming red's own failure is the new open set");
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 2, "the confirming red names a new spell rather than reusing the cleared one");
  assert.deepEqual(culprits[1]?.failingTests, ["fourth"]);
});

function runsOf(file: string): number {
  return Number((fs.readFileSync(file, "utf8").match(/run/g) ?? []).length);
}
