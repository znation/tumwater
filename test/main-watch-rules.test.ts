/** The deterministic diff rules the main watch runs on main's tip (src/review/diff-rules.ts):
 * a conflict marker, a secret leak, a protected edit or a broken backlog structure is reported as
 * a warning naming the rule and the head, even with no declared build check. A poll covering
 * several commits judges each by its own diff, tree and merging role; a tip whose merging role
 * the watch cannot name skips only the PRINCIPLES half of the protected-edit rule. New heads and
 * culprits live in main-watch.test.ts, confirming a red and quarantine in
 * main-watch-failures.test.ts, red spells in main-watch-spells.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMainWatch } from "../src/baseline/main-watch.js";
import { baselineFixture, runsOf } from "./fixtures/runner-fixtures.js";
import { gitInit, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { change, clockAt, watchAt } from "./fixtures/main-watch-fixtures.js";
import { logEvent } from "../src/events/events.js";

// The hourly cadence (Hourly full check, part 2b/4): a test advancing the injected clock past
// the interval makes the next head's full check run — the run-count assertions below expect it.
const HOUR = 7_200_000; // 2h: clears the seed run's checkedAt (real Date.now, stamped after the clock starts)
import { shortSha } from "../src/text/format.js";

// The main watch (src/baseline/main-watch.ts) records the full check's verdict on main's tip in the
// background. The suite's process-wide verdict cache is keyed by SHA, and every fixture repo has
// its own, so these tests share no state.

// The deterministic diff rules the watch runs on main's tip (PLANS.md "Every commit is verified
// on main, part 1/3"): the full five-check set the watch and gate share — the gate runs only the
// three a later commit cannot repair, the watch runs all five — against the new head. A
// rule failure is reported as a warning naming the rule and the head, within one poll, with no
// confirming re-run. The build stays green in every case, so each tip's build runs once.
test("the watch runs the precheck rules on the tip: a conflict marker names the rule and the head", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root } = baselineFixture("improve", `echo run >> ${counter}; echo ok`);
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root);
  const tip = change(root, "bad.txt", "line one\n<<<<<<< HEAD\n");
  clock.advance(HOUR); // past the interval: this head's full check runs (the run count below)
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
  const clock = clockAt();
  const watch = createMainWatch(root, "main", undefined, clock.now);
  await watchAt(watch, root);
  // A code file keeps the tip's build check running (a doc-only tip would inherit green with no
  // run), so the run count below tells a rule failure apart from a confirming re-run.
  change(root, "a.txt", "a");
  const tip = change(root, "BUGS.md", "# Bugs\n\n## Open\n\nentry one\n\n## Open\n\nentry two\n");
  clock.advance(HOUR); // past the interval: this head's full check runs (the run count below)
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

// A finding stops the walk at its own commit, so the commits after it in the same range are still
// owed a judgment. The pass must mark the finding's commit, not the tip: marking the tip makes the
// next poll of that same head a no-op and silently drops the later commits' rule failures.
test("a rule finding leaves the commits after it to be judged by the next poll", async () => {
  const { root } = baselineFixture("improve", "echo ok");
  const watch = createMainWatch(root, "main");
  await watchAt(watch, root);
  change(root, "first-bad.txt", "line one\n<<<<<<< HEAD\n"); // the first finding stops the walk here
  const tip = change(root, "second-bad.txt", "line one\n<<<<<<< HEAD\n"); // never reached by that walk
  await watchAt(watch, root); // one poll covers both commits and stops at the first
  const first = warningMessages(root);
  assert.ok(
    first.some((m) => m.includes("conflict markers remain in: first-bad.txt")),
    first.join("|"),
  );
  assert.ok(
    !first.some((m) => m.includes("conflict markers remain in: second-bad.txt")),
    first.join("|"),
  );
  await watchAt(watch, root); // same tip: the second commit is still owed a judgment
  const later = warningMessages(root);
  assert.ok(
    later.some(
      (m) => m.includes(shortSha(tip)) && m.includes("conflict markers remain in: second-bad.txt"),
    ),
    later.join("|"),
  );
});
