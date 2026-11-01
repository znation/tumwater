import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch, knownMainFailures, onlyKnownMainFailures } from "../src/baseline/main-watch.js";
import { queueCulpritHeal } from "../src/baseline/main-red.js";
import { queuedRolePrompts } from "../src/inbox/inbox.js";
import { FAILING_TESTS_MAX } from "../src/build/build-check-report.js";
import { persistBaselineVerdicts } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineVerdictsPath, quarantinePath } from "../src/paths.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { gitInit, headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { logEvent } from "../src/events/events.js";
import { shortSha } from "../src/text/format.js";
import { loadQuarantine, quarantinedTests, quarantineTests, releaseQuarantine } from "../src/review/known-flakes.js";
import { readJson } from "./helpers/json-read.js";

// The main watch (src/baseline/main-watch.ts) records the full check's verdict on main's tip in the
// background. The suite's process-wide verdict cache is keyed by SHA, and every fixture repo has
// its own, so these tests share no state.

const FAILING_OUTPUT = "printf '✖ first (1.2ms)\\n✖ second\\n✖ third (3ms)\\n✖ failing tests:\\n✖ first (1.2ms)\\n'";

function change(root: string, file: string, content: string): string {
  fs.writeFileSync(path.join(root, file), content);
  // Only the named file: `add -A` would also stage the fixture's role worktree under .tumwater/.
  sh(root, "git", "add", "--", file);
  sh(root, "git", "commit", "-m", `edit ${file}`);
  return headSha(root);
}

async function watchAt(watch: ReturnType<typeof createMainWatch>, root: string, held = false): Promise<void> {
  watch.poll(headSha(root), held, defaultConfig());
  await watch.idle();
}

test("a new head is checked once and logged as one passed main_check; a repeat poll does nothing", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const watch = createMainWatch(root, "main");
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
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  change(root, "a.txt", "a");
  const tip = change(root, "b.txt", "b");
  await watchAt(watch, root);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2);
  assert.equal(checks[1]?.sha, tip);
  assert.equal(checks[1]?.covered, 2);
  assert.equal(runsOf(counter), 2);
});

test("a red tip with no re-run command is re-run once in full, then logged failed with the failing test titles, and persists", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; ${FAILING_OUTPUT}; exit 1`);
  persistBaselineVerdicts(root);
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.status, "failed");
  assert.deepEqual(checks[0]?.failingTests, ["first", "second", "third"]);
  assert.equal(runsOf(counter), 2, "the red was confirmed by one more run");
  const saved = readJson(baselineVerdictsPath(root)) as { reds: unknown[] };
  assert.deepEqual(saved.reds, [
    { sha: headSha(root), script: "test", failingTests: ["first", "second", "third"] },
  ]);
});

/** A config whose re-run command is `script`: the watch confirms a red with it, appending one
 * `#<name>` argument per failing test (the fixture's output names no test file). */
function rerunConfig(script: string): ReturnType<typeof defaultConfig> {
  const file = path.join(tmpdir(), "rerun.sh");
  fs.writeFileSync(file, script);
  return { ...defaultConfig(), check: { command: "", rerunCommand: `sh ${file}` } };
}

/** A re-run that logs its arguments to `log` and fails the named tests in `failing`. */
function rerunScript(log: string, failing: readonly string[]): string {
  const cases = failing.map((t) => `*#${t}) echo '✖ ${t} (1ms)'; fail=1;;`).join(" ");
  return `echo "$@" >> ${log}\nfor a in "$@"; do case "$a" in ${cases} *) ;; esac; done\nexit \${fail:-0}\n`;
}

async function watchWith(root: string, config: ReturnType<typeof defaultConfig>): Promise<void> {
  const watch = createMainWatch(root, "main");
  watch.poll(headSha(root), false, config);
  await watch.idle();
}

test("a red tip is confirmed by re-running only its failing tests: the full check runs once", async () => {
  const counter = path.join(tmpdir(), "runs");
  const log = path.join(tmpdir(), "rerun-args");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; ${FAILING_OUTPUT}; exit 1`);
  await watchWith(root, rerunConfig(rerunScript(log, ["first"])));
  assert.equal(runsOf(counter), 1, "no second full run");
  assert.equal(fs.readFileSync(log, "utf8").trim(), "#first #second #third", "only the failing tests re-ran");
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks[0]?.status, "failed");
  assert.deepEqual(checks[0]?.failingTests, ["first"], "the red narrows to the test that failed again");
  assert.deepEqual(quarantinedTests(root), ["second", "third"], "the two that passed alone are flakes");
  assert.deepEqual(
    eventsOfType(root, "build_check").map((e) => `${e.scope}:${e.status}`),
    ["baseline:failed", "rerun:failed"],
  );
});

test("a red whose failing tests all pass when re-run alone is recorded passed and quarantined", async () => {
  const counter = path.join(tmpdir(), "runs");
  const log = path.join(tmpdir(), "rerun-args");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; ${FAILING_OUTPUT}; exit 1`);
  await watchWith(root, rerunConfig(rerunScript(log, [])));
  assert.equal(runsOf(counter), 1);
  assert.equal(eventsOfType(root, "main_check")[0]?.status, "passed");
  assert.equal(eventsOfType(root, "main_culprit").length, 0);
  assert.deepEqual(quarantinedTests(root), ["first", "second", "third"]);
});

