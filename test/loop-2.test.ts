/** Second half of loop.test.ts — split so node --test runs the two halves in parallel
 * processes: top-level tests within one file run sequentially, while each test FILE gets its
 * own process (and its own PATH, which fakePi's global PATH swap requires). The halves are
 * balanced by measured per-test duration (~30 s each at 2026-09-09); keep them roughly equal
 * when moving tests between the files. */
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { refSha } from "../src/git.js";
import { queueDepth } from "../src/land-queue.js";
import { landingRefName, sessionDir } from "../src/paths.js";
import { dequeuePrompt, dequeueRolePrompt, enqueueRolePrompt, queuedRolePrompts } from "../src/inbox.js";
import { eventsOfType, harnessWarnings, makeLoopRunner, writeScript } from "./util.js";
import { landHead } from "./orchestrator-fixtures.js";
import { initializedRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { waitForFile } from "./wait.js";
import { APPROVE_PI, assistantLine, errorLine, thinkingOnlyLine } from "./pi-events.js";

const TOUCH_SESSION = `prev=""; for a in "$@"; do if [ "$prev" = "--session-dir" ]; then mkdir -p "$a"; touch "$a/s.jsonl"; fi; prev="$a"; done`;
// Thrash flag (plans/refusal-and-thrash.md item b): a changed tick whose authoring run burned
// BOTH more than thrashTurns turns and thrashMinutes of wall clock is flagged high-friction —
// one warning event carrying both thresholds, the outcome flag, the reviewer prompt's
// HIGH-FRICTION marker, and the Friction trailer line on the commit itself. Requiring both (not
// either) keeps a fast model's ordinary 40-turn/few-minute tick unflagged (BUGS.md 2026-09-19).
// The fake pi identifies reviewer runs by their VERDICT prompt (the pattern this file already
// uses for gate tests) and records that run's args to a file outside the worktree.

test("a changed tick past thrashTurns is flagged high-friction end to end", async () => {
  const repo = await initializedRepo();
  const reviewArgs = path.join(tmpdir(), "review-args");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' "$@" > '${reviewArgs}'; printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      // Two assistant turns with thrashTurns set to 1 AND thrashMinutes set to 0 → past both
      // thresholds, so the flag fires.
      `printf '%s\\n' '${assistantLine("first turn of work")}'`,
      `printf '%s\\n' '${assistantLine("second turn\nSUMMARY: slow change", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.thrashTurns = 1;
    config.thrashMinutes = 0;
    const runner = makeLoopRunner(repo, "improve", config);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(runner.state.lastResult, undefined, "a queued tick records no completed result");
    assert.equal(await landHead(repo, runner, config, "improve"), "changed");
    assert.ok(outcome.highFriction, "the tick is flagged high-friction");
    // The flag annotates the summary for dashboards and lastSummary — the latter once the
    // landing resolves, paired with the landing's result (BUGS.md 2026-09-23).
    assert.match(String(outcome.summary), /^slow change \(high friction: 2 turns \/ \d+m\)$/);
    assert.equal(runner.state.lastResult, "changed");
    assert.equal(runner.state.lastSummary, outcome.summary);

    // The warning event carries both thresholds.
    const events = readEvents(repo);
    const warnings = events.filter(
      (e) => e.type === "warning" && /high-friction/.test(String(e.message)),
    );
    assert.equal(warnings.length, 1, "exactly one high-friction warning event");
    assert.match(
      String(warnings[0]!.message),
      /^high-friction tick: 2 turns in \d+ min \(thresholds: 1 turns \/ 0 min\)$/,
    );

    // The reviewer run's prompt carried the HIGH-FRICTION marker for extra scrutiny.
    assert.match(fs.readFileSync(reviewArgs, "utf8"), /HIGH-FRICTION/);

    // The commit on main carries the Friction trailer line after the Tick line (item d's e2e).
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 2 · ctx \S+\nFriction: high \(2 turns \/ \d+m\)$/m);
  } finally {
    restore();
  }
});

test("a changed tick past only thrashTurns is not flagged high-friction", async () => {
  const repo = await initializedRepo();
  const reviewArgs = path.join(tmpdir(), "review-args");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' "$@" > '${reviewArgs}'; printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      // Two turns with thrashTurns set to 1 is past the turn threshold; the default
      // thrashMinutes of 30 is nowhere near → only the turns side fires. Both are required, so
      // an ordinary fast tick is NOT flagged (the false positive BUGS.md 2026-09-19 recorded).
      `printf '%s\\n' '${assistantLine("first turn of work")}'`,
      `printf '%s\\n' '${assistantLine("second turn\nSUMMARY: fast change", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.thrashTurns = 1;
    const runner = makeLoopRunner(repo, "improve", config);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, config, "improve"), "changed");
    assert.ok(!outcome.highFriction, "a turns-only fast tick is not flagged high-friction");

    // No high-friction warning event, no marker on the reviewer prompt, and no Friction
    // trailer on the commit.
    const events = readEvents(repo);
    assert.ok(
      !events.some((e) => e.type === "warning" && /high-friction/.test(String(e.message))),
      "no high-friction warning event",
    );
    assert.doesNotMatch(fs.readFileSync(reviewArgs, "utf8"), /HIGH-FRICTION/);
    assert.doesNotMatch(sh(repo, "git", "log", "-1", "--format=%B"), /Friction:/);
  } finally {
    restore();
  }
});

