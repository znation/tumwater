import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mainRedGate } from "../src/main-red.js";
import { readEvents } from "../src/events.js";
import { shortSha } from "../src/text.js";
import { sh, tmpdir } from "./util.js";

// Unit coverage for the red-main baseline gate (src/main-red.ts): the policy layer on top of
// checkMainBaseline — which roles it blocks, what it logs (one build_check per actual run,
// under the role that paid for it; one harness-level warning per newly-discovered red SHA),
// and its warn-and-proceed semantics for environmental skips. The underlying detection,
// execution, and per-SHA cache machinery is covered in build-check.test.ts.

const ROLE = "coverage"; // a BASELINE_BLOCKED_ROLES member (code-producing)

/** A git repo whose main is "installed" (package.json + node_modules at root), with a linked
 * worktree checked out to it — the shape checkMainBaseline expects (a pristine main HEAD).
 * Each fixture gets its own temp dir, hence its own SHA: the gate's verdict cache and red-SHA
 * warning state are module-level, so tests must never share a HEAD. */
function baselineFixture(testScript: string): { root: string; wt: string } {
  const base = tmpdir("mainred-");
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  sh(root, "git", "init", "-b", "main");
  sh(root, "git", "config", "user.name", "test");
  sh(root, "git", "config", "user.email", "test@example.com");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: testScript } }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", ROLE);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(root, "git", "worktree", "add", "-b", `tumwater/${ROLE}`, wt, "main");
  return { root, wt };
}

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

function runsOf(counter: string): number {
  try {
    return fs.readFileSync(counter, "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

test("mainRedGate lets a non-blocked role through without running the check", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(`echo run >> ${counter}; exit 1`);
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
  const { root, wt } = baselineFixture(`echo ok >> ${counter}; exit 0`);
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
  const { root, wt } = baselineFixture(`echo baseline-failure; echo run >> ${counter}; exit 1`);
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
  const { root, wt } = baselineFixture(`echo run >> ${counter}; exit 1`);
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

test("mainRedGate warns under the role and proceeds when npm is missing", async () => {
  const counter = path.join(tmpdir(), "runs");
  const { root, wt } = baselineFixture(`echo run >> ${counter}; exit 1`);

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
