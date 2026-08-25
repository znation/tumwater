import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { dequeuePrompt, enqueuePrompt, inboxSize } from "../src/inbox.js";
import { readEvents } from "../src/events.js";
import { assistantLine, errorLine, fakePi, makeRepo, sh, tmpdir } from "./util.js";

async function initializedRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "A test project.");
  return repo;
}

test("a tick that changes files commits and merges to main", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'\necho hello > hello.txt`,
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.equal(outcome.summary, "add hello file");
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")));
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add hello file/);
    assert.equal(runner.state.commits, 1);
    assert.equal(runner.state.backoffSeconds, 0);
    assert.equal(runner.state.generatedTokens, 42);
    assert.equal(runner.state.peakContextTokens, 42);
  } finally {
    restore();
  }
});

test("a nothing-to-do tick backs off without committing", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`);
  try {
    const config = defaultConfig();
    const runner = new LoopRunner(repo, "clean", config, "main");
    const before = sh(repo, "git", "rev-parse", "main");
    const first = await runner.tick();
    assert.equal(first.result, "no_change");
    assert.equal(sh(repo, "git", "rev-parse", "main"), before);
    assert.equal(runner.state.backoffSeconds, config.idleBackoff.initialSeconds);
    const second = await runner.tick();
    assert.equal(second.result, "no_change");
    assert.equal(
      runner.state.backoffSeconds,
      config.idleBackoff.initialSeconds * config.idleBackoff.factor,
    );
    assert.ok(runner.state.nextRunAt > Date.now());
  } finally {
    restore();
  }
});

test("a nothing-to-do declaration in an intermediate turn does not warn (regression)", async () => {
  const repo = await initializedRepo();
  // pi declares nothing-to-do, then emits a closing remark afterwards; no file changes.
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'\n` +
      `printf '%s\n' '${assistantLine("all done")}'`,
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const warnings = readEvents(repo).filter((e) => e.type === "warning");
    assert.deepEqual(warnings, [], "no spurious warning when the sentinel was declared mid-run");
  } finally {
    restore();
  }
});

test("a non-compliant tick warns and notes a truncated final message", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`printf '%s\n' '${assistantLine("hmm, let me think", { stopReason: "length" })}'`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const [warning] = readEvents(repo).filter((e) => e.type === "warning");
    assert.ok(warning, "expected exactly one warning");
    assert.match(String(warning.message), /stopReason=length/);
  } finally {
    restore();
  }
});

