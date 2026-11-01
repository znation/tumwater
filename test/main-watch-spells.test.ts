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
