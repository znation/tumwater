/** Fourth slice of the loop e2e suite (after loop.test.ts, loop-2.test.ts and loop-3.test.ts) —
 * split so node --test runs the slices in parallel processes: top-level tests within one file
 * run sequentially, while each test FILE gets its own process (and its own PATH, which fakePi's
 * global PATH swap requires). The slices are balanced by measured per-test duration (~45 s each
 * at 2026-09-25); keep them roughly equal when moving tests between the files. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { validateConfig } from "../src/config-validation.js";
import { readEvents } from "../src/events.js";
import { piLogPath, worktreePath } from "../src/paths.js";
import { eventsOfType } from "./log-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { writeScript } from "./fake-commands.js";
import { landHead } from "./orchestrator-fixtures.js";
import { initializedRepo, mainSha, makeRepo, sh, tmpdir } from "./repo-fixtures.js";
import { fakePi } from "./fake-pi.js";
import { waitForFile, waitForLogLines, watchdogClock } from "./wait.js";
import { APPROVE_PI, assistantLine, errorLine } from "./pi-events.js";

test("a run that recovers from a predict-stream timeout internally is not re-run by the harness", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "runs");
  // pi's own retry machinery reports the idle-stream timeout in an event, then the same
  // run recovers and finishes normally: the harness must not re-run a healthy result.
  const restore = fakePi(
    [
      `echo run >> "${counter}"`,
      `printf '%s\n' '${JSON.stringify({ type: "auto_retry_start", attempt: 1, errorMessage: "Engine protocol predict stream timed out after 600000ms without receiving data." })}'`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the recovered run's verdict stands");
    assert.ok(!runner.state.lastError);
    // Exactly one pi invocation: no harness-level retry of an already-healthy run.
    assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
    const warnings = eventsOfType(repo, "warning").map((e) => String(e.message));
    assert.ok(
      !warnings.some((w) => /retrying the pi run once/.test(w)),
      `no retry warning expected: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

test("a transient timeout that also hits the harness timeout is not retried", async (t) => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "runs");
  // The machine sleeps long enough that pi reports the idle-stream timeout AND the
  // harness's own tick timeout fires: retrying would just burn another full timeout.
  const restore = fakePi(
    [
      `echo run >> "${counter}"`,
      `printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'`,
      `exec sleep 30`,
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.tickTimeoutSeconds = 3;
    // The tick timeout on logical time (watchdogClock with timeouts): it fires once the shim
    // has printed its error line — on the wall clock a 1s budget could expire during process
    // spawn under load, before the shim printed anything at all (BUGS.md 2026-09-18). A retry
    // (the regression) prints a second line and is timed out in turn, so the run count below
    // names it rather than the test hanging on a clock nobody advances.
    const clock = watchdogClock(t, { timeouts: true });
    const runner = makeLoopRunner(repo, "clean", config);
    let settled = false;
    const tick = runner.tick().finally(() => (settled = true));
    const log = piLogPath(repo, "clean");
    for (let k = 1; await waitForLogLines(log, "predict stream timed out", k, () => settled); k++) clock.advance(3_000);
    const outcome = await tick;
    // The shim's error line is one real progress event inside the quiet window, so the
    // deadline fired on a "progressing" run: the timeout now resumes it like a quiet kill
    // instead of discarding (BUGS.md 2026-09-29). The pinned property is the one below —
    // still exactly one pi invocation, the harness timeout suppressing the transient retry.
    assert.equal(outcome.result, "quiet_killed");
    assert.match(runner.state.lastError ?? "", /timed out/);
    // Exactly one pi invocation: the harness timeout suppresses the transient retry.
    assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
  } finally {
    restore();
  }
});

test("a transient timeout on both attempts errors with the real cause (regression)", async () => {
  const repo = await initializedRepo();
  // Every pi run (tick + retry) hits the idle-stream timeout: the machine keeps sleeping.
  const restore = fakePi(
    `printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'\nexit 1`,
  );
  try {
    const runner = makeLoopRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /predict stream timed out/);
  } finally {
    restore();
  }
});

// Quiet watchdog: the run is killed when pi stops making *progress* (message/turn/tool
// boundary events — streaming deltas never count), not merely when it stops running fast.
// These tests run it on logical time (watchdogClock, test/wait.ts): each waits for the fake
// pi's output to reach the raw log, then advances the watchdog's clock past the window it
// pins — exact where real-time windows were widened after every loaded-machine flake
// (BUGS.md 2026-09-18, 2026-09-21), and free where they cost seconds.

test("a pi run that goes silent is killed as hung and never commits partial work", async (t) => {
  const repo = await initializedRepo();
  // Emits one line (so it is not silent from birth), writes a partial edit, then hangs
  // like an interactive tool waiting for stdin. `exec` so the signal reaches sleep.
  const restore = fakePi(
    [`printf '%s\n' '${assistantLine("starting work")}'`, `echo partial > partial.txt`, `exec sleep 60`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 3;
    config.tickTimeoutSeconds = 3600; // The watchdog, not the tick timeout, must fire.
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    const before = mainSha(repo);
    const tick = runner.tick();
    // The kill must come only once the shim has spoken and reached `echo partial` — the
    // "partial edit survives" assertion below is about the kill, not about shell startup.
    await waitForFile(path.join(worktreePath(repo, "improve"), "partial.txt"));
    await waitForLogLines(piLogPath(repo, "improve"), "starting work");
    clock.advance(15_000); // silence well past the 3 s window
    const outcome = await tick;
    assert.equal(outcome.result, "quiet_killed");
    assert.match(runner.state.lastError ?? "", /killed as hung: no pi progress/);
    assert.equal(mainSha(repo), before, "nothing landed on main");
    assert.ok(!fs.existsSync(path.join(repo, "partial.txt")));
    // The kill is non-destructive (BUGS.md 2026-09-12): the partial edit survives in the
    // worktree and the next tick resumes the session instead of resetting it away.
    assert.ok(
      fs.existsSync(path.join(worktreePath(repo, "improve"), "partial.txt")),
      "the partial edit survives the kill",
    );
    assert.equal(runner.state.resumePending, true, "the next tick resumes this one");
  } finally {
    restore();
  }
});

// The stall warning (BUGS.md 2026-09-13 sibling): a tool call open and silent past the
// threshold names itself in the event feed while the run is still alive — before this, a hung
// command was invisible until the quiet watchdog's kill.

test("a stalled tool call warns in the event feed with the command named", async (t) => {
  const repo = await initializedRepo();
  // Names a hung bash command, then hangs like an interactive tool waiting for stdin.
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 999" } })}'`,
      `exec sleep 60`, // exec so the signal reaches the sleeper directly
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    // The ORDER is what this pins — warning first, kill second — exact on logical time, where a
    // real-time 1s gap was thinner than the jitter of two suites at once (BUGS.md).
    config.quietTimeoutSeconds = 5; // the watchdog still owns the kill...
    config.toolCallStallSeconds = 2; // ...but the warning lands first, 3s ahead of it
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    const tick = runner.tick();
    await waitForLogLines(piLogPath(repo, "improve"), "tool_execution_start");
    clock.advance(30_000); // past the stall threshold, then past the quiet window
    const outcome = await tick;
    assert.equal(outcome.result, "quiet_killed");
    const warnings = eventsOfType(repo, "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((m) => m.startsWith("tool call stalled: bash sleep 999")),
      `the stall warning names the hung command; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

test("a slow but talkative pi run is not killed by the quiet watchdog", async (t) => {
  const repo = await initializedRepo();
  // Streams a line immediately, then one per 3 s gap for 18 s — far longer than the 10 s quiet
  // window would allow if it were measuring total runtime, but never silent longer than the
  // window. The ratio is what this pins. The gaps are logical time (watchdogClock): the shim
  // prints its next line only when the test says so, after the clock has moved 3 s — so no
  // machine load can stretch a gap, which is how the real-time version of this test flaked
  // even at 3 s gaps against a 10 s window (BUGS.md 2026-09-18, 2026-09-21). 18 s, not 12 s:
  // the watchdog checks every 5 s and kills on silence strictly over the window, so a
  // runtime-measuring regression is first visible at the 15 s check.
  const dir = tmpdir();
  const gaps = 6;
  const go = (k: number) => path.join(dir, `go-${k}`);
  const turnStart = `printf '%s\n' '${JSON.stringify({ type: "turn_start" })}'`;
  const chatter = Array.from({ length: gaps }, (_, k) => `while [ ! -f '${go(k)}' ]; do sleep 0.02; done\n${turnStart}`);
  const restore = fakePi([turnStart, ...chatter, `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"));
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 10;
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    let settled = false;
    const tick = runner.tick().finally(() => (settled = true));
    const log = piLogPath(repo, "improve");
    // A killed run prints nothing more: stop feeding it and let the assertion name the result.
    for (let k = 0; k < gaps && (await waitForLogLines(log, "turn_start", k + 1, () => settled)); k++) {
      clock.advance(3_000);
      fs.writeFileSync(go(k), "");
    }
    const outcome = await tick;
    assert.equal(outcome.result, "no_change", "run completed despite taking longer than the quiet window");
  } finally {
    restore();
  }
});

test("quietTimeoutSeconds 0 disables the watchdog", async (t) => {
  const repo = await initializedRepo();
  // Speaks first — a byte-silent run is never quiet-killed anyway, so silence only tests the
  // switch once progress has flowed — then stays silent until the test says go.
  const go = path.join(tmpdir(), "go");
  const restore = fakePi(
    [
      `printf '%s\n' '${JSON.stringify({ type: "turn_start" })}'`,
      `while [ ! -f '${go}' ]; do sleep 0.02; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 0;
    const clock = watchdogClock(t);
    const runner = makeLoopRunner(repo, "improve", config);
    const tick = runner.tick();
    await waitForLogLines(piLogPath(repo, "improve"), "turn_start");
    clock.advance(120_000); // two minutes of silence: any window at all would have fired
    fs.writeFileSync(go, "");
    const outcome = await tick;
    assert.equal(outcome.result, "no_change");
  } finally {
    restore();
  }
});

test("config validation accepts 0 and rejects negatives for quietTimeoutSeconds", () => {
  validateConfig({ quietTimeoutSeconds: 0 });
  validateConfig({ quietTimeoutSeconds: 1800 });
  assert.throws(() => validateConfig({ quietTimeoutSeconds: -5 }), /quietTimeoutSeconds/);
  assert.throws(() => validateConfig({ quietTimeoutSeconds: "long" }), /quietTimeoutSeconds/);
});

test("a zombie stream dripping content-free keepalive updates is killed as hung", async (t) => {
  const repo = makeRepo();
  await initProject(repo, "zombie stream test");
  // Emits an identical empty message_update every 200ms forever — bytes without progress,
  // exactly what a dead generation's kept-alive connection looks like.
  const keepalive = JSON.stringify({
    type: "message_update",
    message: { role: "assistant", content: [], usage: { totalTokens: 0 } },
  });
  const restore = fakePi(
    [`while true; do`, `  printf '%s\n' '${keepalive}'`, `  sleep 0.2`, `done`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 1;
    config.tickTimeoutSeconds = 3600;
    const clock = watchdogClock(t);
    const controller = new AbortController();
    const runner = makeLoopRunner(repo, "improve", config, "main", controller.signal);
    let settled = false;
    const tick = runner.tick().finally(() => (settled = true));
    // Half a second of watchdog time per fresh keepalive, so bytes keep landing as the clock
    // runs — a watchdog that let raw bytes (or deltas) count as progress would never fire.
    // Ten windows' worth bounds it: the abort then ends a run the watchdog failed to kill.
    const log = piLogPath(repo, "improve");
    for (let k = 1; k <= 40 && (await waitForLogLines(log, "message_update", k, () => settled)); k++) {
      clock.advance(500);
    }
    controller.abort(); // a no-op once the watchdog has killed the run
    const outcome = await tick;
    assert.equal(outcome.result, "quiet_killed", "a zombie stream is a hung run, not an unfulfilled timeout");
    assert.match(runner.state.lastError ?? "", /killed as hung: no pi progress/);
  } finally {
    restore();
  }
});

test("a change whose build fails is rejected by the pre-check and its compiler tail rides on the next prompt", async () => {
  const repo = await initializedRepo();
  // Install signature at the repo root: detectBuildCheck walks up from the worktree to it,
  // and npm resolves the toolchain from there. The build script fails with a compiler-style
  // line only while broken.ts exists — pristine main must stay green so the red-main baseline
  // gate (which runs before authoring) does not block the tick this test is about.
  fs.mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
  const tool = path.join(repo, "node_modules", ".bin", "buildcheck-tool");
  writeScript(
    tool,
    "if [ -f broken.ts ]; then echo 'src/bad.ts(3,5): error TS2345: not assignable'; exit 1; fi\nexit 0",
  );
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "proj", version: "1.0.0", scripts: { build: "buildcheck-tool --fail" } }),
  );
  // Commit package.json (node_modules stays untracked — the install marker): a git worktree
  // checks out tracked files, and npm re-roots `npm run` at the nearest package.json. With one
  // in the worktree the script runs there, compiling branch state exactly as dogfood does.
  sh(repo, "git", "add", "package.json");
  sh(repo, "git", "commit", "-m", "declare build check");

  // The reviewer branch (any run whose prompt asks for a VERDICT) approves — it must never be
  // reached, because the pre-check decides first. Author runs record their full argv so the
  // test can assert what each tick was actually told.
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const marker = path.join(tmpdir(), "changed-once");
  const restore = fakePi(
    [
      APPROVE_PI,
      `{ printf '%s\n' "$@"; echo "===RUN==="; } >> "${promptsFile}"`,
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("did it\nSUMMARY: add broken code")}'`,
      `  echo bad > broken.ts`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    // Tick 1: the change is committed and enqueued; the LANDING's build pre-check rejects it
    // (red twice, on a main that is green) — no pi run at all, reviewer or otherwise.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "rejected");
    assert.ok(!fs.existsSync(path.join(repo, "broken.ts")), "the failing build did not merge");

    // Tick 2: the machine-generated reasons are the cross-tick memory of what broke — every
    // tick starts a fresh pi session, so they must ride along on this tick's prompt. The
    // prompts log holds exactly the two author runs: the landing spent none.
    assert.equal((await runner.tick()).result, "no_change");
    const runs = fs.readFileSync(promptsFile, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs.length, 2, "two author runs and nothing from the landing");
    assert.ok(!runs[0]?.includes("rejected in review"), "tick 1's prompt had no rejection note yet");
    const second = runs[1] ?? "";
    assert.match(second, /Your previous change was rejected in review \(/);
    assert.match(second, /build check failed \(\`npm run build\`\): src\/bad\.ts\(3,5\)/);
  } finally {
    restore();
  }
});

// Refusal handling (plans/refusal-and-thrash.md): the TUMWATER_REFUSED sentinel routes a
// tick to handleRefusal, where only the markdown objection note may land — it is the durable
// record that blocks the entry for later ticks. Non-markdown half-work is discarded and the
// note commit merges directly (md-only diffs are review-exempt by construction). The sentinel
// is detected ONLY as an anchored line with a non-negating reason (BUGS.md 2026-09-23): a
// bare sentinel or a `TUMWATER_REFUSED: none` on an ordinary reply is not a refusal, and a
// refusal contradicted by its own SUMMARY beside real work keeps the work.

test("a refused tick lands only its markdown note, discards code changes, and skips review", async () => {
  const repo = await initializedRepo();
  // The fake pi counts its invocations in a file OUTSIDE the worktree: exactly one run is
  // expected (the author). A second invocation would mean the note commit went through the
  // review gate, which handleRefusal deliberately bypasses.
  const counter = path.join(tmpdir(), "pi-calls");
  fs.writeFileSync(counter, "0");
  const restore = fakePi(
    [
      `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'`,
      // Declines the work and leaves a Refused note under the entry in PLANS.md — plus
      // half-done code changes (one tracked edit, one untracked file) that must NOT land.
      `printf '%s\\n' '${assistantLine("declining this plan\nTUMWATER_REFUSED: it would delete user data")}'`,
      `printf '\\n## Entry\\n\\n**Refused:** it would delete user data\\n' >> PLANS.md`,
      `echo bad >> seed.txt`,
      `echo bad > broken.ts`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "refused");
    assert.equal(outcome.summary, "it would delete user data");

    // The note landed on main with the refusal subject...
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): refuse — it would delete user data/);
    assert.ok(
      fs.readFileSync(path.join(repo, "PLANS.md"), "utf8").includes("**Refused:** it would delete user data"),
      "the objection note is the durable record on main",
    );
    // ...and nothing else did: the tracked edit was reset and the untracked file cleaned.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "seed\n", "the code change was discarded");
    assert.ok(!fs.existsSync(path.join(repo, "broken.ts")), "untracked half-work is cleaned");

    // The note commit merged directly: no reviewer run was burned on an md-only diff.
    assert.equal(fs.readFileSync(counter, "utf8").trim(), "1", "exactly one pi run (the author)");
  } finally {
    restore();
  }
});

test("a bare sentinel over work is not a refusal: the tick runs the normal flow (regression)", async () => {
  // BUGS.md 2026-09-23: the old whole-reply substring scan treated a bare sentinel mention
  // as a refusal and destroyed the work. An anchored line with no reason declares nothing.
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\\n' '${assistantLine("TUMWATER_REFUSED")}'`,
      `echo bad > broken.ts`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the work is not discarded as a refusal");
    // The edit survived — committed on the branch, headed for the normal gate, no refusal note.
    const subjects = sh(repo, "git", "log", "--format=%s", "-5");
    assert.ok(!subjects.includes("refuse —"), `no refusal commit: ${subjects}`);
  } finally {
    restore();
  }
});

test("a reply ending TUMWATER_REFUSED: none lands its work instead of refusing (regression)", async () => {
  // The exact shape that discarded two tested bugfix ticks (BUGS.md 2026-09-23): an ordinary
  // work-completed reply whose trailing line fills the sentinel in like a report field.
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\\n' '${assistantLine("all done\nSUMMARY: shipped the fix\nTUMWATER_REFUSED: none")}'`,
      `echo fixed > src-fix.ts`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "a negated refusal never discards the work");
    const subjects = sh(repo, "git", "log", "--format=%s", "-5");
    assert.ok(!subjects.includes("refuse —"), `no refusal commit: ${subjects}`);
  } finally {
    restore();
  }
});

test("a refusal contradicted by its own SUMMARY beside work keeps the work behind a warning", async () => {
  // A real reason beside a SUMMARY and non-markdown work is self-contradictory: the work is
  // surfaced behind a warning and the normal flow judges it — not discarded (BUGS.md 2026-09-23).
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      `printf '%s\\n' '${assistantLine("did the work\nSUMMARY: fixed the leak\nTUMWATER_REFUSED: it would delete user data")}'`,
      `echo bad >> seed.txt`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "contradicted work runs the normal flow");
    const subjects = sh(repo, "git", "log", "--format=%s", "-5");
    assert.ok(!subjects.includes("refuse —"), `no refusal commit: ${subjects}`);
    const warnings = eventsOfType(repo, "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) => /refusal contradicted by its own reply/.test(w) && w.includes("seed.txt")),
      `warning names the kept work: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

// Questions outbox (plans/questions-outbox.md): a merged diff that adds an entry under
// QUESTIONS.md's ## Open emits one question_posted per new heading alongside the merged event,
// so `tumwater logs` shows what the fleet is asking for. The emission lives in tryMerge
// (src/landing-merge.ts), which captures the Open list before the rebase and diffs it after the ff.

test("a tick that posts a question merges it and emits question_posted with the merged event", async () => {
  const repo = await initializedRepo();
  // md-only diff: review-exempt by construction, so exactly one pi run (the author) is
  // expected — a second invocation would mean the gate ran on a markdown-only change.
  const counter = path.join(tmpdir(), "pi-calls");
  fs.writeFileSync(counter, "0");
  const restore = fakePi(
    [
      `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'`,
      // Replace the first _None yet._ placeholder (the one under ## Open — the seeded file
      // has one per section) with a real entry, as a loop would.
      `awk '!done && /^_None yet\\._$/ { print "### Q1: which database?"; done=1; next } { print }' QUESTIONS.md > .q.tmp && mv .q.tmp QUESTIONS.md`,
      `printf '%s\\n' '${assistantLine("asked the user about the database\nSUMMARY: post a question", { tokens: 42, output: 42, cost: 0.05 })}'`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");

    // The question landed on main under ## Open…
    const questionsMd = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
    assert.match(questionsMd, /## Open\n\n### Q1: which database?/);

    // …and the event log carries both events: merged plus one question_posted naming the new heading.
    const events = readEvents(repo);
    const merged = events.filter((e) => e.type === "merged");
    assert.equal(merged.length, 1);
    const posted = events.filter((e) => e.type === "question_posted");
    assert.equal(posted.length, 1, "exactly one new Open entry was posted");
    assert.equal(posted[0]!.loop, "improve");
    assert.equal(posted[0]!.question, "Q1: which database?");
    // The question event lands alongside (after) the merged event for the same commit.
    assert.ok(
      events.findIndex((e) => e.type === "merged") < events.findIndex((e) => e.type === "question_posted"),
      "question_posted follows merged in the log",
    );

    // The md-only diff skipped the review gate: no reviewer run was burned.
    assert.equal(fs.readFileSync(counter, "utf8").trim(), "1", "exactly one pi run (the author)");
  } finally {
    restore();
  }
});

test("a tick that changes other files emits no question_posted event", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [
      // Non-md diff goes through the review gate: approve the reviewer run (identified by its
      // VERDICT prompt) so the tick lands like "a tick that changes files commits and merges".
      APPROVE_PI,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const runner = makeLoopRunner(repo, "improve");
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    // The seeded QUESTIONS.md has no Open entries before or after: nothing to emit.
    const events = readEvents(repo);
    assert.ok(events.some((e) => e.type === "merged"), "the tick merged");
    assert.equal(events.filter((e) => e.type === "question_posted").length, 0);
  } finally {
    restore();
  }
});

test("the landing slot is the only merge-lock holder: another loop ticks and queues behind it", async () => {
  const repo = await initializedRepo();
  // A's LANDING (drained right after its tick) touches the marker in its reviewer run, then
  // holds — A holds the merge lock (the lander's merge) until B's tick is done, bounded at
  // ~30s. B waits for that marker, then does its whole tick (author + commit + pin + enqueue).
  // Since merge queue 3/5 a tick never merges, so it never needs the lock: B must finish while
  // A's landing is still mid-flight. The landing slot serializes merges, not authoring. A tick
  // that did need the lock would wait out A's bound and finish after A's landing.
  const marker = path.join(tmpdir(), "a-landing");
  const bDone = path.join(tmpdir(), "b-done");
  const approveLine = assistantLine("VERDICT: approve");
  const restore = fakePi(
    [
      `case "$PWD" in`,
      // The lander worktrees come first: their paths also end in the role name.
      // A's landing's reviewer run (_land-improve): hold the lock while reviewing.
      `*_land-improve)`,
      `  touch '${marker}'; i=0; while [ ! -f '${bDone}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`,
      `  printf '%s\n' '${approveLine}'; exit 0;;`,
      // B's landing's reviewer run (_land-organize): plain approve.
      `*_land-organize)`,
      `  printf '%s\n' '${approveLine}'; exit 0;;`,
      `*improve)`,
      `  printf '%s\n' '${assistantLine("slow work\\nSUMMARY: slow change")}'`,
      `  echo a > a.txt`,
      `  ;;`,
      // B's tick's author run: wait for A to be mid-landing, then work fast.
      `*organize)`,
      `  i=0; while [ ! -f "${marker}" ] && [ $i -lt 60 ]; do sleep 0.2; i=$((i+1)); done`,
      `  printf '%s\n' '${assistantLine("fast work\\nSUMMARY: fast change")}'`,
      `  echo b > b.txt`,
      `  ;;`,
      `esac`,
    ].join("\n"),
  );
  try {
    const a = makeLoopRunner(repo, "improve");
    const b = makeLoopRunner(repo, "organize");
    let bEndAt = 0;
    let aLandEndAt = 0;
    const pa = (async () => {
      const tickOutcome = await a.tick();
      assert.equal(tickOutcome.result, "queued");
      const landed = await landHead(repo, a, defaultConfig(), "improve");
      aLandEndAt = Date.now();
      return landed;
    })();
    const pb = (async () => {
      const outcome = await b.tick();
      bEndAt = Date.now();
      fs.writeFileSync(bDone, "");
      return outcome;
    })();
    const [aLanded, bOutcome] = await Promise.all([pa, pb]);
    assert.equal(aLanded, "changed");
    assert.equal(bOutcome.result, "queued");
    // B's tick (commit + enqueue) finished while A's landing held the merge lock — the
    // landing slot is the only place the lock is ever needed.
    assert.ok(
      bEndAt < aLandEndAt,
      `B finished at ${bEndAt} before A's landing ended at ${aLandEndAt}: its tick must not need the lock`,
    );
    // Then B drains behind A: the slot is free again and both merges land linearly.
    assert.equal(await landHead(repo, b, defaultConfig(), "organize"), "changed");
    // Both commits are on main, linearly — no lock contention broke either merge.
    assert.ok(fs.existsSync(path.join(repo, "a.txt")));
    assert.ok(fs.existsSync(path.join(repo, "b.txt")));
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
  } finally {
    restore();
  }
});
