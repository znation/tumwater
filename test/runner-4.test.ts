/** Fourth slice of the runner e2e suite (after runner.test.ts, runner-2.test.ts and
 * runner-3.test.ts) — split so node --test runs the slices in parallel processes:
 * top-level tests within one file run sequentially, while each test FILE gets its own
 * process (and its own PATH, which fakePi's
 * global PATH swap requires). The slices are balanced by measured per-test duration (~45 s each
 * at 2026-09-25); keep them roughly equal when moving tests between the files. The quiet
 * watchdog's tests live in their own topic file, runner-quiet-watchdog.test.ts (2026-09-29), as
 * do the refusal sentinel's regressions, in runner-refusal.test.ts (2026-09-30). */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { withLock } from "../src/concurrency/lock.js";
import { readEvents } from "../src/events/event-read.js";
import { queueDepth } from "../src/merge/merge-queue.js";
import { mergeLockDir, piLogPath } from "../src/paths.js";
import { warningMessages } from "./fixtures/log-fixtures.js";
import { makeRoleRunner } from "./fixtures/runner-fixtures.js";
import { mergeHead } from "./fixtures/orchestrator-fixtures.js";
import { initializedRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { withPi } from "./fakes/fake-pi.js";
import { waitFor, waitForFile, waitForLogLines, watchdogClock } from "./helpers/wait.js";
import { APPROVE_PI, assistantLine, errorLine, leasedRoleShell } from "./fixtures/pi-events.js";

test("a run that recovers from a predict-stream timeout internally is not re-run by the harness", async () => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "runs");
  // pi's own retry machinery reports the idle-stream timeout in an event, then the same
  // run recovers and finishes normally: the harness must not re-run a healthy result.
  await withPi(
    [
      `echo run >> "${counter}"`,
      `printf '%s\n' '${JSON.stringify({ type: "auto_retry_start", attempt: 1, errorMessage: "Engine protocol predict stream timed out after 600000ms without receiving data." })}'`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "clean");
      const outcome = await runner.run();
      assert.equal(outcome.result, "no_change", "the recovered run's verdict stands");
      assert.ok(!runner.state.lastError);
      // Exactly one pi invocation: no harness-level retry of an already-healthy run.
      assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
      const warnings = warningMessages(repo);
      assert.ok(
        !warnings.some((w) => w.includes('retrying the agent run once')),
        `no retry warning expected: ${JSON.stringify(warnings)}`,
      );
    },
  );
});

test("a transient timeout that also hits the harness timeout is not retried", async (t) => {
  const repo = await initializedRepo();
  const counter = path.join(tmpdir(), "runs");
  // The machine sleeps long enough that pi reports the idle-stream timeout AND the
  // harness's own run timeout fires: retrying would just burn another full timeout.
  await withPi(
    [
      `echo run >> "${counter}"`,
      `printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'`,
      `exec sleep 30`,
    ].join("\n"),
    async () => {
      const config = defaultConfig();
      config.runTimeoutSeconds = 3;
      // The run timeout on logical time (watchdogClock with timeouts): it fires once the shim
      // has printed its error line — on the wall clock a 1s budget could expire during process
      // spawn under load, before the shim printed anything at all (BUGS.md 2026-09-18). A retry
      // (the regression) prints a second line and is timed out in turn, so the run count below
      // names it rather than the test hanging on a clock nobody advances.
      const clock = watchdogClock(t, { timeouts: true });
      const runner = makeRoleRunner(repo, "clean", config);
      let settled = false;
      const runDone = runner.run().finally(() => (settled = true));
      const log = piLogPath(repo, "clean");
      // 3500, not 3000: the deadline at 3000 arms the one-shot progress grace (BUGS.md
      // 2026-10-26) whose re-check the run must pass before it settles as a discard.
      for (let k = 1; await waitForLogLines(log, "predict stream timed out", k, () => settled); k++) clock.advance(3_500);
      const outcome = await runDone;
      // The shim's error line is one real progress event, but none lands within the final
      // `progressWindowMs` before the deadline, so the timeout discards instead of resuming
      // (BUGS.md 2026-10-09). The pinned property is the one below — still exactly one pi
      // invocation, the harness timeout suppressing the transient retry.
      assert.equal(outcome.result, "error");
      assert.match(runner.state.lastError ?? "", /^timed out/);
      // Exactly one pi invocation: the harness timeout suppresses the transient retry.
      assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
    },
  );
});

test("a transient timeout on both attempts errors with the real cause (regression)", async () => {
  const repo = await initializedRepo();
  // Every pi run (run + retry) hits the idle-stream timeout: the machine keeps sleeping.
  await withPi(
    `printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'\nexit 1`,
    async () => {
      const runner = makeRoleRunner(repo, "clean");
      const outcome = await runner.run();
      assert.equal(outcome.result, "error");
      assert.match(runner.state.lastError ?? "", /predict stream timed out/);
    },
  );
});

// Questions outbox (plans/questions-outbox.md): a merged diff that adds an entry under
// QUESTIONS.md's ## Open emits one question_posted per new heading alongside the merged event,
// so `tumwater logs` shows what the team is asking for. The emission lives in tryMerge
// (src/merge/merge-to-main.ts), which captures the Open list before the rebase and diffs it after
// the ff.