test("an ordinary changed tick under both thresholds is not flagged high-friction", async () => {
  const repo = await initializedRepo();
  const reviewArgs = path.join(tmpdir(), "review-args");
  const restore = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' "$@" > '${reviewArgs}'; printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    // Default thresholds (40 turns / 30 min): one fast turn is far under both.
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    assert.ok(!outcome.highFriction, "an ordinary tick is not flagged high-friction");

    // No high-friction warning event…
    const events = readEvents(repo);
    assert.ok(
      !events.some((e) => e.type === "warning" && /high-friction/.test(String(e.message))),
      "no high-friction warning event",
    );
    // …the reviewer prompt carries no marker, and the commit has no Friction line.
    assert.doesNotMatch(fs.readFileSync(reviewArgs, "utf8"), /HIGH-FRICTION/);
    assert.doesNotMatch(sh(repo, "git", "log", "-1", "--format=%B"), /Friction:/);
  } finally {
    restore();
  }
});

// Self-explaining commit bodies (plans/commit-bodies.md item a): the reply contract's
// WHY/RISK/VERIFIED lines land in an ACTUAL tick commit on main, and a SUMMARY-only reply
// commits subject + trailer only. The pure-function units live in test/commit-message.test.ts;
// this e2e reads real `git log` content from two ticks of one loop — the first compliant,
// the second non-compliant — so both halves of buildCommitMessage's assembly are pinned
// against what git actually stores, including that the reviewer run does not inflate the
// trailer's turn count.

test("a compliant reply commits WHY/RISK/VERIFIED plus trailer; a SUMMARY-only reply commits subject + trailer only", async () => {
  const repo = await initializedRepo();
  // The fake pi counts its invocations in a file OUTSIDE the worktree (so it never dirties
  // the tree) and answers each author run differently: tick 1 compliant, tick 2 SUMMARY-only.
  const counter = path.join(tmpdir(), "pi-calls");
  fs.writeFileSync(counter, "0");
  const compliant = assistantLine(
    [
      "done",
      "SUMMARY: add hello file",
      "WHY: the loops needed a hello file to prove the pipeline works",
      "RISK: none that I can see",
      "VERIFIED: npm test, all pass",
    ].join("\n"),
    { tokens: 42, output: 42, cost: 0.05 },
  );
  const summaryOnly = assistantLine("done\nSUMMARY: add world file", { tokens: 7, output: 7, cost: 0.01 });
  const restore = fakePi(
    APPROVE_PI + "\n" +
      `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'\n` +
      `[ "$n" -eq 1 ] && { printf '%s\\n' '${compliant}'; echo hello > hello.txt; } || { printf '%s\\n' '${summaryOnly}'; echo world > world.txt; }`,
  );
  try {
    const runner = makeLoopRunner(repo, "improve");

    // Tick 1: compliant reply → the commit on main carries subject, body (all three fields,
    // in contract order), and the harness-stamped trailer as separate paragraphs. One author
    // turn plus one reviewer run — the trailer counts only the pre-commit author turns.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    const first = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(
      first,
      /^tumwater\(improve\): add hello file\n\nWHY: the loops needed a hello file to prove the pipeline works\nRISK: none that I can see\nVERIFIED: npm test, all pass\n\nTick: improve #1 · turns 1 · ctx 42$/m,
    );

    // Tick 2: SUMMARY-only reply → subject + trailer only; no body paragraph at all.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    const second = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(second, /^tumwater\(improve\): add world file\n\nTick: improve #2 · turns 1 · ctx 7$/m);
    assert.doesNotMatch(second, /WHY:|RISK:|VERIFIED:/);
  } finally {
    restore();
  }
});