test("a re-run that reaches no verdict leaves the first red standing, with no second full run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; ${FAILING_OUTPUT}; exit 1`);
  await watchWith(root, rerunConfig("echo 'error TS2345: boom' >&2\nexit 1\n"));
  assert.equal(runsOf(counter), 1);
  assert.deepEqual(eventsOfType(root, "main_check")[0]?.failingTests, ["first", "second", "third"]);
  assert.deepEqual(quarantinedTests(root), [], "nothing passed, so nothing is a flake");
});

test("a doc-only commit on a checked head inherits green without a run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  change(root, "README.md", "docs");
  await watchAt(watch, root);
  const checks = eventsOfType(root, "main_check");
  assert.equal(checks.length, 2);
  assert.equal(checks[1]?.status, "passed");
  assert.equal(checks[1]?.inherited, true);
  assert.equal(runsOf(counter), 1);
});

test("a held team starts no watch run", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const watch = createMainWatch(root, "main");
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
  assert.equal(eventsOfType(root, "main_check").length, 0, "an unreadable main records no verdict");
});

test("the newest verdict's failing tests are main's known failures; a later green clears them", async () => {
  const flag = path.join(tmpdir(), "red");
  fs.writeFileSync(flag, "");
  const { root } = baselineFixture("improve", `if [ -f ${flag} ]; then ${FAILING_OUTPUT}; exit 1; fi; echo ok`);
  const watch = createMainWatch(root, "main");
  assert.deepEqual(knownMainFailures(root), []);
  await watchAt(watch, root);
  assert.deepEqual(knownMainFailures(root), ["first", "second", "third"]);
  assert.deepEqual(onlyKnownMainFailures(root, ["second", "first"]), ["second", "first"]);
  assert.equal(onlyKnownMainFailures(root, ["first", "other"]), null);
  assert.equal(onlyKnownMainFailures(root, []), null);
  assert.equal(onlyKnownMainFailures(root, undefined), null);
  fs.rmSync(flag);
  change(root, "a.txt", "a");
  await watchAt(watch, root);
  assert.deepEqual(knownMainFailures(root), []);
});