test("a silent tick warns that no assistant text was captured", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exit 0`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    const [warning] = readEvents(repo).filter((e) => e.type === "warning");
    assert.ok(warning, "expected exactly one warning");
    assert.match(String(warning.message), /no assistant text/);
  } finally {
    restore();
  }
});

test("a failing pi run records an error and backs off", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`echo 'pi exploded' >&2\nexit 1`);
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.ok(runner.state.lastError);
    assert.ok(runner.state.backoffSeconds > 0);
  } finally {
    restore();
  }
});

test("director skips with an empty inbox and runs a queued prompt", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    `printf '%s\n' '${assistantLine("ok\nSUMMARY: honor user request")}'\necho req > request.txt`,
  );
  try {
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "skipped");
    enqueuePrompt(repo, "please add request.txt");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.ok(fs.existsSync(path.join(repo, "request.txt")));
    assert.equal(inboxSize(repo), 0, "a fulfilled prompt is not re-queued");
  } finally {
    restore();
  }
});

test("worktree changes commit even when pi forgets the summary line", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`printf '%s\n' '${assistantLine("did it, no summary")}'\necho x > x.txt`);
  try {
    const runner = new LoopRunner(repo, "dry", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(dry\): dry tick 1/);
  } finally {
    restore();
  }
});

test("an aborted tick discards partial work and does not back off", async () => {
  const repo = await initializedRepo();
  // Writes a half-done change, then hangs until killed. `exec` so SIGTERM reaches sleep.
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const controller = new AbortController();
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main", controller.signal);
    const before = sh(repo, "git", "rev-parse", "main");
    setTimeout(() => controller.abort(), 300);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted");
    assert.equal(sh(repo, "git", "rev-parse", "main"), before, "nothing lands on main");
    assert.ok(!fs.existsSync(path.join(repo, "partial.txt")));
    assert.equal(runner.state.backoffSeconds, 0);
    assert.ok(runner.state.nextRunAt <= Date.now(), "resumes promptly on restart");
  } finally {
    restore();
  }
});

test("an aborted director tick re-queues the user prompt", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    assert.equal(inboxSize(repo), 1);
    const controller = new AbortController();
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main", controller.signal);
    setTimeout(() => controller.abort(), 300);
    const outcome = await runner.tick();
    assert.equal(outcome.result, "aborted");
    assert.equal(inboxSize(repo), 1, "prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
  } finally {
    restore();
  }
});

test("a failing director tick re-queues the user prompt (regression)", async () => {
  const repo = await initializedRepo();
  // pi fails hard: non-zero exit, no assistant text, and no file changes.
  const restore = fakePi(`echo 'pi exploded' >&2\nexit 1`);
  try {
    enqueuePrompt(repo, "please do the thing");
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.equal(inboxSize(repo), 1, "the unfulfilled prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "please do the thing");
  } finally {
    restore();
  }
});

test("a timed-out director tick re-queues the user prompt (regression)", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`exec sleep 30`);
  try {
    enqueuePrompt(repo, "important request");
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = new LoopRunner(repo, "director", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /timed out/);
    assert.equal(inboxSize(repo), 1, "the unfulfilled prompt is back in the inbox");
    assert.equal(dequeuePrompt(repo), "important request");
  } finally {
    restore();
  }
});

test("a director tick that handles a prompt with no file changes does not re-queue it", async () => {
  const repo = await initializedRepo();
  // pi answers the question in its reply and changes nothing: that IS fulfillment.
  const restore = fakePi(`printf '%s\n' '${assistantLine("The answer is 42.")}'`);
  try {
    enqueuePrompt(repo, "what is the answer?");
    const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "no_change");
    assert.equal(inboxSize(repo), 0, "a handled prompt must not loop back into the inbox");
  } finally {
    restore();
  }
});

test("a timed-out tick reports an error and never commits partial work", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(`echo partial > partial.txt\nexec sleep 30`);
  try {
    const config = defaultConfig();
    config.tickTimeoutSeconds = 1;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const before = sh(repo, "git", "rev-parse", "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /timed out/);
    assert.equal(sh(repo, "git", "rev-parse", "main"), before);
    assert.ok(runner.state.backoffSeconds > 0);
  } finally {
    restore();
  }
});

test("a rebase conflict is resolved by a second pi run and lands with linear history", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Phase 1 (the tick): edit seed.txt on the branch AND advance main with a conflicting
  // edit. Phase 2 (the resolution run): replace the conflict markers with a resolution.
  const restore = fakePi(
    [
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `else`,
      `  echo resolved > seed.txt`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    // The resolution landed as a plain rebased commit: no merge commits on main.
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
    // Routine conflict → pi-resolve → land is normal operation, not something to warn
    // about: the merged event and tick_end already cover observability.
    const warnings = readEvents(repo).filter((e) => e.type === "warning");
    assert.equal(
      warnings.length,
      0,
      `expected no warning events, got: ${JSON.stringify(warnings.map((w) => w.message))}`,
    );
  } finally {
    restore();
  }
});

test("an unresolvable conflict aborts cleanly and reports merge_conflict", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  const restore = fakePi(
    [
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `fi`, // Phase 2 does nothing: the conflict markers stay.
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "merge_conflict");
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n", "main keeps its version");
    const wt = path.join(repo, ".tumwater/worktrees/improve");
    assert.ok(!sh(wt, "git", "status", "--porcelain").includes("UU"));
    // No rebase is left in progress: the branch ref is checked out again (mid-rebase HEAD
    // would be detached).
    assert.equal(sh(wt, "git", "symbolic-ref", "--short", "HEAD"), "tumwater/improve");
  } finally {
    restore();
  }
});

test("leftover commits from a failed merge are recovered on the next tick", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  const m2 = path.join(tmpdir(), "phase2");
  // Phase 1 (tick 1): edit seed.txt on the branch AND advance main with a conflicting
  // edit. Phase 2 (tick 1's resolution run): leave the markers — the merge fails and the
  // tick's commit is left stranded on the branch. Phase 3 (tick 2's recovery run):
  // resolve them this time. Phase 4 (tick 2's own tick): nothing to do.
  const restore = fakePi(
    [
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `elif [ ! -f "${m2}" ]; then`,
      `  touch "${m2}"`, // Unresolvable on the first attempt.
      `else`,
      `  if grep -q '<<<<<<<' seed.txt 2>/dev/null; then echo resolved > seed.txt`,
      `  else printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'; fi`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "merge_conflict");
    // The tick's commit is stranded on the branch: that is what recovery must salvage.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "1");

    const second = await runner.tick();
    assert.equal(second.result, "no_change", "tick 2 itself found nothing to do");
    // The stranded work landed on main via recovery.
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "resolved\n");
    const merged = readEvents(repo).filter((e) => e.type === "merged");
    assert.ok(
      merged.some((e) => String(e.summary) === "recovered leftover work from improve"),
      "recovery is recorded as a merge of the leftover work",
    );
    // The branch is reset to main afterwards, so nothing is stranded twice.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("unmergeable leftover commits are discarded with a warning on the next tick", async () => {
  const repo = await initializedRepo();
  const m1 = path.join(tmpdir(), "phase1");
  // Phase 1 (tick 1): branch edit + conflicting main advance. Every conflict-resolution
  // run (detected by markers in seed.txt) leaves the markers: unresolvable, both ticks.
  const restore = fakePi(
    [
      `if [ ! -f "${m1}" ]; then`,
      `  touch "${m1}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch edit of seed")}'`,
      `  echo branch change > seed.txt`,
      `  echo main change > "${repo}/seed.txt"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main edit"`,
      `elif grep -q '<<<<<<<' seed.txt 2>/dev/null; then`,
      `  : # leave the markers in place (unresolvable)`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "merge_conflict");
    assert.equal((await runner.tick()).result, "no_change");

    // Recovery gave up: the discard is warned about and main keeps its version.
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) => /discarding 1 unmergeable leftover commit\(s\) \(merge_conflict\)/.test(w)),
      `expected a discard warning, got: ${JSON.stringify(warnings)}`,
    );
    assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "main change\n");
    // The stranded commit is gone (reset to main), so it cannot resurface on tick 3.
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve"), "0");
  } finally {
    restore();
  }
});

