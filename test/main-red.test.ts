import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bugfixMainRedNote, mainRedGate } from "../src/main-red.js";
import { readEvents } from "../src/events.js";
import { shortSha } from "../src/text.js";
import { baselineFixture, runsOf, sh, tmpdir } from "./util.js";

// Unit coverage for the red-main baseline gate (src/main-red.ts): the policy layer on top of
// checkMainBaseline — which roles it blocks, what it logs (one build_check per actual run,
// under the role that paid for it; one harness-level warning per newly-discovered red SHA),
// and its warn-and-proceed semantics for environmental skips. The underlying detection,
// execution, and per-SHA cache machinery is covered in build-check.test.ts.

const ROLE = "coverage"; // a BASELINE_BLOCKED_ROLES member (code-producing)

/** A fake `npm` executable at the front of PATH for the duration of a test (the repo's real
 * npm must never run in unit tests). Returns a restore function. */
function fakeNpm(script: string): () => void {
  const dir = tmpdir("fake-npm-");
  const bin = path.join(dir, "npm");
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

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
    assert.deepEqual(blocked, { result: "main_red", summary: "code merges blocked until main is green" });

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
    const sha = sh(root, "git", "rev-parse", "main");
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
    const warnings = readEvents(root).filter((e) => e.type === "warning" && e.loop === "harness");
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
    const checks = readEvents(root).filter((e) => e.type === "build_check");
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
  const partialBin = tmpdir("no-npm-");
  fs.symlinkSync(sh(wt, "which", "git"), path.join(partialBin, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = partialBin;
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
    process.env.PATH = oldPath;
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
      readEvents(root).filter((e) => e.type === "warning" && e.loop === "harness").length,
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
    assert.equal(readEvents(root).filter((e) => e.type === "warning").length, 0);
  } finally {
    restore();
  }
});

test("bugfixMainRedNote yields no note when no check is declared", async () => {
  const base = tmpdir("mainred-bugfix-none-");
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  sh(root, "git", "init", "-b", "main");
  sh(root, "git", "config", "user.name", "test");
  sh(root, "git", "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(root, "seed.txt"), "x\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", "bugfix");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(root, "git", "worktree", "add", "-b", "tumwater/bugfix", wt, "main");
  assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
  assert.deepEqual(readEvents(root), [], "nothing to verify, nothing to say");
});

test("bugfixMainRedNote yields no note on an environmental skip (no npm)", async () => {
  const counter = path.join(tmpdir(), "runs");
  const script = `echo skip-healer >> ${counter}; exit 1`;
  const { root, wt } = baselineFixture(ROLE, script);
  // A PATH that keeps git but drops npm — the check cannot run, so it is not evidence of red.
  const partialBin = tmpdir("no-npm-bugfix-");
  fs.symlinkSync(sh(wt, "which", "git"), path.join(partialBin, "git"));
  const oldPath = process.env.PATH;
  process.env.PATH = partialBin;
  try {
    assert.equal(await bugfixMainRedNote(root, "bugfix", wt), undefined);
    assert.equal(runsOf(counter), 0, "nothing ran");
    assert.equal(readEvents(root).filter((e) => e.type === "warning").length, 0);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("mainRedGate proceeds silently when no build check is declared", async () => {
  const base = tmpdir("mainred-none-");
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  sh(root, "git", "init", "-b", "main");
  sh(root, "git", "config", "user.name", "test");
  sh(root, "git", "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(root, "seed.txt"), "x\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(root, "git", "worktree", "add", "-b", `tumwater/${ROLE}`, wt, "main");

  // Nothing to verify → nothing to block on, and no warning: a missing check is not an
  // environmental skip.
  assert.equal(await mainRedGate(root, ROLE, wt), null);
  assert.deepEqual(readEvents(root), [], "no events when there is no declared check");
});
