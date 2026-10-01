import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bugfixMainRedNote, mainRedGate, mainTipVerdict } from "../src/main-red.js";
import { defaultConfig } from "../src/config.js";
import { readEvents } from "../src/event-read.js";
import { shortSha } from "../src/text.js";
import { eventsOfType, harnessWarnings } from "./log-fixtures.js";
import { baselineFixture, fakeNpm, runsOf } from "./loop-fixtures.js";
import { pathReplace } from "./fake-commands.js";
import { gitOnlyBinDir, mainSha, makeRepo, tmpdir, worktreeAt } from "./repo-fixtures.js";
import { scriptedSampler, woke } from "./sleep-clock.js";

// Unit coverage for the red-main baseline gate (src/main-red.ts): the policy layer on top of
// checkMainBaseline — which roles it blocks, what it logs (one build_check per actual run,
// under the role that paid for it; one harness-level warning per newly-discovered red SHA),
// and its warn-and-proceed semantics for environmental skips. The underlying detection,
// execution, and per-SHA cache machinery is covered in build-check.test.ts.

const ROLE = "coverage"; // a BASELINE_BLOCKED_ROLES member (code-producing)

test("mainRedGate lets a non-blocked role through without running the check", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  const restore = fakeNpm(`echo run >> ${counter}; exit 0`);
  try {
    // A bookkeeping role is never gated: no check runs and nothing is logged — even though
    // main would be red for the code roles.
    const blocked = await mainRedGate(root, "steward", wt);
    assert.equal(blocked, null);
    assert.equal(runsOf(counter), 0, "the baseline check never ran");
    assert.deepEqual(readEvents(root), [], "no events for an ungated role");
  } finally {
    restore();
  }
});

test("mainRedGate proceeds on a green main and prices the run under the role", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo ok >> ${counter}; exit 0`);
  const restore = fakeNpm(`echo ok >> ${counter}; exit 0`);
  try {
    assert.equal(await mainRedGate(root, ROLE, wt), null, "green main never blocks authoring");
    assert.equal(runsOf(counter), 1, "the check ran once for the SHA");
    const events = readEvents(root);
    assert.equal(events.length, 1, "one build_check event, no warnings");
    const check = events[0];
    assert.ok(check);
    assert.equal(check.type, "build_check");
    assert.equal(check.loop, ROLE, "priced under the role that paid for it");
    assert.equal(check.scope, "baseline", "distinguished from the review gate's pre-check");
    assert.equal(check.status, "passed");
    assert.equal(check.script, "test");
    assert.ok((check as { durationMs?: number }).durationMs! >= 0);
  } finally {
    restore();
  }
});

test("mainRedGate blocks a red main with the terminal outcome and a harness-level warning", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo baseline-failure; echo run >> ${counter}; exit 1`);
  const restore = fakeNpm(`echo baseline-failure; echo run >> ${counter}; exit 1`);
  try {
    const blocked = await mainRedGate(root, ROLE, wt);
    // The cause rides the outcome (BUGS.md 2026-09-28): the tick's tick_end must be able to
    // name what broke, not leave the digest's main_red cells a bare count.
    const sha = mainSha(root);
    assert.deepEqual(blocked, {
      result: "main_red",
      summary: "code merges blocked until main is green",
      error: `main ${shortSha(sha)} is red (test: baseline-failure) — authoring skipped until main is green`,
    });

    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.ok(check);
    assert.equal(check.loop, ROLE);
    assert.equal(check.status, "failed");
    assert.equal(check.script, "test");

    const warnings = events.filter((e) => e.type === "warning");
    assert.equal(warnings.length, 1, "one harness-level warning for the newly-discovered red SHA");
    const warning = warnings[0];
    assert.ok(warning);
    assert.equal(warning.loop, "harness", "fleet-wide, not per role");
    const message = warning as { message?: string };
    assert.ok(message.message?.includes(shortSha(sha)), `warning names the red SHA: ${message.message}`);
    assert.ok(message.message?.includes("test"), "warning names the failing script");
    assert.ok(message.message?.includes("baseline-failure"), "warning carries the failure's first line");
  } finally {
    restore();
  }
});

test("mainRedGate warns once per red SHA: a repeat tick on the same HEAD re-blocks silently", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  const restore = fakeNpm(`echo run >> ${counter}; exit 1`);
  try {
    assert.equal((await mainRedGate(root, ROLE, wt))?.result, "main_red");
    // A second blocked role waking on the same SHA (or the same role's next tick) must not
    // re-run the suite or re-log the fleet-wide warning.
    const again = await mainRedGate(root, "feature", wt);
    assert.equal(again?.result, "main_red");
    assert.equal(runsOf(counter), 1, "the verdict is cached per SHA — no second run");
    const warnings = harnessWarnings(root);
    assert.equal(warnings.length, 1, "one harness warning for the red SHA, not one per blocked tick");
  } finally {
    restore();
  }
});