test("concurrent-main-advance still lands (rebase path, linear history)", async () => {
  const repo = await initializedRepo();
  // The fake pi advances main itself mid-tick, simulating another loop landing work.
  const restore = fakePi(
    [
      `printf '%s\n' '${assistantLine("ok\nSUMMARY: slow work")}'`,
      `echo slow > slow.txt`,
      `git -C "${repo}" -c user.name=t -c user.email=t@t commit --allow-empty -m "someone else"`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "organize", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed");
    assert.ok(fs.existsSync(path.join(repo, "slow.txt")));
    // The tick's commit was rebased onto the concurrent main advance: no merge commits.
    assert.equal(sh(repo, "git", "log", "--merges", "--oneline"), "", "main's history stays linear");
  } finally {
    restore();
  }
});

test("a clean resolution of a conflicted file with setext underlines lands (regression)", async () => {
  const repo = await initializedRepo();
  // docs.md uses a setext heading whose underline is exactly seven '=' — legitimate content
  // that the old marker check mistook for an unresolved conflict separator.
  fs.writeFileSync(path.join(repo, "docs.md"), "History\n=======\n\nFirst entry.\n");
  sh(repo, "git", "add", "-A");
  sh(repo, "git", "commit", "-m", "docs with setext heading");
  const marker = path.join(tmpdir(), "phase");
  // Phase 1 (the tick): both sides edit the same line. Phase 2 (the resolution run):
  // combine them, keeping the setext underline — no real conflict markers remain.
  const restore = fakePi(
    [
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${assistantLine("ok\nSUMMARY: branch docs edit")}'`,
      `  printf 'History\\n=======\\n\\nBranch entry.\\n' > docs.md`,
      `  printf 'History\\n=======\\n\\nMain entry.\\n' > "${repo}/docs.md"`,
      `  git -C "${repo}" -c user.name=t -c user.email=t@t commit -am "conflicting main docs edit"`,
      `else`,
      `  printf 'History\\n=======\\n\\nBranch entry.\\nMain entry.\\n' > docs.md`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "changed", "a clean resolution must not be rejected as conflicted");
    assert.equal(
      fs.readFileSync(path.join(repo, "docs.md"), "utf8"),
      "History\n=======\n\nBranch entry.\nMain entry.\n",
    );
  } finally {
    restore();
  }
});

test("a transient model-server timeout is retried once and the tick succeeds (regression)", async () => {
  const repo = await initializedRepo();
  const marker = path.join(tmpdir(), "phase");
  // Attempt 1 (the tick's pi run): LM Studio kills an idle predict stream after a machine
  // sleep. Attempt 2 (the harness retry, detected by the phase file): a fresh request
  // succeeds within seconds of the wake.
  const restore = fakePi(
    [
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      `  printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'`,
      `  exit 1`,
      `else`,
      `  printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
      `fi`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the retry's verdict stands in for the tick");
    assert.ok(!runner.state.lastError);
    assert.ok(
      !runner.state.consecutiveErrors,
      "a transient failure does not count toward session poisoning",
    );
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((w) => /retrying the pi run once/.test(w)),
      `expected a retry warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

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
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the recovered run's verdict stands");
    assert.ok(!runner.state.lastError);
    // Exactly one pi invocation: no harness-level retry of an already-healthy run.
    assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      !warnings.some((w) => /retrying the pi run once/.test(w)),
      `no retry warning expected: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

test("a transient timeout that also hits the harness timeout is not retried", async () => {
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
    config.tickTimeoutSeconds = 1;
    const runner = new LoopRunner(repo, "clean", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /timed out/);
    // Exactly one pi invocation: the harness timeout suppresses the transient retry.
    assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
  } finally {
    restore();
  }
});

test("a transient timeout on both attempts errors without dropping the healthy session (regression)", async () => {
  const repo = await initializedRepo();
  // Every pi run (tick + retry) hits the idle-stream timeout: the machine keeps sleeping.
  const restore = fakePi(
    `printf '%s\n' '${errorLine("Engine protocol predict stream timed out after 600000ms without receiving data.")}'\nexit 1`,
  );
  try {
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "error");
    assert.match(runner.state.lastError ?? "", /predict stream timed out/);
    // The session is healthy (the world froze): it must survive and not be counted.
    assert.ok(!runner.state.consecutiveErrors, "transient errors do not count toward consecutiveErrors");
    assert.equal(runner.state.hasSession, true, "the healthy session is kept for the next tick");
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      !warnings.some((w) => /fresh pi session/.test(w)),
      `no session-reset warning expected, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});