// Per-tick usage in the event feed (PLANS.md): tick_end carries this tick's tokens and cost,
// so `tumwater logs` shows where spend went without diffing status-table snapshots. The
// rendering rules live in test/event-format.test.ts; these e2es pin that a real tick emits
// the fields on its event — summed over every pi run of the tick (here: author + zero-usage
// reviewer) — and that a skipped tick carries neither.

test("a changed tick's tick_end event carries its per-tick tokens and cost", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      // The reviewer run reports zero usage, so the tick's totals are exactly the author
      // run's — the same numbers the status table's gen column shows for this tick.
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 18400, output: 18400, cost: 0.37 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    assert.equal((await runner.tick()).result, "queued");

    const ends = eventsOfType(repo, "tick_end");
    assert.equal(ends.length, 1, "one tick ran");
    // tokens is the AUTHOR run's window, costUsd its spend — the landing's own spend (the
    // zero-usage reviewer) rides the `landed` event instead.
    assert.equal(ends[0]!.tokens, 18400);
    assert.equal(ends[0]!.costUsd, 0.37);
    // The state file still carries the same per-tick window (the gen column's source).
    assert.equal(runner.state.generatedTokens, 18400);

    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    const landed = eventsOfType(repo, "landed");
    assert.equal(landed.length, 1, "the landing slot logged its own outcome");
    assert.equal(landed[0]!.result, "changed");
    assert.equal(landed[0]!.tokens, undefined, "the zero-usage reviewer omits the token field");
  } finally {
    restore();
  }
});

test("a skipped tick's tick_end event carries no usage fields", async () => {
  // A director with an empty inbox skips without running pi: its tick_end must carry neither
  // tokens nor costUsd, so it renders byte-identical to a pre-feature line.
  const repo = await initializedRepo();
  const runner = makeLoopRunner(repo, "director");
  assert.equal((await runner.tick()).result, "skipped");

  const ends = eventsOfType(repo, "tick_end");
  assert.equal(ends.length, 1, "one tick ran");
  assert.equal(ends[0]!.tokens, undefined, "no tokens field on a skipped tick");
  assert.equal(ends[0]!.costUsd, undefined, "no costUsd field on a skipped tick");
});

// --- Red-main baseline check (PLANS.md): while main's own suite is known red, code-producing
// roles skip authoring entirely instead of burning runs the gate would reject deterministically.

/** Make a repo's main "red": commit a package.json whose test script fails (appending to
 * `counter` so tests can count how often npm actually ran), plus an untracked node_modules dir
 * at root — the installed-project signature detectBuildCheck walks up to from the worktree. */
function makeMainRed(repo: string, counter: string): void {
  fs.mkdirSync(path.join(repo, "node_modules")); // untracked install marker (gitignored in real projects)
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: `echo baseline-failure-line; echo run >> ${counter}; exit 1` } }),
  );
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "make main red");
}

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

    // The tick_end lines carry the result + summary for the dashboards' last-result column.
    const ends = eventsOfType(repo, "tick_end");
    assert.equal(ends.length, 2);
    assert.equal(String(ends[1]?.result), "main_red");
    assert.match(String(ends[1]?.summary ?? ""), /code merges blocked/);
  } finally {
    restore();
  }
});