test("a failing list at the parser's cap is never counted as only known failures", async () => {
  const names = Array.from({ length: FAILING_TESTS_MAX }, (_, i) => `t${i}`);
  const script = `printf '${names.map((n) => `✖ ${n}\\n`).join("")}'; exit 1`;
  const { root } = baselineFixture("improve", script);
  await watchAt(createMainWatch(root, "main"), root);
  assert.equal(knownMainFailures(root).length, FAILING_TESTS_MAX);
  assert.equal(onlyKnownMainFailures(root, names.slice(0, FAILING_TESTS_MAX - 1))?.length, FAILING_TESTS_MAX - 1);
  assert.equal(onlyKnownMainFailures(root, names), null);
});

// The red tip's own attribution ("Every commit is verified on main, part 2/3"): the watch checks
// each new tip, so the newest head is the culprit for whatever it finds. The check fails while
// bad.txt is tracked, so a test turns main red with a commit and asserts the tip names itself.
function culpritFixture(): { root: string } {
  const script = `[ -f bad.txt ] && { ${FAILING_OUTPUT}; exit 1; }; echo ok`;
  return { root: baselineFixture("improve", script).root };
}

test("a red tip names itself as the culprit, with its merging runner and the failing tests", async () => {
  const { root } = culpritFixture();
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // the seed commit G: green, cached
  const b = change(root, "bad.txt", "b"); // the red tip itself
  logEvent(root, { source: "improve", type: "merged", commit: b, summary: "breaks a test" });
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
  const watch = createMainWatch(root, "main", (culprit) => {
    queueCulpritHeal(root, culprit.tip, { culprit: culprit.commit, failingTests: culprit.failingTests });
  });
  await watchAt(watch, root); // the seed commit G: green, cached
  const b = change(root, "bad.txt", "b"); // the red tip itself
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
  const watch = createMainWatch(root, "main", (culprit) => {
    queueCulpritHeal(root, culprit.tip, { culprit: culprit.commit, failingTests: culprit.failingTests });
  });
  await watchAt(watch, root);
  change(root, "bad.txt", "b");
  await watchAt(watch, root);
  const prompt = queuedRolePrompts(root, "ci")[0] ?? "";
  assert.ok(prompt.includes("with: npm run test:rerun -- '#first' '#second' '#third'"), prompt);
});

function mainRedCulpritClause(sha: string): string {
  return `The watch named ${shortSha(sha)} as the commit that turned it red`;
}

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

test("a red tip with no merged event is named without a runner", async () => {
  const { root } = culpritFixture();
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const b = change(root, "bad.txt", "b");
  await watchAt(watch, root);
  const culprit = eventsOfType(root, "main_culprit")[0];
  assert.equal(culprit?.commit, b, "the tip is its own culprit");
  assert.equal("runner" in (culprit ?? {}), false);
  assert.deepEqual(culprit?.failingTests, ["first", "second", "third"]);
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

test("a red whose breaking commit is intermediate still names the newest tip as the culprit", async () => {
  const { root } = culpritFixture();
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // the seed commit G: green, cached
  change(root, "bad.txt", "b"); // the intermediate commit that actually breaks the build
  const tip = change(root, "good.txt", "g"); // a later commit on top; its tree is still red
  logEvent(root, { source: "improve", type: "merged", commit: tip, summary: "breaks a test" });
  await watchAt(watch, root);
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1);
  assert.equal(culprits[0]?.commit, tip, "the newest head is named, not the intermediate breaking commit");
  assert.equal(culprits[0]?.runner, "improve");
  assert.deepEqual(culprits[0]?.failingTests, ["first", "second", "third"]);
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "a repeat poll does not attribute again");
});

test("a red whose confirming re-run passes quarantines the failing tests and files one BUGS.md entry on main", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture(
    "improve",
    `echo run >> ${counter}; if [ "$(wc -l < ${counter})" -eq 1 ]; then ${FAILING_OUTPUT}; exit 1; fi; echo ok`,
  );
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_check")[0]?.status, "passed");
  assert.deepEqual(
    loadQuarantine(root).map((e) => e.test),
    ["first", "second", "third"],
  );
  await watchAt(watch, root); // the next poll files them
  const bugs = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  assert.equal(bugs.match(/failed, then passed on the same tree \(quarantined by tumwater/g)?.length, 3);
  assert.match(sh(root, "git", "log", "-1", "--format=%s"), /quarantined flaky tests/);
  assert.ok(loadQuarantine(root).every((e) => e.bug !== "" && e.tail === undefined));
  assert.deepEqual(onlyKnownMainFailures(root, ["first"]), ["first"]);
});

