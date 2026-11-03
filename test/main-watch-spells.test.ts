/** The main watch's red spell (INV-AZ4): an open red keeps the tip that opened it as its named
 * culprit, so a doc-exempt tip that re-checks it names no one new, and a settled green closes the
 * spell so the next red names its own opener. The culprit a red tip names on its own lives in
 * main-watch.test.ts, confirming a red and quarantine in main-watch-failures.test.ts, the diff
 * rules in main-watch-rules.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineFixture } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { change, culpritFixture, FAILING_OUTPUT, watchAt } from "./fixtures/main-watch-fixtures.js";
import { logEvent } from "../src/events/events.js";

// The main watch (src/baseline/main-watch.ts) records the full check's verdict on main's tip in the
// background. The suite's process-wide verdict cache is keyed by SHA, and every fixture repo has
// its own, so these tests share no state.

test("a doc-exempt tip that lands after a red keeps the opener as the named culprit", async () => {
  const { root } = culpritFixture();
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // the seed commit G: green, cached
  const b = change(root, "bad.txt", "b"); // the tip that opens the red
  logEvent(root, { source: "improve", type: "merged", commit: b, summary: "breaks a test" });
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
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // the seed commit: green (no flag)
  fs.writeFileSync(flag, ""); // the failure goes live
  change(root, "a.txt", "a"); // the tip that opens the red
  await watchAt(watch, root);
  fs.rmSync(flag); // the failure goes away
  change(root, "b.txt", "g"); // the tip that turns main green
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_check")[2]?.status, "passed", "the green tip settled");
  assert.equal(eventsOfType(root, "main_culprit").length, 1);
  fs.writeFileSync(flag, ""); // the failure returns on a NEW red
  const c = change(root, "c.txt", "c");
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
  const watch = createMainWatch(root, "main");
  const poll = async () => {
    watch.poll(headSha(root), false, defaultConfig());
    await watch.idle();
  };
  await poll(); // the seed commit: no flag, green, cached
  fs.writeFileSync(path.join(root, ".red-flag"), "red\n");
  sh(root, "git", "add", "--", ".red-flag");
  change(root, "notes.md", "doc one\n");
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
  const watch = createMainWatch(root, "main");
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
  const watch = createMainWatch(root, "main");
  const poll = async () => {
    watch.poll(headSha(root), false, defaultConfig());
    await watch.idle();
  };
  await poll(); // the seed commit: no flag, green, cached
  fs.writeFileSync(path.join(root, ".red-flag"), "red\n");
  sh(root, "git", "add", "--", ".red-flag");
  const red1 = change(root, "notes.md", "r1\n");
  await poll();
  assert.equal(eventsOfType(root, "main_culprit")[0]?.commit, red1);
  sh(root, "git", "rm", "-q", "--", ".red-flag");
  const green1 = change(root, "notes.md", "r1\ng\n"); // removes the flag: a fresh green closes the spell
  await poll();
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "the green clears the spell without naming");
  fs.writeFileSync(path.join(root, ".red-flag"), "red again\n");
  sh(root, "git", "add", "--", ".red-flag");
  const red2 = change(root, "notes.md", "r1\ng\nr2\n");
  await poll();
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 2, "the later red names its own opener");
  assert.equal(culprits[1]?.commit, red2);
  assert.notEqual(red2, green1);
});
