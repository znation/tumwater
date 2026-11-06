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
  const saved = readJson(baselineVerdictsPath(root)) as { reds: Array<{ sha: string; script: string; failingTests: string[]; checkedAt?: number }> };
  // A full-run red stamps when the full check produced it (checkedAt), so the persisted shape
  // carries it — the hourly cadence (part 2b/4) reads it to tell the verdict's age after a restart.
  assert.equal(saved.reds.length, 1);
  assert.ok(Number.isFinite(saved.reds[0]?.checkedAt), "the persisted red carries the full run's checkedAt");
  assert.deepEqual(
    { sha: saved.reds[0]?.sha, script: saved.reds[0]?.script, failingTests: saved.reds[0]?.failingTests },
    { sha: headSha(root), script: "test", failingTests: ["first", "second", "third"] },
  );
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

test("a new head while red is open re-runs only the open failures and drops a passed test from knownMainFailures", async () => {
  // Hourly full check, part 3b/4: a red spell is open and a new head arrives. The watch re-runs
  // only the spell's open failures on the new tip — no full run — and a test that passes leaves
  // the open set (and main's known failures) while the spell stays open.
  const flag = path.join(tmpdir(), "red");
  fs.writeFileSync(flag, "");
  const counter = path.join(tmpdir(), "runs");
  const log = path.join(tmpdir(), "rerun-args");
  const { root } = baselineFixture(
    "improve",
    `echo run >> ${counter}; if [ -f ${flag} ]; then ${FAILING_OUTPUT}; exit 1; fi; echo ok`,
  );
  const rerunAt = (failing: readonly string[]): ReturnType<typeof defaultConfig> => {
    const file = path.join(tmpdir(), `rerun-${failing.length}-${Math.random().toString(36).slice(2)}.sh`);
    fs.writeFileSync(file, rerunScript(log, failing));
    return { ...defaultConfig(), check: { command: "", rerunCommand: `sh ${file}` } };
  };
  const watch = createMainWatch(root, "main");
  // 1. Open the red: the full check fails (flag set) and the confirming re-run fails all three.
  watch.poll(headSha(root), false, rerunAt(["first", "second", "third"]));
  await watch.idle();
  assert.deepEqual(knownMainFailures(root), ["first", "second", "third"]);
  const firstRuns = runsOf(counter);
  assert.equal(firstRuns, 1, "one full run opened the red");
  // 2. A new head (still red, the flag stays): re-runs only the open failures; first passes.
  change(root, "a.txt", "a");
  watch.poll(headSha(root), false, rerunAt(["second", "third"]));
  await watch.idle();
  assert.equal(runsOf(counter), firstRuns, "no full run on the narrowing head");
  assert.deepEqual(knownMainFailures(root), ["second", "third"], "first, which passed, left the open set");
  const narrowed = eventsOfType(root, "main_check").at(-1);
  assert.equal(narrowed?.status, "failed");
  assert.equal(narrowed?.cleared, undefined, "the re-check is a narrowing red, not a clear");
  assert.deepEqual(narrowed?.failingTests, ["second", "third"]);
  // 3. One more new head: only second and third re-run, no full run, both still fail.
  change(root, "b.txt", "b");
  watch.poll(headSha(root), false, rerunAt(["second", "third"]));
  await watch.idle();
  assert.equal(runsOf(counter), firstRuns, "still no full run: narrowing is per-head");
  assert.deepEqual(knownMainFailures(root), ["second", "third"]);
});

test("a new head while red is open falls back to a full check when the open failures cannot be re-run alone", async () => {
  // Hourly full check, part 3b/4: the open set cannot be narrowed (no re-run command on this
  // config), so the head re-checks in full — pre-3b/4 behavior preserved for such projects.
  const flag = path.join(tmpdir(), "red");
  fs.writeFileSync(flag, "");
  const counter = path.join(tmpdir(), "runs");
  const log = path.join(tmpdir(), "rerun-args");
  const { root } = baselineFixture(
    "improve",
    `echo run >> ${counter}; if [ -f ${flag} ]; then ${FAILING_OUTPUT}; exit 1; fi; echo ok`,
  );
  const watch = createMainWatch(root, "main");
  // 1. Open the red with a re-run command so the confirming re-run is real.
  watch.poll(headSha(root), false, rerunConfig(rerunScript(log, ["first", "second", "third"])));
  await watch.idle();
  assert.deepEqual(knownMainFailures(root), ["first", "second", "third"]);
  const firstRuns = runsOf(counter);
  assert.equal(firstRuns, 1);
  // 2. A new head with NO re-run command: the open spell cannot narrow, so a full check runs.
  change(root, "a.txt", "a");
  watch.poll(headSha(root), false, defaultConfig());
  await watch.idle();
  // The fallback full check turns red, then — with no re-run command — is confirmed by a second
  // full run (pre-3b/4 behavior), never a narrowing rerun.
  assert.equal(runsOf(counter), firstRuns + 2, "the fallback is the full check plus its in-full confirmation");
  assert.deepEqual(knownMainFailures(root), ["first", "second", "third"], "still failing in full, the open set stands");
});

test("a fallback full check while red is open re-settles the open failures from that check", async () => {
  // Hourly full check, part 3b/4: the head cannot be narrowed (no re-run command), so the full
  // check decides its failing set. A failure the head healed drops out and a new one is added;
  // the opener stays blamed, and knownMainFailures reads the full check's set, not the stale
  // open set from the spell's opener.
  const allFlag = path.join(tmpdir(), "red-all");
  const secondFlag = path.join(tmpdir(), "red-second");
  fs.writeFileSync(allFlag, "");
  const counter = path.join(tmpdir(), "runs");
  const log = path.join(tmpdir(), "rerun-args");
  const { root } = baselineFixture(
    "improve",
    `echo run >> ${counter}; if [ -f ${allFlag} ]; then ${FAILING_OUTPUT}; exit 1; fi; ` +
      `if [ -f ${secondFlag} ]; then printf '✖ second (1ms)\\n✖ failing tests:\\n✖ second (1ms)\\n'; exit 1; fi; echo ok`,
  );
  const watch = createMainWatch(root, "main");
  watch.poll(headSha(root), false, rerunConfig(rerunScript(log, ["first", "second", "third"])));
  await watch.idle();
  assert.deepEqual(knownMainFailures(root), ["first", "second", "third"]);
  // The next head heals first and third, but second still fails; no re-run command, so the full
  // check settles the set.
  fs.rmSync(allFlag);
  fs.writeFileSync(secondFlag, "");
  change(root, "a.txt", "a");
  watch.poll(headSha(root), false, defaultConfig());
  await watch.idle();
  assert.deepEqual(knownMainFailures(root), ["second"], "the full check's set replaces the stale open set");
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "the fallback does not re-attribute the spell");
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