test("a red naming only quarantined tests is recorded passed and starts no culprit", async () => {
  const { root } = baselineFixture("improve", `${FAILING_OUTPUT}; exit 1`);
  quarantineTests(root, ["first", "second", "third"], "");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const check = eventsOfType(root, "main_check")[0];
  assert.equal(check?.status, "passed");
  assert.deepEqual(check?.quarantined, ["first", "second", "third"]);
  assert.equal(eventsOfType(root, "main_culprit").length, 0);
});

test("moving a quarantined test's bug out of ## Open releases it", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  quarantineTests(root, ["flaky one"], "boom");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  assert.deepEqual(quarantinedTests(root), ["flaky one"]);
  const file = path.join(root, "BUGS.md");
  const md = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, md.replace("## Open", "## Fixed"));
  releaseQuarantine(root);
  assert.deepEqual(quarantinedTests(root), []);
});

test("a filing whose quarantine.json write failed is not filed again on the next poll", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  quarantineTests(root, ["flaky one"], "boom");
  const watch = createMainWatch(root, "main");
  const restore = failRenameSyncOn(quarantinePath(root), "disk full");
  try {
    await watchAt(watch, root);
  } finally {
    restore();
  }
  assert.equal(loadQuarantine(root)[0]?.bug, "");
  const warnings = eventsOfType(root, "warning").map((e) => String(e.message));
  assert.ok(warnings.some((m) => m.includes("quarantine housekeeping failed")), warnings.join("|"));
  const commits = sh(root, "git", "rev-list", "--count", "HEAD");
  await watchAt(watch, root);
  const bugs = fs.readFileSync(path.join(root, "BUGS.md"), "utf8");
  assert.equal(bugs.match(/failed, then passed on the same tree \(quarantined by tumwater/g)?.length, 1);
  assert.equal(sh(root, "git", "rev-list", "--count", "HEAD"), commits);
  const bug = loadQuarantine(root)[0]?.bug ?? "";
  assert.ok(bug.startsWith("`flaky one` failed"), bug);
});

test("a quarantined test whose filed bug leaves ## Open is released with a warning on the next poll", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  quarantineTests(root, ["flaky one"], "boom");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // poll 1 files the pending quarantine into BUGS.md on main
  assert.notEqual(loadQuarantine(root)[0]?.bug, "");
  const file = path.join(root, "BUGS.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## Open", "## Fixed"));
  await watchAt(watch, root); // poll 2's housekeeping releases it with a warning
  assert.deepEqual(quarantinedTests(root), []);
  const warnings = eventsOfType(root, "warning").map((e) => String(e.message));
  assert.ok(
    warnings.some((m) => m.includes("quarantine released") && m.includes("flaky one")),
    warnings.join("|"),
  );
});

test("a quarantine the primary checkout cannot file warns once for the reason and stays pending", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  change(root, "BUGS.md", "# tumwater\n\n## Open\n\n_None yet._\n"); // track BUGS.md on main
  quarantineTests(root, ["flaky one"], "boom");
  fs.appendFileSync(path.join(root, "BUGS.md"), "# dirty\n"); // a tracked modification refuses the filing
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  assert.equal(loadQuarantine(root)[0]?.bug, "");
  const warnings = eventsOfType(root, "warning").map((e) => String(e.message));
  assert.ok(
    warnings.some((m) => m.includes("not filed in BUGS.md yet") && m.includes("BUGS.md has uncommitted changes")),
    warnings.join("|"),
  );
});

