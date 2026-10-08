/** The red-main/baseline slice of the loop e2e suite, extracted from loop-2.test.ts: while
 * main's own suite is known red, code-producing roles skip authoring entirely instead of
 * burning runs the landing gate would reject deterministically (with the healer, exempt-role,
 * and unverifiable-main counter-cases). Like every loop suite file it runs in its own process
 * (fakePi's global PATH swap requires it) and its top-level tests run sequentially within it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { eventsOfType, harnessWarnings } from "./log-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { pathReplace, projManifest, writeScript } from "./fakes/fake-commands.js";
import { landHead } from "./orchestrator-fixtures.js";
import { gitOnlyBinDir, initializedRepo, makeMainRed, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi, logPromptsTo } from "./fakes/fake-pi.js";
import { APPROVE_PI, assistantLine } from "./pi-events.js";

// --- Red-main baseline check (PLANS.md): while main's own suite is known red, code-producing
// roles skip authoring entirely instead of burning runs the gate would reject deterministically.

/** A fake pi that approves review verdicts and lands one small change (plus a marker file so
 * the test can prove an authoring run actually started). */
function approvingPi(marker: string): () => void {
  return fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
  );
}

test("a blocked role skips authoring while main is red: no pi run, one warning per SHA, cached verdicts", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs");
  makeMainRed(repo, counter);
  const marker = path.join(tmpdir(), "pi-invoked");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const runner = makeLoopRunner(repo, "feature");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "main_red");
    assert.equal(outcome.summary, "code merges blocked until main is green");
    assert.ok(!fs.existsSync(marker), "no pi run starts while main is red");

    // A second tick on the same SHA: cached red — still no pi run and npm test did not re-run.
    const again = await runner.tick();
    assert.equal(again.result, "main_red");
    assert.ok(!fs.existsSync(marker));
    assert.equal(
      fs.readFileSync(counter, "utf8").trim().split("\n").length,
      1,
      "the SHA's check ran once (cache) — repeated skips read it without re-running npm test",
    );

    // The one baseline run is priced in the feed under the role that paid for it; the cached
    // second skip logs nothing.
    const checks = eventsOfType(repo, "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.scope, "baseline");
    assert.equal(checks[0]!.status, "failed");
    assert.equal(checks[0]!.loop, "feature");
    assert.ok(Number(checks[0]!.durationMs) >= 0);

    // Exactly one harness-level warning for the red SHA: script name + clipped first failure line.
    const warnings = harnessWarnings(repo);
    assert.equal(warnings.length, 1);
    const message = String(warnings[0]?.message ?? "");
    assert.match(message, /is red \(test: baseline-failure-line\)/);
    assert.match(message, /code merges blocked until main is green/);

    // The tick_end lines carry the result + summary for the dashboards' last-result column,
    // and the error field names what broke (BUGS.md 2026-09-28): the failure digest's error
    // clusters include main_red ticks, so the event itself must carry the cause.
    const ends = eventsOfType(repo, "tick_end");
    assert.equal(ends.length, 2);
    assert.equal(String(ends[1]?.result), "main_red");
    assert.match(String(ends[1]?.summary ?? ""), /code merges blocked/);
    const redError = String(ends[1]?.error ?? "");
    assert.match(redError, /is red \(test: baseline-failure-line\)/);
    assert.match(redError, /authoring skipped until main is green/);
  } finally {
    restore();
  }
});

test("a green main passes the baseline check and authoring proceeds normally", async () => {
  const repo = await initializedRepo();
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(
    path.join(repo, "package.json"),
    projManifest({ test: "echo ok" }),
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "green main");
  const marker = path.join(tmpdir(), "pi-invoked");
  const restore = approvingPi(marker);
  try {
    const runner = makeLoopRunner(repo, "feature");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "feature"), "changed");
    assert.ok(fs.existsSync(marker), "the authoring run started on a green main");
    // Two priced check runs: main's baseline before authoring, the gate's pre-check before merge.
    const scopes = eventsOfType(repo, "build_check").map((e) => `${e.scope}:${e.status}`);
    assert.deepEqual(scopes, ["baseline:passed", "gate:passed"]);
  } finally {
    restore();
  }
});

