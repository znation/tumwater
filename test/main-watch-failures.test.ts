/** The main watch's red verdicts and their failing tests: a red tip is confirmed by re-running
 * only its failing tests (or, with no re-run command, the full check once more) and persists; the
 * newest verdict's failing tests are main's known failures; a test that fails and then passes on
 * the same tree is quarantined, filed once in BUGS.md on main, and released when its bug leaves
 * ## Open. New heads and the culprit a red tip names live in main-watch.test.ts, red spells in
 * main-watch-spells.test.ts, the diff rules in main-watch-rules.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch, knownMainFailures, onlyKnownMainFailures } from "../src/baseline/main-watch.js";
import { FAILING_TESTS_MAX } from "../src/build/build-check-report.js";
import { persistBaselineVerdicts } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineVerdictsPath, quarantinePath } from "../src/paths.js";
import { failRenameSyncOn } from "./helpers/fs-faults.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { change, FAILING_OUTPUT, watchAt } from "./fixtures/main-watch-fixtures.js";
import { loadQuarantine, quarantinedTests, quarantineTests, releaseQuarantine } from "../src/review/known-flakes.js";
import { readJson } from "./helpers/json-read.js";

// The main watch (src/baseline/main-watch.ts) records the full check's verdict on main's tip in the
// background. The suite's process-wide verdict cache is keyed by SHA, and every fixture repo has
// its own, so these tests share no state.

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