// The deterministic diff rules the watch runs on main's tip (PLANS.md "Every commit is verified
// on main, part 1/3"): the full five-check set the watch and gate share — the gate runs only the
// three a later commit cannot repair, the watch runs all five — against the new head. A
// rule failure is reported as a warning naming the rule and the head, within one poll, with no
// confirming re-run. The build stays green in every case, so each tip's build runs once.
test("the watch runs the precheck rules on the tip: a conflict marker names the rule and the head", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const tip = change(root, "bad.txt", "line one\n<<<<<<< HEAD\n");
  await watchAt(watch, root);
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes(shortSha(tip)) && m.includes("conflict markers remain in")),
    warnings.join("|"),
  );
  assert.equal(runsOf(counter), 2, "one run per head — no confirming re-run for a rule failure");
});

test("the watch runs the precheck rules on the tip: a secret leak names the rule and the head", async () => {
  process.env.TUMWATER_TEST_SECRET = "watch-leaky-secret-123456789";
  try {
    const { root } = baselineFixture("improve", "echo ok");
    const watch = createMainWatch(root, "main");
    await watchAt(watch, root);
    const tip = change(root, "dump.txt", `token watch-leaky-secret-123456789\n`);
    await watchAt(watch, root);
    const warnings = warningMessages(root);
    assert.ok(
      warnings.some(
        (m) => m.includes(shortSha(tip)) && m.includes("contains the value of $TUMWATER_TEST_SECRET"),
      ),
      warnings.join("|"),
    );
  } finally {
    delete process.env.TUMWATER_TEST_SECRET;
  }
});

test("the watch runs the precheck rules on the tip: a protected edit names the rule, the head and the role", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const tip = change(root, "PRINCIPLES.md", "One principle.\n");
  logEvent(root, { source: "improve", type: "merged", commit: tip, summary: "edits PRINCIPLES" });
  await watchAt(watch, root);
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some(
      (m) => m.includes(shortSha(tip)) && m.includes("PRINCIPLES.md is edited by the improve role"),
    ),
    warnings.join("|"),
  );
});

test("the watch runs the precheck rules on the tip: a broken backlog structure names the rule and the head", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  // A code file keeps the tip's build check running (a doc-only tip would inherit green with no
  // run), so the run count below tells a rule failure apart from a confirming re-run.
  change(root, "a.txt", "a");
  const tip = change(root, "BUGS.md", "# Bugs\n\n## Open\n\nentry one\n\n## Open\n\nentry two\n");
  await watchAt(watch, root);
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes(shortSha(tip)) && m.includes('adds another "## Open" heading')),
    warnings.join("|"),
  );
  assert.equal(runsOf(counter), 2, "one run per head — no confirming re-run for a rule failure");
});

// A tip whose merging role the watch cannot name (no recent `merged` event covers it) is no basis
// for calling a PRINCIPLES.md edit unauthorized: unknown roles are skipped, not condemned. The
// protected-edit finding needs an attribution the union-of-commits diff plus tip-only events do
// not reliably give, so an unattributed tip produces no such warning.
test("the watch does not call a PRINCIPLES edit unauthorized when it cannot name the merging role", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  change(root, "PRINCIPLES.md", "One principle.\n"); // no merged event names the tip
  await watchAt(watch, root);
  const warnings = warningMessages(root);
  assert.ok(
    !warnings.some((m) => m.includes("PRINCIPLES.md is edited by")),
    warnings.join("|"),
  );
});

// The diff rules run on every tip the watch covers in a poll, even when there is no declared
// build check at all — a repo with nothing to run has no build-red path, but its landings are
// still judged by the same deterministic checks ("Every commit is verified on main, part 1/3").
test("the watch runs the diff rules on a tip even with no declared build check", async () => {
  const root = path.join(tmpdir(), "nocheck");
  fs.mkdirSync(root, { recursive: true });
  gitInit(root);
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // first tip: no base yet, so no diff rules fire
  const tip = change(root, "bad.txt", "line one\n<<<<<<< HEAD\n");
  await watchAt(watch, root);
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes(shortSha(tip)) && m.includes("conflict markers remain in")),
    warnings.join("|"),
  );
});