test("a green main passes the baseline check and authoring proceeds normally", async () => {
  const repo = await initializedRepo();
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: "echo ok" } }),
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
      `{ printf '%s\n' "$@"; echo "===RUN==="; } >> "${promptsFile}"`,
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
      JSON.stringify({ name: "proj", version: "1.0.0", scripts: { test: `echo fixed >> ${counter}; exit 0` } }),
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

  const gitBin = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(gitBin, "git"));

  const oldPath = process.env.PATH;
  process.env.PATH = `${piDir}:${gitBin}`; // pi + git only — no npm anywhere
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
    process.env.PATH = oldPath;
  }
});

// Context-ceiling memory across ticks (src/prompt.ts buildCutOffNote / buildResumePrompt's
// cut-off cause): a cut-off resume must be told what actually happened, and a fresh tick after
// the loop gave up resuming must be told its last attempts were too big for the window.
test("a cut-off resume is bridged as a cut-off, and the fresh tick after the limit carries the note", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const restore = fakePi(
    [
      `{ printf '%s\n' "$@"; echo "===RUN==="; } >> "${promptsFile}"`,
      `printf '%s\n' '${thinkingOnlyLine("cut off again", { output: 16 })}'`,
    ].join("\n"),
  );
  try {
    fs.mkdirSync(sessionDir(repo, "perf"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "perf"), "s.jsonl"), "{}\n");
    const runner = makeLoopRunner(repo, "perf");
    // Tick 1 fresh; ticks 2–4 resume (CUT_OFF_RESUME_LIMIT resumes); tick 5 is fresh again.
    for (let i = 1; i <= 5; i++) assert.equal((await runner.tick()).result, "no_change");
    const runs = fs.readFileSync(promptsFile, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs.length, 5);
    assert.doesNotMatch(runs[0]!, /ran out of context/, "the first, fresh tick carries no cut-off text");
    // The resumes continue the compacted session: the bridge names the real cause, not a restart.
    for (const resumed of runs.slice(1, 4)) {
      assert.match(resumed, /--continue/);
      assert.match(resumed, /ran out of context before it could finish/);
      assert.doesNotMatch(resumed, /The harness was restarted/);
    }
    // Tick 5 is fresh (past the limit): the only memory of four failed attempts is the note,
    // and it counts every cut-off — the streak keeps counting past the resume limit.
    assert.doesNotMatch(runs[4]!, /--continue/);
    assert.match(runs[4]!, /Your previous 4 runs as this loop ran out of context before landing anything/);
    assert.match(runs[4]!, /Your task this run:/, "…on an otherwise normal tick prompt");
    assert.equal(runner.state.cutOffStreak, 5);
    const resumes = eventsOfType(repo, "resume");
    assert.equal(resumes.length, 3);
    assert.ok(resumes.every((e) => e.cause === "cut-off"), "resume events name the cut-off cause");
  } finally {
    restore();
  }
});