test("a run that posts a question merges it and emits question_posted with the merged event", async () => {
  const repo = await initializedRepo();
  // md-only diff: review-exempt by construction, so exactly one pi run (the author) is
  // expected — a second invocation would mean the gate ran on a markdown-only change.
  const counter = path.join(tmpdir(), "pi-calls");
  fs.writeFileSync(counter, "0");
  await withPi(
    [
      `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'`,
      // Replace the first _None yet._ placeholder (the one under ## Open — the seeded file
      // has one per section) with a real entry, as a runner would.
      `awk '!done && /^_None yet\\._$/ { print "### Q1: which database?"; done=1; next } { print }' QUESTIONS.md > .q.tmp && mv .q.tmp QUESTIONS.md`,
      `printf '%s\\n' '${assistantLine("asked the user about the database\nSUMMARY: post a question", { tokens: 42, output: 42, cost: 0.05 })}'`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      const outcome = await runner.run();
      assert.equal(outcome.result, "queued");
      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "changed");

      // The question reached main under ## Open…
      const questionsMd = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
      assert.match(questionsMd, /## Open\n\n### Q1: which database?/);

      // …and the event log carries both events: merged plus one question_posted naming the new
      // heading.
      const events = readEvents(repo);
      const merged = events.filter((e) => e.type === "merged");
      assert.equal(merged.length, 1);
      const posted = events.filter((e) => e.type === "question_posted");
      assert.equal(posted.length, 1, "exactly one new Open entry was posted");
      assert.equal(posted[0]!.source, "improve");
      assert.equal(posted[0]!.question, "Q1: which database?");
      // The question event lands alongside (after) the merged event for the same commit.
      assert.ok(
        events.findIndex((e) => e.type === "merged") < events.findIndex((e) => e.type === "question_posted"),
        "question_posted follows merged in the log",
      );

      // The md-only diff skipped the review gate: no reviewer run was burned.
      assert.equal(fs.readFileSync(counter, "utf8").trim(), "1", "exactly one pi run (the author)");
    },
  );
});

test("a run that changes other files emits no question_posted event", async () => {
  const repo = await initializedRepo();
  await withPi(
    [
      // Non-md diff goes through the review gate: approve the reviewer run (identified by its
      // VERDICT prompt) so the run merges like "a run that changes files commits and merges".
      APPROVE_PI,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "improve");
      assert.equal((await runner.run()).result, "queued");
      assert.equal(await mergeHead(repo, runner, defaultConfig(), "improve"), "changed");
      // The seeded QUESTIONS.md has no Open entries before or after: nothing to emit.
      const events = readEvents(repo);
      assert.ok(events.some((e) => e.type === "merged"), "the run merged");
      assert.equal(events.filter((e) => e.type === "question_posted").length, 0);
    },
  );
});

test("the merge lock is the only merge-lock holder: another role's run and queue entry do not need it", async () => {
  const repo = await initializedRepo();
  const lockHeld = path.join(tmpdir(), "a-merge-lock");
  const bDone = path.join(tmpdir(), "b-done");
  // Hold the merge lock directly, then start A's author run and merge while it is held. B's
  // whole run (author + commit + pin + enqueue) must finish inside that window: the merge slot
  // serializes merges, not authoring, and no role run waits on the lock.
  let releaseLock!: () => void;
  const holding = withLock(mergeLockDir(repo), async () => {
    fs.writeFileSync(lockHeld, "");
    await new Promise<void>((resolve) => (releaseLock = resolve));
  });
  await waitForFile(lockHeld);
  await withPi(
    [
      leasedRoleShell(),
      `case "$role" in`,
      `improve)`,
      `  printf '%s\n' '${assistantLine("slow work\\nSUMMARY: slow change")}'`,
      `  echo a > a.txt`,
      `  ;;`,
      `organize)`,
      `  printf '%s\n' '${assistantLine("fast work\\nSUMMARY: fast change")}'`,
      `  echo b > b.txt`,
      `  touch '${bDone}'`,
      `  ;;`,
      `esac`,
    ].join("\n"),
    async () => {
      const a = makeRoleRunner(repo, "improve");
      const b = makeRoleRunner(repo, "organize");
      let bEndAt = 0;
      let aMergeEndAt = 0;
      const pa = (async () => {
        assert.equal((await a.run()).result, "queued");
        const mergeDone = await mergeHead(repo, a, defaultConfig(), "improve");
        aMergeEndAt = Date.now();
        return mergeDone;
      })();
      await waitFor(() => queueDepth(repo) === 1, "A's change to be queued", 30_000);
      const bOutcome = await b.run();
      bEndAt = Date.now();
      await waitForFile(bDone, 30_000);
      assert.equal(bOutcome.result, "queued", "B's run committed and queued while A's merge waited");
      assert.equal(aMergeEndAt, 0, "A's merge is still waiting on the held lock");

      releaseLock();
      await holding;
      assert.equal(await pa, "changed");
      assert.ok(bEndAt < aMergeEndAt, `B finished at ${bEndAt} before A's merge ended at ${aMergeEndAt}: its run must not need the lock`);
      assert.equal(await mergeHead(repo, b, defaultConfig(), "organize"), "changed");
      assert.ok(fs.existsSync(path.join(repo, "a.txt")));
      assert.ok(fs.existsSync(path.join(repo, "b.txt")));
      assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
    },
  );
});