// The brief-block rule is role-independent (briefEditReason): its edit is forbidden for every
// role alike, so the watch still reports it on an unattributed head — a merged event the watch
// cannot name is no excuse to let a brief edit land on main un-watched. The PRINCIPLES half of
// the protected-edit rule alone needs an attribution.
test("the watch reports a brief-block edit even when it cannot name the merging role", async () => {
  const root = path.join(tmpdir(), "briefwatch");
  fs.mkdirSync(root, { recursive: true });
  gitInit(root);
  const base = "# T\n\n<!-- tumwater:prompt:start -->\nthe prompt\n<!-- tumwater:prompt:end -->\n\n## Status\n\nold\n";
  fs.writeFileSync(path.join(root, "README.md"), base);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // first tip: no base yet, so no diff rules fire
  const tip = change(root, "README.md", base.replace("the prompt", "other")); // no merged event names the tip
  await watchAt(watch, root);
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some(
      (m) => m.includes(shortSha(tip)) && m.includes("changes the brief between the tumwater:prompt markers"),
    ),
    warnings.join("|"),
  );
});

// A poll can cover several commits at once (the watch missed an intermediate head). The diff of
// that range is judged per commit with its own merged-event role, not the tip's: a legitimate
// director/steward PRINCIPLES.md edit in an intermediate commit is authorized on its own, and is
// not made unauthorized by a later commit that some other role merged.
test("an authorized PRINCIPLES edit in an intermediate commit is not blamed on the tip's merging role", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const principles = change(root, "PRINCIPLES.md", "One principle.\n");
  logEvent(root, { source: "steward", type: "merged", commit: principles, summary: "edits PRINCIPLES" });
  const tip = change(root, "a.txt", "a"); // merged later by a role outside director/steward
  logEvent(root, { source: "improve", type: "merged", commit: tip, summary: "adds a" });
  await watchAt(watch, root); // one poll covers both commits
  const warnings = warningMessages(root);
  assert.ok(!warnings.some((m) => m.includes("PRINCIPLES.md is edited by")), warnings.join("|"));
});

// The per-commit attribution is not a blind spot: an unauthorized PRINCIPLES edit in the
// intermediate commit is still reported even though the tip's own diff is clean.
test("an unauthorized PRINCIPLES edit in an intermediate commit is still reported", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const principles = change(root, "PRINCIPLES.md", "One principle.\n");
  logEvent(root, { source: "improve", type: "merged", commit: principles, summary: "edits PRINCIPLES" });
  const tip = change(root, "a.txt", "a");
  logEvent(root, { source: "improve", type: "merged", commit: tip, summary: "adds a" });
  await watchAt(watch, root); // one poll covers both commits
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes("PRINCIPLES.md is edited by the improve role")),
    warnings.join("|"),
  );
});

// Judging a commit "by its own diff" is literal, not just attribution: the diff rules read the
// change's "head" side from the worktree, so the mirror checkout must sit on the commit being
// judged — a conflict marker an intermediate commit leaves behind is still reported even when a
// later commit restores the tip to a clean file.
test("an intermediate commit's own conflict marker is reported even when a later commit clears it", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  change(root, "bad.txt", "line one\n<<<<<<< HEAD\n"); // intermediate commit leaves a conflict marker
  const tip = change(root, "bad.txt", "line one\n"); // the tip clears it, so only the commit owns it
  await watchAt(watch, root); // one poll covers both commits
  const warnings = warningMessages(root);
  assert.ok(
    warnings.some((m) => m.includes(shortSha(tip)) && m.includes("conflict markers remain in")),
    warnings.join("|"),
  );
});
