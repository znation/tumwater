/** Fourth slice of the loop e2e suite (after loop.test.ts, loop-2.test.ts and loop-3.test.ts) —
 * split so node --test runs the slices in parallel processes: top-level tests within one file
 * run sequentially, while each test FILE gets its own process (and its own PATH, which fakePi's
 * global PATH swap requires). The slices are balanced by measured per-test duration (~45 s each
 * at 2026-09-25); keep them roughly equal when moving tests between the files. The quiet
 * watchdog's tests live in their own topic file, loop-quiet-watchdog.test.ts (2026-09-29), as
 * do the refusal sentinel's regressions, in loop-refusal.test.ts (2026-09-30). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { piLogPath } from "../src/paths.js";
import { warningMessages } from "./log-fixtures.js";
import { makeLoopRunner } from "./loop-fixtures.js";
import { projManifest, writeScript } from "./fakes/fake-commands.js";
import { landHead } from "./orchestrator-fixtures.js";
import { initializedRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, firstRunThenIdle, logPromptsTo, readPromptRuns } from "./fakes/fake-pi.js";
import { waitForLogLines, watchdogClock } from "./helpers/wait.js";
import { APPROVE_PI, assistantLine, errorLine, leasedRoleShell } from "./pi-events.js";

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
    const warnings = warningMessages(repo);
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
    projManifest({ build: "buildcheck-tool --fail" }),
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
      logPromptsTo(promptsFile),
      ...firstRunThenIdle(marker, [
        `printf '%s\n' '${assistantLine("did it\nSUMMARY: add broken code")}'`,
        `echo bad > broken.ts`,
      ]),
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
    // tick starts a fresh pi session. Since revise-rejected, the rejected diff is re-applied
    // as uncommitted edits and the revision note carries the reasons; the idle run then
    // declares nothing-to-do, so the revision is dropped and the worktree reset clean. The
    // prompts log holds exactly the two author runs: the landing spent none.
    assert.equal((await runner.tick()).result, "no_change");
    const runs = readPromptRuns(promptsFile);
    assert.equal(runs.length, 2, "two author runs and nothing from the landing");
    assert.ok(!runs[0]?.includes("rejected in review"), "tick 1's prompt had no rejection note yet");
    const second = runs[1] ?? "";
    assert.match(second, /is already in the worktree as uncommitted edits/);
    assert.match(second, /revision 1 of 2/);
    assert.match(second, /build check failed \(\`npm run build\`\): src\/bad\.ts\(3,5\)/);
  } finally {
    restore();
  }
});

// Questions outbox (plans/questions-outbox.md): a merged diff that adds an entry under
// QUESTIONS.md's ## Open emits one question_posted per new heading alongside the merged event,
// so `tumwater logs` shows what the fleet is asking for. The emission lives in tryMerge
// (src/landing/landing-merge.ts), which captures the Open list before the rebase and diffs it after the ff.

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
      leasedRoleShell(),
      // Author runs and review runs now share pooled slots, so tell them apart by the review
      // prompt's VERDICT and key both on the leased role.
      `is_review=0; for a in "$@"; do case "$a" in *"VERDICT:"*) is_review=1;; esac; done`,
      `case "$role:$is_review" in`,
      // A's landing's reviewer run (slot for improve): hold the lock while reviewing.
      `improve:1)`,
      `  touch '${marker}'; i=0; while [ ! -f '${bDone}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`,
      `  printf '%s\n' '${approveLine}'; exit 0;;`,
      // B's landing's reviewer run (slot for organize): plain approve.
      `organize:1)`,
      `  printf '%s\n' '${approveLine}'; exit 0;;`,
      // The leased slots cover the authoring ticks.
      `improve:0)`,
      `  printf '%s\n' '${assistantLine("slow work\\nSUMMARY: slow change")}'`,
      `  echo a > a.txt`,
      `  ;;`,
      // B's tick's author run: wait for A to be mid-landing, then work fast.
      `organize:0)`,
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