test("an exempt role ticks normally while main is red — its markdown-only diff still lands", async () => {
  const repo = await initializedRepo();
  makeMainRed(repo, path.join(tmpdir(), "npm-runs"));
  const marker = path.join(tmpdir(), "pi-invoked");
  const restore = fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: note", { tokens: 7, output: 7, cost: 0.01 })}'`,
      `echo more >> PLANS.md`,
      `touch '${marker}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "readme");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(
      await landHead(repo, runner, defaultConfig(), "readme"),
      "changed",
      "markdown-only diffs are exempt from the build pre-check and land even on red main",
    );
    assert.ok(fs.existsSync(marker), "the authoring run started for an exempt role");
  } finally {
    restore();
  }
});

test("the bugfix healer's fresh prompt carries the red-main handoff", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs");
  makeMainRed(repo, counter);
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "pi-invoked");
  const restore = fakePi(
    [
      logPromptsTo(promptsFile),
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: fix main", { tokens: 10, output: 10, cost: 0.01 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "bugfix");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the healer authors on a red main (never blocked)");
    assert.ok(fs.existsSync(marker), "its pi run started");

    const run = fs.readFileSync(promptsFile, "utf8");
    assert.ok(run.includes("<main-red>"), "the tick prompt carries the red-main block");
    assert.ok(run.includes("baseline-failure-line"), "…naming the failure headline");
    assert.ok(run.includes("test"), "…and the failing script");

    // The healer's check is priced in the feed under bugfix, and the red SHA warns once.
    const checks = eventsOfType(repo, "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.loop, "bugfix");
    assert.equal(checks[0]!.scope, "baseline");
    assert.equal(checks[0]!.status, "failed");
    assert.equal(harnessWarnings(repo).length, 1);
  } finally {
    restore();
  }
});

test("after a fix lands on main, the next tick re-checks the new SHA and authoring resumes", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs");
  makeMainRed(repo, counter);
  const marker = path.join(tmpdir(), "pi-invoked");
  const restore = approvingPi(marker);
  try {
    const runner = makeLoopRunner(repo, "feature");
    assert.equal((await runner.tick()).result, "main_red");

    // The bugfix role (exempt) lands a fix on main — the suite is green at the new SHA.
    fs.writeFileSync(
      path.join(repo, "package.json"),
      projManifest({ test: `echo fixed >> ${counter}; exit 0` }),
    );
    sh(repo, "git", "add", "-A");
    sh(repo, "git", "commit", "-m", "fix the suite");

    // The next fresh tick resets to the new main and re-checks it — no waiting out backoff.
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "feature"), "changed");
    assert.ok(fs.existsSync(marker), "authoring resumed once main is green");
    // Grew past tick one's single red run: the baseline check re-ran for the new SHA. (The
    // review gate's own pre-check of main + changes appends too, so allow more than two.)
    assert.ok(
      fs.readFileSync(counter, "utf8").trim().split("\n").length >= 2,
      "the new SHA was re-checked (one run per SHA)",
    );
  } finally {
    restore();
  }
});

test("an unverifiable main (no npm on PATH) warns and proceeds instead of blocking authoring", async () => {
  // The baseline check's environmental-skip branch: when the detected check cannot RUN
  // (npm missing from PATH), a blocked role must warn and still spend its authoring run —
  // never block as main_red. Main is made genuinely red below so that warn-and-proceed is
  // the ONLY reason this tick can land: a fail-closed regression would return "main_red"
  // forever on any machine without npm.
  const repo = await initializedRepo();
  makeMainRed(repo, path.join(tmpdir(), "npm-runs"));

  const marker = path.join(tmpdir(), "pi-invoked");
  // A fake pi at a KNOWN directory (not fakePi's hidden one) so the PATH below can include
  // it and git — but nothing else: execFile/spawn resolve bare commands via PATH, so npm is
  // unresolvable no matter where this machine keeps it.
  const piDir = tmpdir("fake-pi-");
  writeScript(
    path.join(piDir, "pi"),
    [
      APPROVE_PI,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
      // Redirection, not touch: the restricted PATH below has no /usr/bin, so this script
      // may rely on shell builtins only.
      `printf ok > '${marker}'`,
    ].join("\n"),
  );

  const gitBin = gitOnlyBinDir();

  const restorePath = pathReplace(`${piDir}:${gitBin}`); // pi + git only — no npm anywhere
  try {
    const runner = makeLoopRunner(repo, "feature");
    const outcome = await runner.tick();

    // Authoring proceeded and landed: the skip is environmental (warn-and-proceed), not a block.
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "feature"), "changed");
    assert.ok(fs.existsSync(marker), "the authoring run started despite the unverifiable main");

    // The baseline check's warning names the missing npm and that the MAIN BASELINE check was
    // skipped — distinct from the gate's own pre-check warning ("skipping build check"), which
    // this tick also logs. Both prove warn-and-proceed at their respective layers.
    const warnings = readEvents(repo).filter((e) => e.type === "warning" && e.loop === "feature");
    assert.ok(
      warnings.some((w) => String(w.message ?? "") === "no npm on PATH; skipping main baseline check"),
      `baseline skip warning missing:\n${JSON.stringify(warnings, null, 2)}`,
    );

    // No red-main block event: the harness-level "is red … blocked" warning is for a VERIFIED
    // red SHA only — an unverifiable main must not announce itself as red.
    const harnessEvents = harnessWarnings(repo);
    assert.equal(harnessEvents.length, 0, `no verified-red warning for an unverified main:\n${JSON.stringify(harnessEvents)}`);
  } finally {
    restorePath();
  }
});
