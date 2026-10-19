import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { persistBaselineVerdicts } from "../src/baseline/main-baseline.js";
import { defaultConfig } from "../src/config/config.js";
import { baselineVerdictsPath } from "../src/paths.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { headSha, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";

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
