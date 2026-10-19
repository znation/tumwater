import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch, knownMainFailures, onlyKnownMainFailures } from "../src/baseline/main-watch.js";
import { FAILING_TESTS_MAX } from "../src/build/build-check-report.js";
import { persistBaselineVerdicts } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineVerdictsPath } from "../src/paths.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { logEvent } from "../src/events/events.js";

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
  const saved = JSON.parse(fs.readFileSync(baselineVerdictsPath(root), "utf8")) as { reds: unknown[] };
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