test("mainRedGate blocks a user-defined loop on red main like the code roles", async () => {
  // A custom's charter may produce code, so it is blocked exactly like feature/improve
  // (plans/user-defined-loops.md). Customs come from tumwater.json, not the catalog — declare
  // one in the fixture repo before the gate reads the live config.
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);
  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({ customLoops: [{ name: "docs-auditor", task: "Keep the docs current." }] }),
  );
  const restore = fakeNpm(`echo run >> ${counter}; exit 1`);
  try {
    assert.equal(
      (await mainRedGate(root, "docs-auditor", wt))?.result,
      "main_red",
      "a custom loop's fresh tick on red main is blocked like feature's",
    );
    // The check ran once under the role that paid for it — same pricing as a built-in.
    assert.equal(runsOf(counter), 1);
    const checks = eventsOfType(root, "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.loop, "docs-auditor");
    // A role that is neither in the catalog nor in customLoops still passes through ungated.
    assert.equal(await mainRedGate(root, "not-a-role", wt), null);
  } finally {
    restore();
  }
});

test("mainRedGate warns under the role and proceeds when npm is missing", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(ROLE, `echo run >> ${counter}; exit 1`);

  // A PATH that keeps git (the helper keys by HEAD) but drops npm — the real-world shape of a
  // machine without node. The skip must warn and proceed, never block authoring.
  const partialBin = gitOnlyBinDir("no-npm-");
  const restorePath = pathReplace(partialBin);
  try {
    assert.equal(await mainRedGate(root, ROLE, wt), null, "an environmental skip never blocks");
    assert.equal(runsOf(counter), 0, "nothing ran — npm could not even start");

    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.ok(check);
    assert.equal(check.status, "skipped");
    assert.equal(check.loop, ROLE);
    const warnings = events.filter((e) => e.type === "warning");
    assert.equal(warnings.length, 1);
    const warning = warnings[0];
    assert.ok(warning);
    assert.equal(warning.loop, ROLE, "the skip is warned under the role that hit it");
    assert.ok(
      (warning as { message?: string }).message?.includes("no npm on PATH"),
      `skip reason in warning: ${(warning as { message?: string }).message}`,
    );
  } finally {
    restorePath();
  }
});

// The baseline's timeout warning names the bound the run was armed with — a configured
// command's own timeoutSeconds — not the npm default: pre-fix it always said "300s" (BUGS.md
// 2026-09-21, the warning that named a bound the check did not run under). The event carries
// the armed bound too, beside how late the deadline fired.
test("mainRedGate's timeout warning names the bound the baseline check actually ran under", async () => {
  const { root, wt } = baselineFixture(ROLE, "echo baseline-timeout-bound; exit 0");
  fs.writeFileSync(
    path.join(root, "tumwater.json"),
    JSON.stringify({ check: { command: "sleep 30", timeoutSeconds: 0.5 } }),
  );
  assert.equal(await mainRedGate(root, ROLE, wt), null, "a timed-out baseline never blocks authoring");
  const events = readEvents(root);
  const check = events.find((e) => e.type === "build_check");
  assert.equal(check?.status, "skipped");
  assert.equal(check?.timeoutMs, 500, "the event names the armed bound");
  assert.equal(typeof check?.deadlineLateMs, "number");
  const warning = events.find((e) => e.type === "warning");
  assert.equal(
    warning?.message,
    "main baseline check timed out after 0.5s; proceeding with authoring unverified",
  );
});

test("bugfixMainRedNote hands the healer the failing script and headline, warning once", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo healer-failure-line; echo run >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    const note = await bugfixMainRedNote(root, "bugfix", wt);
    assert.ok(note, "a red main yields a note for the healer");
    assert.match(note, /^<main-red>/);
    assert.match(note, /<\/main-red>$/);
    assert.ok(note.includes("test"), "names the failing script");
    assert.ok(note.includes("healer-failure-line"), "carries the failureHeadline line");

    // The check ran once, priced under the healer; the fleet warning fired under "harness".
    assert.equal(runsOf(counter), 1);
    const events = readEvents(root);
    const checks = events.filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.loop, "bugfix");
    assert.equal(checks[0]?.scope, "baseline");
    assert.equal(checks[0]?.status, "failed");
    const warnings = events.filter((e) => e.type === "warning" && e.loop === "harness");
    assert.equal(warnings.length, 1, "one fleet-wide warning for the red SHA");

    // A blocked role on the same SHA still reads the cached red and does NOT add a second
    // warning: the healer's check and the gate share the once-per-SHA guard.
    const blocked = await mainRedGate(root, "feature", wt);
    assert.equal(blocked?.result, "main_red");
    assert.equal(runsOf(counter), 1, "the cached verdict was reused — no second run");
    assert.equal(
      harnessWarnings(root).length,
      1,
      "the healer's check did not add a second warning",
    );
  } finally {
    restore();
  }
});