test("a shutdown resume is bridged as a restart with no cut-off note", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts.log");
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  const controller = new AbortController();
  try {
    const runner = makeLoopRunner(repo, "clean", defaultConfig(), "main", controller.signal);
    const first = runner.tick();
    await waitForFile(path.join(repo, ".tumwater/worktrees/clean/partial.txt"));
    controller.abort();
    assert.equal((await first).result, "aborted");
    restore();
    // The fake pi writes no session file; the resume guard needs one to continue.
    fs.mkdirSync(sessionDir(repo, "clean"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "clean"), "s.jsonl"), "{}\n");
    // The resumed run finds the interrupted edit in place and decides against it: a clean
    // nothing-to-do finish, so the tick lands nothing and never reaches the review gate.
    restore = fakePi(
      [
        `{ printf '%s\n' "$@"; echo "===RUN==="; } >> "${promptsFile}"`,
        `rm -f partial.txt`,
        `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "clean");
    assert.equal((await resumed.tick()).result, "no_change");
    const run = fs.readFileSync(promptsFile, "utf8");
    assert.match(run, /The harness was restarted while you/);
    assert.doesNotMatch(run, /ran out of context/);
    const [resume] = eventsOfType(repo, "resume");
    assert.equal(resume?.cause, "restart");
  } finally {
    restore();
  }
});

test("a pi crash on malformed JSON is retried once by continuing the session (regression)", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  const argsFile = path.join(tmpdir(), "argv.log");
  // Attempt 1: pi dies mid-run the way five ticks did in the first 18 days — a JSON.parse
  // failure on a torn model-server chunk, nothing on stdout worth keeping. Attempt 2 (the
  // harness retry, detected by the phase file) continues the same session and finishes.
  const restore = fakePi(
    [
      TOUCH_SESSION,
      `flags=""; for a in "$@"; do case "$a" in --continue|-n) flags="$flags $a";; esac; done; echo "run:$flags" >> "${argsFile}"`,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  echo 'SyntaxError: Unterminated string in JSON at position 2781 (line 1 column 2782)' >&2`,
      `  exit 1`,
      `else`,
      `  printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the retry's verdict stands in for the tick");
    assert.ok(!runner.state.lastError, `no error recorded: ${runner.state.lastError}`);
    const runs = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    assert.equal(runs.length, 2);
    assert.ok(!runs[0]!.includes("--continue"), "the first attempt was the fresh tick run");
    assert.ok(runs[1]!.includes("--continue"), "the retry continued the crashed run's session");
    const warnings = eventsOfType(repo, "warning").map((e) => String(e.message));
    assert.ok(warnings.some((w) => /pi crashed on malformed JSON .*Unterminated string.* — resuming the session once/.test(w)), JSON.stringify(warnings));
  } finally {
    restore();
  }
});

// A failed pin write is the tick's fail-closed branch: the commit STAYS on the branch for
// next-tick recovery — resetting the worktree here would orphan it. Blocking the ref: git
// happily removes an EMPTY directory at a ref's path before creating the file, but not a
// non-empty one — the stray blocker file makes `git update-ref` fail, like an un-writable
// .git would. Tick 2's leftover recovery then adopts the unpinned tip
// into the pin scheme and queues it for the same review gate — invariant 1 must hold
// whether or not the pin survived (plans/merge-queue.md).
test("a failed pin leaves the commit on the branch; the next tick recovers and lands it", async () => {
  const repo = await initializedRepo();
  // Tick 1: one authoring run that makes a change. The tick ends at commit + pin, so the
  // VERDICT branch below only guards against the review prompt ever reaching this script.
  const restore1 = fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const blockedRef = path.join(repo, ".git", "refs", "tumwater", "landing", "improve");
  fs.mkdirSync(blockedRef, { recursive: true });
  fs.writeFileSync(path.join(blockedRef, "blocker"), "keep the directory non-empty\n");
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.equal(outcome.summary, "failed to pin the landing ref; left for next-tick recovery");
    assert.equal(runner.state.lastError, "failed to pin the landing ref; left for next-tick recovery");
    assert.ok(runner.state.backoffSeconds > 0, "the error tick backs off on the error ladder");

    // The commit stays on the branch ahead of main — the worktree was NOT reset.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve").trim(), "1");
    assert.equal(fs.existsSync(path.join(repo, "hello.txt")), false, "nothing reached main");

    // Nothing was enqueued, and the ref was never pinned.
    assert.equal(queueDepth(repo), 0);
    assert.equal(await refSha(repo, landingRefName("improve")), null);

    // The failure is observable as a warning naming the recovery plan.
    const warnings = eventsOfType(repo, "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) =>
        /failed to pin \S+ by its landing ref — leaving the commit on the branch for next-tick recovery/.test(w),
      ),
      JSON.stringify(warnings),
    );
  } finally {
    restore1();
    fs.rmSync(blockedRef, { recursive: true, force: true });
  }

  // Unblock done (finally); tick 2's leftover recovery adopts the unpinned commit and puts it on
  // the land queue — the tick ends there, like a fresh changed tick — and the landing slot lands
  // it through the same gate, with the approve.
  const restore2 = fakePi(
    [
      APPROVE_PI,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "recovery queued the unpinned commit; no authoring run");
    assert.equal(fs.existsSync(path.join(repo, "hello.txt")), false, "nothing lands inside the tick");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the recovered commit landed on main");
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add hello file/);
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve").trim(), "0", "the branch is back at main");
    assert.equal(await refSha(repo, landingRefName("improve")), null, "the landed pin is deleted");
    assert.equal(queueDepth(repo), 0);
    // Like the pinned-recovery case, the landing is recorded as a merged event (what the
    // usage report counts), from the landing slot rather than the tick.
    const merged = eventsOfType(repo, "merged");
    assert.equal(merged.length, 1);
    // The merged summary names what landed — the recovered commit's own subject — not
    // merely that a recovery happened, so the failure digest's "Landed in the window" is
    // never opaque (BUGS.md 2026-09-21).
    assert.equal(String(merged[0]!.summary), "recovered leftover work from improve: add hello file");
  } finally {
    restore2();
  }
});

// PLANS.md "Per-role prompts 1/2" criterion (b), red-gate arm: a per-role prompt is dequeued
// before the red-main gate runs (the gate needs the assembled prompt), so a blocked tick MUST
// put it back — the pending field is memory-only, and a prompt lost here never runs.
test("a role prompt queued while main is red survives the blocked tick", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "npm-runs-role-prompt");
  makeMainRed(repo, counter);
  enqueueRolePrompt(repo, "feature", "check the flow");
  const marker = path.join(tmpdir(), "pi-invoked-role-prompt");
  const restore = fakePi(`touch '${marker}'`);
  try {
    const runner = makeLoopRunner(repo, "feature");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "main_red");
    assert.ok(!fs.existsSync(marker), "no pi run starts while main is red");

    // The dequeued prompt is back in the feature queue — not the director's — ready for the
    // next tick once main is green.
    assert.deepEqual(dequeueRolePrompt(repo, "feature"), "check the flow");
    assert.equal(dequeueRolePrompt(repo, "feature"), null);
    assert.equal(dequeuePrompt(repo), null);
  } finally {
    restore();
  }
});

// A resume-owning tick (cut-off, quiet-kill, shutdown) re-queues its user prompt as the durable
// copy, but the resumed session still owns that request in its context: the resume must reclaim
// exactly that copy as its own user prompt, or a fulfilling resume leaves it queued and a later
// fresh tick runs the same request a second time (BUGS.md 2026-09-25).
test("a cut-off tick's requeued role prompt is reclaimed by the resume, not run twice", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts-reclaim.log");
  const counter = path.join(tmpdir(), "reclaim-count");
  // Run 1 (fresh, carrying the queued prompt) is cut off contentless; run 2 (the resume) is a
  // fulfilled nothing-to-do — the outcome that must consume the reclaimed prompt.
  const restore = fakePi(
    [
      `printf '%s\\n' "$@" >> "${promptsFile}"; echo "===RUN===" >> "${promptsFile}"`,
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
      `if [ "$n" = 1 ]; then ${TOUCH_SESSION}; printf '%s\\n' '${thinkingOnlyLine("cut off mid-task", { output: 16 })}'; else printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
    ].join("\n"),
  );
  try {
    enqueueRolePrompt(repo, "perf", "fix the flubbernator");
    const runner = makeLoopRunner(repo, "perf");
    const first = await runner.tick();
    assert.equal(first.result, "no_change");
    assert.equal(first.cutOff, true, "run 1 was cut off at the context ceiling");
    assert.equal(runner.state.resumePending, true, "the next tick resumes the compacted session");
    assert.match(fs.readFileSync(promptsFile, "utf8"), /flubbernator/, "tick 1 ran the queued prompt");
    assert.deepEqual(queuedRolePrompts(repo, "perf"), ["fix the flubbernator"], "the durable copy is queued");

    const second = await runner.tick();
    assert.equal(second.result, "no_change");
    const runs = fs.readFileSync(promptsFile, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs.length, 2);
    assert.match(runs[1]!, /--continue/, "tick 2 resumed the cut-off session");
    // The fulfilling resume consumed the requeued copy: nothing is left for a fresh tick to run
    // again. Pre-fix the copy stayed queued and tick 3 re-ran the same request.
    assert.deepEqual(queuedRolePrompts(repo, "perf"), [], "the resume consumed the requeued prompt");
    assert.equal(runner.state.resumePromptFile, undefined, "the reclaim record is consumed");

    const third = await runner.tick();
    assert.equal(third.result, "no_change");
    const runs3 = fs.readFileSync(promptsFile, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs3.length, 3);
    assert.doesNotMatch(runs3[2]!, /--continue/, "tick 3 is fresh again");
    assert.doesNotMatch(runs3[2]!, /flubbernator/, "tick 3 does not re-run the fulfilled request");
  } finally {
    restore();
  }
});

