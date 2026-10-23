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
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { logEvent } from "../src/events/events.js";
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

test("a red tip is re-run once, then logged failed with the failing test titles, and persists", async () => {
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

// The culprit search (src/baseline/main-culprit.ts): the check fails while bad.txt is tracked or
// the flag file exists, so a test turns main red with a
// commit and the environment red with the flag.
function culpritFixture(): { root: string; flag: string } {
  const flag = path.join(tmpdir(), "env-red");
  const script = `[ -f ${flag} ] && exit 1; [ -f bad.txt ] && { ${FAILING_OUTPUT}; exit 1; }; echo ok`;
  return { root: baselineFixture("improve", script).root, flag };
}

test("a red tip names the first red commit, its merging runner and the failing tests", async () => {
  const { root } = culpritFixture();
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root); // the seed commit G: green, cached
  const g = headSha(root);
  change(root, "a.txt", "a");
  const b = change(root, "bad.txt", "b");
  logEvent(root, { source: "improve", type: "merged", commit: b, summary: "breaks a test" });
  change(root, "README.md", "docs");
  await watchAt(watch, root);
  const culprits = eventsOfType(root, "main_culprit");
  assert.equal(culprits.length, 1);
  assert.equal(culprits[0]?.commit, b);
  assert.equal(culprits[0]?.runner, "improve");
  assert.equal(culprits[0]?.green, g);
  assert.deepEqual(culprits[0]?.failingTests, ["first", "second", "third"]);
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_culprit").length, 1, "a repeat poll does not search again");
});

test("a culprit with no merged event is named without a runner", async () => {
  const { root } = culpritFixture();
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  const b = change(root, "bad.txt", "b");
  await watchAt(watch, root);
  const culprit = eventsOfType(root, "main_culprit")[0];
  assert.equal(culprit?.commit, b);
  assert.equal("runner" in (culprit ?? {}), false);
});

test("a last green that is red now too is not attributed", async () => {
  const { root, flag } = culpritFixture();
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  change(root, "a.txt", "a");
  fs.writeFileSync(flag, "");
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_culprit").length, 0);
  const warnings = eventsOfType(root, "warning").map((e) => String(e.message));
  assert.ok(warnings.some((m) => m.includes("is red now too — not attributing")), warnings.join("|"));
});

test("a red tip with no cached green below it warns that none was found", async () => {
  const { root } = culpritFixture();
  const watch = createMainWatch(root, "main");
  change(root, "bad.txt", "b"); // the seed was never checked, so no verdict is cached below the tip
  await watchAt(watch, root);
  assert.equal(eventsOfType(root, "main_culprit").length, 0);
  const warnings = eventsOfType(root, "warning").map((e) => String(e.message));
  assert.ok(warnings.some((m) => m.includes("no green commit within 50 first-parent commits")), warnings.join("|"));
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

test("a red naming only quarantined tests is recorded passed and starts no bisect", async () => {
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