test("bugfixMainRedNote yields no note on a green main", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo green-healer >> ${counter}; exit 0`;
  const { root, wt } = baselineFixture(ROLE, script);
  const restore = fakeNpm(script);
  try {
    assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
    assert.equal(runsOf(counter), 1, "the green check still ran once");
    assert.equal(eventsOfType(root, "warning").length, 0);
  } finally {
    restore();
  }
});

test("bugfixMainRedNote yields no note when no check is declared", async () => {
  const base = tmpdir("mainred-bugfix-none-");
  const root = makeRepo(path.join(base, "project"));
  const wt = worktreeAt(root, "bugfix");
  assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
  assert.deepEqual(readEvents(root), [], "nothing to verify, nothing to say");
});

test("bugfixMainRedNote yields no note on an environmental skip (no npm)", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo skip-healer >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  // A PATH that keeps git but drops npm — the check cannot run, so it is not evidence of red.
  const partialBin = gitOnlyBinDir("no-npm-bugfix-");
  const restorePath = pathReplace(partialBin);
  try {
    assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
    assert.equal(runsOf(counter), 0, "nothing ran");
    assert.equal(eventsOfType(root, "warning").length, 0);
  } finally {
    restorePath();
  }
});

test("mainRedGate proceeds silently when no build check is declared", async () => {
  const base = tmpdir("mainred-none-");
  const root = makeRepo(path.join(base, "project"));
  const wt = worktreeAt(root, ROLE);

  // Nothing to verify → nothing to block on, and no warning: a missing check is not an
  // environmental skip.
  assert.equal(await mainRedGate(root, ROLE, wt), null);
  assert.deepEqual(readEvents(root), [], "no events when there is no declared check");
});

// The gate's never-throws contract (src/main-red.ts): an unreadable main must read as
// `unavailable` with a why, never reject the vet pipeline with an exception — a corrupt or
// dangling ref is a broken repo, and the failure belongs in the rejection's reasons.
test("mainTipVerdict reports unavailable, without throwing, when main's ref dangles", async () => {
  const root = makeRepo();
  // Point main at a well-formed sha whose object does not exist: `git rev-parse` still
  // resolves it (a ref read needs no object database), but the gate's worktree add cannot
  // check it out and throws.
  fs.mkdirSync(path.join(root, ".tumwater", "worktrees"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"deadbeef".repeat(5)}\n`);
  const verdict = await mainTipVerdict(root, ROLE, "main", defaultConfig());
  assert.equal(verdict.status, "unavailable");
  assert.ok(verdict.status === "unavailable" && /invalid reference/.test(verdict.why), verdict.status === "unavailable" ? verdict.why : "");
});

// BUGS.md 2026-09-30: a FAILED baseline run the host slept through is no verdict about main —
// the gate warns under the role, naming the sleep, and proceeds with authoring; nothing is
// cached, so the next consult re-runs and a clean attempt settles the SHA.
test("mainRedGate proceeds unverified when the baseline run spanned a host sleep", async () => {
  const { root, wt } = baselineFixture(ROLE, "echo baseline-failure; exit 1");
  const slept = scriptedSampler([woke(1_000), woke(121_000, 2_000)]);
  assert.equal(await mainRedGate(root, ROLE, wt, slept), null, "a slept baseline run never blocks authoring");
  const events = readEvents(root);
  const check = events.find((e) => e.type === "build_check");
  assert.equal(check?.status, "failed");
  assert.equal(check?.sleptMs, 119_000, "the event carries the measured sleep");
  const warning = events.find((e) => e.type === "warning" && e.loop === ROLE);
  assert.match(
    String(warning?.message ?? ""),
    /main baseline check ran while the host slept 119s mid-run; proceeding with authoring unverified/,
  );

  // Nothing was cached from the slept run: the next gate re-runs, and the clean attempt's
  // red is a real red — main_red, as always.
  const clean = scriptedSampler([woke(1_000), woke(1_500)]);
  assert.equal((await mainRedGate(root, ROLE, wt, clean))?.result, "main_red");
});