test("a failed resume re-queues the reclaimed prompt, so the request is not lost", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts-reclaim-fail.log");
  const counter = path.join(tmpdir(), "reclaim-fail-count");
  // Run 1 (fresh) is cut off; run 2 (the resume) fails without changes; run 3 (fresh) retries.
  const restore = fakePi(
    [
      `printf '%s\\n' "$@" >> "${promptsFile}"; echo "===RUN===" >> "${promptsFile}"`,
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
      `if [ "$n" = 1 ]; then ${TOUCH_SESSION}; printf '%s\\n' '${thinkingOnlyLine("cut off mid-task", { output: 16 })}'; elif [ "$n" = 2 ]; then printf '%s\\n' '${errorLine("backend exploded")}'; else printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
    ].join("\n"),
  );
  try {
    enqueueRolePrompt(repo, "perf", "fix the flubbernator");
    const runner = makeLoopRunner(repo, "perf");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal((await runner.tick()).result, "error", "the resume failed");
    // The reclaim took the queue copy and the failed resume put it back: the request survives.
    assert.deepEqual(queuedRolePrompts(repo, "perf"), ["fix the flubbernator"], "the failed resume re-queued the prompt");
    assert.equal((await runner.tick()).result, "no_change");
    const runs = fs.readFileSync(promptsFile, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs.length, 3);
    assert.doesNotMatch(runs[1]!, /flubbernator/, "the resume bridge does not re-send the request text");
    assert.match(runs[2]!, /flubbernator/, "the fresh tick after the failed resume retries the request");
  } finally {
    restore();
  }
});

// The prompt is dequeued (or reclaimed) into memory before the tick's environment work starts,
// so an exception between the dequeue and the pi run leaves the request only in the pending
// field — memory the failed tick drops. The queue is the durable store, so the catch must
// re-queue whatever is still pending, like every unfulfilled outcome does.
test("a tick that throws after dequeuing the prompt re-queues it instead of losing it", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "pi-invoked-crash");
  const restore = fakePi(`touch '${marker}'`);
  try {
    enqueueRolePrompt(repo, "perf", "fix the flubbernator");
    const runner = makeLoopRunner(repo, "perf");
    // Corrupt the repo's HEAD so ensureWorktree throws after the dequeue — an environment
    // failure, not a pi outcome the outcome handlers could re-queue from.
    fs.rmSync(path.join(repo, ".git", "HEAD"));
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.ok(!fs.existsSync(marker), "no pi run starts before the crash");
    // The dequeued prompt survived the crash in its queue, ready for the next tick.
    assert.deepEqual(
      queuedRolePrompts(repo, "perf"),
      ["fix the flubbernator"],
      "the dequeued prompt is back in the queue, not lost",
    );
  } finally {
    restore();
  }
});
