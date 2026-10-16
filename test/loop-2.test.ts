/** Second slice of the loop e2e suite — split so node --test runs the slices in parallel
 * processes: top-level tests within one file run sequentially, while each test FILE gets its
 * own process (and its own PATH, which fakePi's global PATH swap requires). The slices are
 * balanced by measured per-test duration; keep them roughly equal when moving tests between
 * the files. The red-main baseline block now lives in loop-red-main.test.ts (its own process,
 * like every file here; makeMainRed lives in repo-fixtures.ts, which files here import).
 * The prompt-requeue survival cluster lives in loop-prompt-requeue.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/config.js";
import { readEvents } from "../src/events/event-read.js";
import { refSha } from "../src/git/git.js";
import { queueDepth } from "../src/landing/landing-queue.js";
import { enqueuePrompt } from "../src/inbox/inbox.js";
import { landingRefName, sessionDir } from "../src/paths.js";
import { eventsOfType, warningMessages } from "./fixtures/log-fixtures.js";
import { makeLoopRunner, roleWt } from "./fixtures/loop-fixtures.js";
import { landHead } from "./fixtures/orchestrator-fixtures.js";
import { initializedRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { fakePi, firstRunThenIdle, logFlagsTo, logPromptsTo, readRunBlocks, TOUCH_SESSION, withPi } from "./fakes/fake-pi.js";
import { waitForFile } from "./helpers/wait.js";
import { APPROVE_PI, assistantLine, reviewerPi, thinkingOnlyLine } from "./fixtures/pi-events.js";

// Thrash flag (plans/refusal-and-thrash.md item b): a changed tick whose authoring run burned
// BOTH more than thrashTurns turns and thrashMinutes of wall clock is flagged high-friction —
// one warning event carrying both thresholds, the outcome flag, the reviewer prompt's
// HIGH-FRICTION marker, and the Friction trailer line on the commit itself. Requiring both (not
// either) keeps a fast model's ordinary 40-turn/few-minute tick unflagged (BUGS.md 2026-09-19).
// The fake pi identifies reviewer runs by their VERDICT prompt (the pattern this file already
// uses for gate tests) and records that run's args to a file outside the worktree.

test("a changed run past thrashTurns is flagged high-friction end to end", async () => {
  const repo = await initializedRepo();
  const reviewArgs = path.join(tmpdir(), "review-args");
  const script = [
    reviewerPi("VERDICT: approve", reviewArgs),
    // Two assistant turns with thrashTurns set to 1 AND thrashMinutes set to 0 → past both
    // thresholds, so the flag fires.
    `printf '%s\\n' '${assistantLine("first turn of work")}'`,
    `printf '%s\\n' '${assistantLine("second turn\nSUMMARY: slow change", { tokens: 42, output: 42, cost: 0.05 })}'`,
    `echo hello > hello.txt`,
  ].join("\n");
  await withPi(script, async () => {
    const config = defaultConfig();
    config.thrashTurns = 1;
    config.thrashMinutes = 0;
    const runner = makeLoopRunner(repo, "improve", config);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(runner.state.lastResult, undefined, "a queued run records no completed result");
    assert.equal(await landHead(repo, runner, config, "improve"), "changed");
    assert.ok(outcome.highFriction, "the run is flagged high-friction");
    // The flag annotates the summary for dashboards and lastSummary — the latter once the
    // landing resolves, paired with the landing's result (BUGS.md 2026-09-23).
    assert.match(String(outcome.summary), /^slow change \(high friction: 2 turns \/ \d+m\)$/);
    assert.equal(runner.state.lastResult, "changed");
    assert.equal(runner.state.lastSummary, outcome.summary);

    // The warning event carries both thresholds.
    const events = readEvents(repo);
    const warnings = events.filter(
      (e) => e.type === "warning" && String(e.message).includes('high-friction'),
    );
    assert.equal(warnings.length, 1, "exactly one high-friction warning event");
    assert.match(
      String(warnings[0]!.message),
      /^high-friction run: 2 turns in \d+ min \(thresholds: 1 turns \/ 0 min\)$/,
    );

    // The reviewer run's prompt carried the HIGH-FRICTION marker for extra scrutiny.
    assert.match(fs.readFileSync(reviewArgs, "utf8"), /HIGH-FRICTION/);

    // The commit on main carries the Friction trailer line after the Tick line (item d's e2e).
    const body = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(body, /^Tick: improve #\d+ · turns 2 · ctx \S+\nFriction: high \(2 turns \/ \d+m\)$/m);
  });
});

test("a changed run past only thrashTurns is not flagged high-friction", async () => {
  const repo = await initializedRepo();
  const reviewArgs = path.join(tmpdir(), "review-args");
  const script = [
    reviewerPi("VERDICT: approve", reviewArgs),
    // Two turns with thrashTurns set to 1 is past the turn threshold; the default
    // thrashMinutes of 30 is nowhere near → only the turns side fires. Both are required, so
    // an ordinary fast tick is NOT flagged (the false positive BUGS.md 2026-09-19 recorded).
    `printf '%s\\n' '${assistantLine("first turn of work")}'`,
    `printf '%s\\n' '${assistantLine("second turn\nSUMMARY: fast change", { tokens: 42, output: 42, cost: 0.05 })}'`,
    `echo hello > hello.txt`,
  ].join("\n");
  await withPi(script, async () => {
    const config = defaultConfig();
    config.thrashTurns = 1;
    const runner = makeLoopRunner(repo, "improve", config);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, config, "improve"), "changed");
    assert.ok(!outcome.highFriction, "a turns-only fast run is not flagged high-friction");

    // No high-friction warning event, no marker on the reviewer prompt, and no Friction
    // trailer on the commit.
    const events = readEvents(repo);
    assert.ok(
      !events.some((e) => e.type === "warning" && String(e.message).includes('high-friction')),
      "no high-friction warning event",
    );
    assert.doesNotMatch(fs.readFileSync(reviewArgs, "utf8"), /HIGH-FRICTION/);
    assert.doesNotMatch(sh(repo, "git", "log", "-1", "--format=%B"), /Friction:/);
  });
});

test("an ordinary changed run under both thresholds is not flagged high-friction", async () => {
  const repo = await initializedRepo();
  const reviewArgs = path.join(tmpdir(), "review-args");
  const script = [
    reviewerPi("VERDICT: approve", reviewArgs),
    `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
    `echo hello > hello.txt`,
  ].join("\n");
  await withPi(script, async () => {
    // Default thresholds (40 turns / 30 min): one fast turn is far under both.
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    assert.ok(!outcome.highFriction, "an ordinary run is not flagged high-friction");

    // No high-friction warning event…
    const events = readEvents(repo);
    assert.ok(
      !events.some((e) => e.type === "warning" && String(e.message).includes('high-friction')),
      "no high-friction warning event",
    );
    // …the reviewer prompt carries no marker, and the commit has no Friction line.
    assert.doesNotMatch(fs.readFileSync(reviewArgs, "utf8"), /HIGH-FRICTION/);
    assert.doesNotMatch(sh(repo, "git", "log", "-1", "--format=%B"), /Friction:/);
  });
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
      "WHY: the roles needed a hello file to prove the pipeline works",
      "RISK: none that I can see",
      "VERIFIED: npm test, all pass",
    ].join("\n"),
    { tokens: 42, output: 42, cost: 0.05 },
  );
  const summaryOnly = assistantLine("done\nSUMMARY: add world file", { tokens: 7, output: 7, cost: 0.01 });
  const script =
    APPROVE_PI + "\n" +
    `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'\n` +
    `[ "$n" -eq 1 ] && { printf '%s\\n' '${compliant}'; echo hello > hello.txt; } || { printf '%s\\n' '${summaryOnly}'; echo world > world.txt; }`;
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "improve");

    // Tick 1: compliant reply → the commit on main carries subject, body (all three fields,
    // in contract order), and the harness-stamped trailer as separate paragraphs. One author
    // turn plus one reviewer run — the trailer counts only the pre-commit author turns.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    const first = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(
      first,
      /^tumwater\(improve\): add hello file\n\nWHY: the roles needed a hello file to prove the pipeline works\nRISK: none that I can see\nVERIFIED: npm test, all pass\n\nTick: improve #1 · turns 1 · ctx 42$/m,
    );

    // Tick 2: SUMMARY-only reply → subject + trailer only; no body paragraph at all.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    const second = sh(repo, "git", "log", "-1", "--format=%B");
    assert.match(second, /^tumwater\(improve\): add world file\n\nTick: improve #2 · turns 1 · ctx 7$/m);
    assert.doesNotMatch(second, /WHY:|RISK:|VERIFIED:/);
  });
});

// Per-tick usage in the event feed (PLANS.md): run_end carries this tick's tokens and cost,
// so `tumwater logs` shows where spend went without diffing status-table snapshots. The
// rendering rules live in test/event-format.test.ts; these e2es pin that a real tick emits
// the fields on its event — summed over every pi run of the tick (here: author + zero-usage
// reviewer) — and that a skipped tick carries neither.

test("a changed run's run_end event carries its per-run tokens and cost", async () => {
  const repo = await initializedRepo();
  const script = [
    // The reviewer run reports zero usage, so the tick's totals are exactly the author
    // run's — the same numbers the status table's gen column shows for this tick.
    APPROVE_PI,
    `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 18400, output: 18400, cost: 0.37 })}'`,
    `echo hello > hello.txt`,
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "improve");
    assert.equal((await runner.tick()).result, "queued");

    const ends = eventsOfType(repo, "run_end");
    assert.equal(ends.length, 1, "one run ran");
    // tokens is the AUTHOR run's window, costUsd its spend — the landing's own spend (the
    // zero-usage reviewer) rides the `landed` event instead.
    assert.equal(ends[0]!.tokens, 18400);
    assert.equal(ends[0]!.costUsd, 0.37);
    // The state file still carries the same per-tick window (the gen column's source).
    assert.equal(runner.state.generatedTokens, 18400);

    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    const landed = eventsOfType(repo, "landed");
    assert.equal(landed.length, 1, "the merge slot logged its own outcome");
    assert.equal(landed[0]!.result, "changed");
    assert.equal(landed[0]!.tokens, undefined, "the zero-usage reviewer omits the token field");
  });
});

test("a skipped run's run_end event carries no usage fields", async () => {
  // A director with an empty inbox skips without running pi: its run_end must carry neither
  // tokens nor costUsd, so it renders byte-identical to a pre-feature line.
  const repo = await initializedRepo();
  const runner = makeLoopRunner(repo, "director");
  assert.equal((await runner.tick()).result, "skipped");

  const ends = eventsOfType(repo, "run_end");
  assert.equal(ends.length, 1, "one run ran");
  assert.equal(ends[0]!.tokens, undefined, "no tokens field on a skipped run");
  assert.equal(ends[0]!.costUsd, undefined, "no costUsd field on a skipped run");
});

// Context-ceiling memory across ticks (src/prompt/prompt-followup.ts buildCutOffNote /
// buildResumePrompt's cut-off cause): a cut-off resume must be told what actually happened, and a
// fresh tick after
// the loop gave up resuming must be told its last attempts were too big for the window.
test("a cut-off resume is bridged as a cut-off, and the fresh run after the limit carries the note", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts.log");
  const script = [
    logPromptsTo(promptsFile),
    `printf '%s\n' '${thinkingOnlyLine("cut off again", { output: 16 })}'`,
  ].join("\n");
  await withPi(script, async () => {
    fs.mkdirSync(sessionDir(repo, "perf"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(repo, "perf"), "s.jsonl"), "{}\n");
    const runner = makeLoopRunner(repo, "perf");
    // Tick 1 fresh; ticks 2–4 resume (CUT_OFF_RESUME_LIMIT resumes); tick 5 is fresh again.
    for (let i = 1; i <= 5; i++) assert.equal((await runner.tick()).result, "no_change");
    const runs = readRunBlocks(promptsFile);
    assert.equal(runs.length, 5);
    assert.doesNotMatch(runs[0]!, /ran out of context/, "the first, fresh run carries no cut-off text");
    // The resumes continue the compacted session: the bridge names the real cause, not a restart.
    for (const resumed of runs.slice(1, 4)) {
      assert.match(resumed, /--continue/);
      assert.match(resumed, /ran out of context before it could finish/);
      assert.doesNotMatch(resumed, /Tumwater was restarted/);
    }
    // Tick 5 is fresh (past the limit): the only memory of four failed attempts is the note,
    // and it counts every cut-off — the streak keeps counting past the resume limit.
    assert.doesNotMatch(runs[4]!, /--continue/);
    assert.match(runs[4]!, /Your previous 4 runs as this role ran out of context before merging anything/);
    assert.match(runs[4]!, /Your task this run:/, "…on an otherwise normal run prompt");
    assert.equal(runner.state.cutOffStreak, 5);
    const resumes = eventsOfType(repo, "resume");
    assert.equal(resumes.length, 3);
    assert.ok(resumes.every((e) => e.cause === "cut-off"), "resume events name the cut-off cause");
  });
});

test("a shutdown resume is bridged as a restart with no cut-off note", async () => {
  const repo = await initializedRepo();
  const promptsFile = path.join(tmpdir(), "prompts.log");
  let restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  const controller = new AbortController();
  try {
    const runner = makeLoopRunner(repo, "clean", defaultConfig(), "main", controller.signal);
    const first = runner.tick();
    await waitForFile(path.join(roleWt(repo, "clean"), "partial.txt"));
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
        logPromptsTo(promptsFile),
        `rm -f partial.txt`,
        `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      ].join("\n"),
    );
    const resumed = makeLoopRunner(repo, "clean");
    assert.equal((await resumed.tick()).result, "no_change");
    const run = fs.readFileSync(promptsFile, "utf8");
    assert.match(run, /Tumwater was restarted while you/);
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
  const script = [
    TOUCH_SESSION,
    logFlagsTo(argsFile),
    ...firstRunThenIdle(marker, [
      `echo 'SyntaxError: Unterminated string in JSON at position 2781 (line 1 column 2782)' >&2`,
      `exit 1`,
    ]),
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "clean");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the retry's verdict stands in for the run");
    assert.ok(!runner.state.lastError, `no error recorded: ${runner.state.lastError}`);
    const runs = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    assert.equal(runs.length, 2);
    assert.ok(!runs[0]!.includes("--continue"), "the first attempt was the fresh run run");
    assert.ok(runs[1]!.includes("--continue"), "the retry continued the crashed run's session");
    const warnings = warningMessages(repo);
    assert.ok(warnings.some((w) => /pi crashed on malformed JSON .*Unterminated string.* — resuming the session once/.test(w)), JSON.stringify(warnings));
  });
});

// A failed pin write is the tick's fail-closed branch: the commit STAYS on the branch for
// next-tick recovery — resetting the worktree here would orphan it. Blocking the ref: git
// happily removes an EMPTY directory at a ref's path before creating the file, but not a
// non-empty one — the stray blocker file makes `git update-ref` fail, like an un-writable
// .git would. Tick 2's leftover recovery then adopts the unpinned tip
// into the pin scheme and queues it for the same review gate — invariant 1 must hold
// whether or not the pin survived (plans/merge-queue.md).
test("a failed pin leaves the commit on the branch; the next run recovers and lands it", async () => {
  const repo = await initializedRepo();
  // Tick 1: one authoring run that makes a change. The tick ends at commit + pin, so the
  // VERDICT branch below only guards against the review prompt ever reaching this script.
  const script1 = [
    APPROVE_PI,
    `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
    `echo hello > hello.txt`,
  ].join("\n");
  const blockedRef = path.join(repo, ".git", "refs", "tumwater", "landing", "improve");
  fs.mkdirSync(blockedRef, { recursive: true });
  fs.writeFileSync(path.join(blockedRef, "blocker"), "keep the directory non-empty\n");
  await withPi(script1, async () => {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.equal(outcome.summary, "failed to pin the merge ref; left for the next run's recovery");
    assert.equal(runner.state.lastError, "failed to pin the merge ref; left for the next run's recovery");
    assert.ok(runner.state.backoffSeconds > 0, "the error run backs off on the error ladder");

    // The commit stays on the branch ahead of main — the worktree was NOT reset.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve").trim(), "1");
    assert.equal(fs.existsSync(path.join(repo, "hello.txt")), false, "nothing reached main");

    // Nothing was enqueued, and the ref was never pinned.
    assert.equal(queueDepth(repo), 0);
    assert.equal(await refSha(repo, landingRefName("improve")), null);

    // The failure is observable as a warning naming the recovery plan.
    const warnings = warningMessages(repo);
    assert.ok(
      warnings.some((w) =>
        /failed to pin \S+ by its merge ref — leaving the commit on the branch for the next run's recovery/.test(w),
      ),
      JSON.stringify(warnings),
    );
  });
  fs.rmSync(blockedRef, { recursive: true, force: true });

  // Unblock done (the first tick's withPi block ended); tick 2's leftover recovery adopts the
  // unpinned commit and puts it on
  // the land queue — the tick ends there, like a fresh changed tick — and the landing slot
  // lands
  // it through the same gate, with the approve.
  const script2 = [
    APPROVE_PI,
    `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");
  await withPi(script2, async () => {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "recovery queued the unpinned commit; no authoring run");
    assert.equal(fs.existsSync(path.join(repo, "hello.txt")), false, "nothing lands inside the run");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the recovered commit merged on main");
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add hello file/);
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve").trim(), "0", "the branch is back at main");
    assert.equal(await refSha(repo, landingRefName("improve")), null, "the merged pin is deleted");
    assert.equal(queueDepth(repo), 0);
    // Like the pinned-recovery case, the landing is recorded as a merged event (what the
    // usage report counts), from the landing slot rather than the tick.
    const merged = eventsOfType(repo, "merged");
    assert.equal(merged.length, 1);
    // The merged summary names what landed — the recovered commit's own subject — not
    // merely that a recovery happened, so the failure digest's "Landed in the window" is
    // never opaque (BUGS.md 2026-09-21).
    assert.equal(String(merged[0]!.summary), "recovered leftover work from improve: add hello file");
  });
});

// A tick whose authoring agent reads an image on a model that cannot see it stops and fails
// (plans/image-input.md "Detecting a blind read" / "Failing the tick"): pi strips such an
// image from the request, so the run is killed at the first read and the tick ends error
// instead of answering about a picture it never saw. The fake pi emits the read start, its
// end carrying pi's non-vision note, and nothing more — the runner must kill it before any
// further output.
test("a run whose agent reads an image on a blind model stops and fails", async () => {
  const repo = await initializedRepo();
  const script = [
    `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/x/shot.png" } })}'`,
    `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "Read image file [png]\\n[Current model does not support images. The image will be omitted from this request.]" }] }, isError: false })}'`,
  ].join("\n");
  await withPi(script, async () => {
    const runner = makeLoopRunner(repo, "improve");
    const outcome = await runner.tick();

    assert.equal(outcome.result, "error", "the run ends error on a blind image read");
    assert.match(runner.state.lastError ?? "", /read \/x\/shot\.png, but .* cannot read images/);
    const blinds = eventsOfType(repo, "image_blind");
    assert.equal(blinds.length, 1, "exactly one image_blind event");
    assert.equal(blinds[0]!.loop, "improve");
    assert.equal(blinds[0]!.path, "/x/shot.png");
    assert.equal(blinds[0]!.action, "fail", "an authoring run's blind read earns the fail action");
    assert.ok(typeof blinds[0]!.tick === "number", "the event names the run");
  });
});

// Image-input reroute (plans/image-input.md part 4/5): with a text-only default tier and a
// vision strong tier, a blind read on a text-only loop ends the tick aborted/`image-reroute`
// (no target-less error), and the NEXT tick runs immediately on the vision target in a fresh
// session over the kept worktree carrying the handoff note — its run_start stamped
// reroute:"image" — while the tick after that is back on the loop's own tier.
test("a blind read on a text-only role reroutes to the vision target, then back to its own tier", async () => {
  const repo = await initializedRepo();
  // A text-only default tier and a vision strong tier, via a models.json in the suite's
  // scratch pi dir (the same file run-agent's seam check and imageReroute read).
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );

  const config = defaultConfig();
  // defaultConfig returns a ResolvedModelConfig whose `model` is narrowed to string; a map
  // form is valid config the loaded runtime reads, so cast at the boundary.
  (config as { model: string | Record<string, string> }).model = {
    default: "local/text",
    strong: "local/vision",
  };

  const promptsFile = path.join(tmpdir(), "reroute-prompts");
  const blindScript = [
    `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/x/s.png" } })}'`,
    `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "Read image file [png]\\n[Current model does not support images. The image will be omitted from this request.]" }] }, isError: false })}'`,
    logPromptsTo(promptsFile),
  ].join("\n");
  const settlePi = [
    logPromptsTo(promptsFile),
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");
  const runner = makeLoopRunner(repo, "feature", config);

  // Tick 1: the blind read stops the tick; with a vision target it ends aborted/image-reroute
  // and records the one-shot marker instead of failing.
  await withPi(blindScript, async () => {
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted", "a blind read with a target ends aborted");
    assert.equal(outcome.resumeCause, "image-reroute");
  });
  assert.equal(runner.state.imageReroute?.tier, "strong");
  assert.equal(runner.state.imageReroute?.model, "vision");
  assert.equal(runner.state.imageReroute?.path, "/x/s.png");

  // Tick 2: a fresh-session run on the vision target. The handoff note names the prior model
  // and the image, run_start is stamped reroute:"image" on local/vision, and the one-shot
  // marker is consumed.
  await withPi(settlePi, async () => {
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change");
  });
  assert.equal(runner.state.imageReroute, undefined, "the one-shot marker is consumed by the rerouted run");
  // The blind tick (1) is killed at the first read, so only the rerouted tick (2) reliably
  // reaches its logPromptsTo line; take the last logged prompt as tick 2's.
  const blocks = readRunBlocks(promptsFile);
  const reroutedPrompt = blocks[blocks.length - 1] ?? "";
  assert.match(reroutedPrompt, /cannot read images/);
  assert.match(reroutedPrompt, /\/x\/s\.png/);
  const starts = readEvents(repo).filter((e) => e.type === "run_start");
  const reroutedStart = starts.find((e) => e.reroute === "image");
  assert.ok(reroutedStart, "run_start carries reroute:image on the rerouted run");
  assert.equal(String(reroutedStart!.model), "local/vision", "the rerouted run runs on the target");

  // Tick 3: back on the loop's own text-only tier — run_start has no reroute stamp and names
  // the loop's own model.
  await withPi(settlePi, async () => {
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change");
  });
  const startsAfter = readEvents(repo).filter((e) => e.type === "run_start");
  const back = startsAfter[startsAfter.length - 1]!;
  assert.equal(back.reroute, undefined, "the run after the reroute is back on the role's own tier");
  assert.equal(String(back.model), "local/text");
});

// Image-input reroute for the DIRECTOR (plans/image-input.md part 4/5, INV-J2): the director
// never resumes, so the rerouted prompt runs FRESH on the image-capable target exactly once, and
// the one-shot marker clears (in runTickPhase) so the director's later ticks are back on its own
// tier instead of being re-routed forever.
test("a rerouted director prompt runs fresh on the vision target and is delivered once", async () => {
  const repo = await initializedRepo();
  // A text-only default tier and a vision strong tier, via a models.json in the suite's
  // scratch pi dir (the same file run-agent's seam check and imageReroute read).
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { local: { models: [{ id: "text" }, { id: "vision", input: ["text", "image"] }] } } }),
  );

  const config = defaultConfig();
  // defaultConfig returns a ResolvedModelConfig whose `model` is narrowed to string; a map
  // form is valid config the loaded runtime reads, so cast at the boundary.
  (config as { model: string | Record<string, string> }).model = {
    default: "local/text",
    strong: "local/vision",
  };
  // The director's seam tier is "strong" by default (roleSeamTier); to exercise a director
  // that is itself blind and reroutes to vision, pick its tier as the text-only "default".
  config.roles.director!.model = "default";

  const promptsFile = path.join(tmpdir(), "director-reroute-prompts");
  const blindScript = [
    `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/x/d.png" } })}'`,
    `printf '%s\\n' '${JSON.stringify({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", result: { content: [{ type: "text", text: "Read image file [png]\\n[Current model does not support images. The image will be omitted from this request.]" }] }, isError: false })}'`,
    logPromptsTo(promptsFile),
  ].join("\n");
  const settlePi = [
    logPromptsTo(promptsFile),
    `printf '%s\\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
  ].join("\n");

  const runner = makeLoopRunner(repo, "director", config);
  enqueuePrompt(repo, "read the attached image");

  // Tick 1: the director's blind read ends aborted/`image-reroute` and records the one-shot
  // marker; the director never resumes, so the prompt re-queues to run fresh next tick.
  await withPi(blindScript, async () => {
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted", "a director blind read with a target ends aborted");
    assert.equal(outcome.resumeCause, "image-reroute");
  });
  assert.equal(runner.state.imageReroute?.tier, "strong");

  // Tick 2: the rerouted director prompt runs FRESH on the vision target, and the one-shot
  // marker is consumed so it is NOT re-routed again.
  await withPi(settlePi, async () => {
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change");
  });
  assert.equal(runner.state.imageReroute, undefined, "the one-shot marker clears for the director too");
  const starts = readEvents(repo).filter((e) => e.type === "run_start");
  const reroutedStart = starts.find((e) => e.reroute === "image");
  assert.ok(reroutedStart, "run_start carries reroute:image on the rerouted director run");
  assert.equal(String(reroutedStart!.model), "local/vision", "the rerouted director run runs on the target");

  // Tick 3: with a NEW queued prompt and the one-shot marker cleared, the director is back on
  // its own text-only tier — no reroute stamp, own model (without the clearing fix the marker
  // would persist and this tick would re-route onto the vision target).
  enqueuePrompt(repo, "a follow-up director prompt");
  await withPi(settlePi, async () => {
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change");
  });
  const startsAfter = readEvents(repo).filter((e) => e.type === "run_start");
  const back = startsAfter[startsAfter.length - 1]!;
  assert.equal(back.reroute, undefined, "the director run after the reroute is back on its own tier");
  assert.equal(String(back.model), "local/text");
});
