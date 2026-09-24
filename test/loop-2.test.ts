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
import { LoopRunner } from "../src/loop.js";
import { initProject } from "../src/init.js";
import { defaultConfig } from "../src/config.js";
import { validateConfig } from "../src/config-validation.js";
import { readEvents } from "../src/events.js";
import { refSha } from "../src/git.js";
import { queueDepth } from "../src/land-queue.js";
import { landingRefName, sessionDir, worktreePath } from "../src/paths.js";
import { assistantLine, errorLine, fakePi, initializedRepo, landHead, makeRepo, sh, thinkingOnlyLine, tmpdir, waitForFile } from "./util.js";

const TOUCH_SESSION = `prev=""; for a in "$@"; do if [ "$prev" = "--session-dir" ]; then mkdir -p "$a"; touch "$a/s.jsonl"; fi; prev="$a"; done`;
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
    // 3s, not 1s: the shim sleeps 30s, so anything well under that still fires the harness
    // timeout while pi is mid-run — but a 1s budget could expire during process spawn under
    // load, before the shim printed its error line at all (BUGS.md 2026-09-18).
    config.tickTimeoutSeconds = 3;
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

test("a transient timeout on both attempts errors with the real cause (regression)", async () => {
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
  } finally {
    restore();
  }
});

// Quiet watchdog: the run is killed when pi stops making *progress* (message/turn/tool
// boundary events — streaming deltas never count), not merely when it stops running fast.

test("a pi run that goes silent is killed as hung and never commits partial work", async () => {
  const repo = await initializedRepo();
  // Emits one line (so it is not silent from birth), writes a partial edit, then hangs
  // like an interactive tool waiting for stdin. `exec` so the signal reaches sleep.
  const restore = fakePi(
    [`printf '%s\n' '${assistantLine("starting work")}'`, `echo partial > partial.txt`, `exec sleep 60`].join("\n"),
  );
  try {
    const config = defaultConfig();
    // 3s, not 1s: the kill still comes from the watchdog (the shim sleeps 60), but the shim
    // needs to reach `echo partial` first — at 1s the watchdog could fire during shell startup
    // under load and the "partial edit survives" assertion measured scheduling (BUGS.md).
    config.quietTimeoutSeconds = 3;
    config.tickTimeoutSeconds = 3600; // The watchdog, not the tick timeout, must fire.
    const runner = new LoopRunner(repo, "improve", config, "main");
    const before = sh(repo, "git", "rev-parse", "main");
    const started = Date.now();
    const outcome = await runner.tick();
    assert.ok(Date.now() - started < 30_000, "killed by the watchdog, not the tick timeout");
    assert.equal(outcome.result, "quiet_killed");
    assert.match(runner.state.lastError ?? "", /killed as hung: no pi progress/);
    assert.equal(sh(repo, "git", "rev-parse", "main"), before, "nothing landed on main");
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

test("a stalled tool call warns in the event feed with the command named", async () => {
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
    // 5s/2s rather than 2s/1s: the ORDER is what this pins — warning first, kill second — and a
    // 1s gap is thinner than the jitter on a machine running two suites at once (BUGS.md).
    config.quietTimeoutSeconds = 5; // the watchdog still owns the kill...
    config.toolCallStallSeconds = 2; // ...but the warning lands first, 3s ahead of it
    const runner = new LoopRunner(repo, "improve", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "quiet_killed");
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
    assert.ok(
      warnings.some((m) => m.startsWith("tool call stalled: bash sleep 999")),
      `the stall warning names the hung command; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    restore();
  }
});

test("a slow but talkative pi run is not killed by the quiet watchdog", async () => {
  const repo = await initializedRepo();
  // Streams a line immediately, then one every ~3s for ~12s — always slower than the 10s quiet
  // window would allow if it were measuring total runtime, but never silent longer than the
  // window. The ratio is what this pins; the ABSOLUTE numbers buy the per-gap margin on purpose
  // (BUGS.md 2026-09-18): the watchdog reads the real wall clock on a real interval (src/pi.ts)
  // so a test clock cannot fake it out, and the fleet runs this suite on a machine it
  // deliberately saturates. At the old 1s-sleep/3s-window sizing the ~2s of slack was thinner
  // than a loaded machine's process-spawn jitter (one gap crossed 3s during a landing gate and
  // the run died quiet_killed, BUGS.md 2026-09-21), and the leading sleep put node spawn + sh
  // startup inside the FIRST gap, the least controllable one — so the first line is emitted
  // before any sleep and the sleeps are 3s against a 10s window: ~7s of drift headroom per gap.
  const chatter = Array.from({ length: 4 }, () => `sleep 3\nprintf '%s\n' '${JSON.stringify({ type: "turn_start" })}'`);
  const restore = fakePi(
    [`printf '%s\n' '${JSON.stringify({ type: "turn_start" })}'`, ...chatter, `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 10;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "run completed despite taking longer than the quiet window");
  } finally {
    restore();
  }
});

test("quietTimeoutSeconds 0 disables the watchdog", async () => {
  const repo = await initializedRepo();
  const restore = fakePi(
    [`sleep 1`, `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`].join("\n"),
  );
  try {
    const config = defaultConfig();
    config.quietTimeoutSeconds = 0;
    const runner = new LoopRunner(repo, "improve", config, "main");
    const outcome = await runner.tick();
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

test("a zombie stream dripping content-free keepalive updates is killed as hung", async () => {
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
    const runner = new LoopRunner(repo, "improve", config, "main");
    const started = Date.now();
    const outcome = await runner.tick();
    assert.ok(Date.now() - started < 30_000, "killed by the progress watchdog");
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
  fs.writeFileSync(
    tool,
    "#!/bin/sh\nif [ -f broken.ts ]; then echo 'src/bad.ts(3,5): error TS2345: not assignable'; exit 1; fi\nexit 0\n",
  );
  fs.chmodSync(tool, 0o755);
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
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    // Tick 1: the change is committed and enqueued; the LANDING's build pre-check rejects it
    // after one bounded fix run (which makes no edits here) — no reviewer run.
    assert.equal((await runner.tick()).result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "rejected");
    assert.ok(!fs.existsSync(path.join(repo, "broken.ts")), "the failing build did not merge");

    // Tick 2: the machine-generated reasons are the cross-tick memory of what broke — every
    // tick starts a fresh pi session, so they must ride along on this tick's prompt. The
    // prompts log now holds three runs: tick 1's author, the landing's fix run, tick 2's
    // author — the fix run is the one bounded model run a red pre-check spends.
    assert.equal((await runner.tick()).result, "no_change");
    const runs = fs.readFileSync(promptsFile, "utf8").split("===RUN===").filter((b) => b.trim());
    assert.equal(runs.length, 3, "two author runs plus the landing's one fix run");
    assert.ok(!runs[0]?.includes("rejected in review"), "tick 1's prompt had no rejection note yet");
    assert.match(runs[1] ?? "", /npm run build.*FAILED/s, "the fix run was told exactly what failed");
    assert.match(runs[1] ?? "", /Never delete a test/, "the fix run may not fake a pass");
    const second = runs[2] ?? "";
    assert.match(second, /Your previous change was rejected in review:/);
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "contradicted work runs the normal flow");
    const subjects = sh(repo, "git", "log", "--format=%s", "-5");
    assert.ok(!subjects.includes("refuse —"), `no refusal commit: ${subjects}`);
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
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
// (src/merge.ts), which captures the Open list before the rebase and diffs it after the ff.

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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
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
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
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
  // sleeps — A holds the merge lock (the lander's merge) for ~3s. B waits for that marker,
  // then does its whole tick (author + commit + pin + enqueue). Since merge queue 3/5 a tick
  // never merges, so it never needs the lock: B must finish while A's landing is still
  // mid-flight. The landing slot serializes merges, not authoring.
  const marker = path.join(tmpdir(), "a-landing");
  const approveLine = assistantLine("VERDICT: approve");
  const restore = fakePi(
    [
      `case "$PWD" in`,
      // The lander worktrees come first: their paths also end in the role name.
      // A's landing's reviewer run (_land-improve): hold the lock while reviewing.
      `*_land-improve)`,
      `  touch '${marker}'; sleep 3; printf '%s\n' '${approveLine}'; exit 0;;`,
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
    const a = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const b = new LoopRunner(repo, "organize", defaultConfig(), "main");
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
    const runner = new LoopRunner(repo, "improve", config, "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, config, "improve"), "changed");
    assert.ok(outcome.highFriction, "the tick is flagged high-friction");
    // The flag annotates the summary for dashboards and lastSummary.
    assert.match(String(outcome.summary), /^slow change \(high friction: 2 turns \/ \d+m\)$/);

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
    const runner = new LoopRunner(repo, "improve", config, "main");
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
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
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
    `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done\n` +
      `n=$(cat '${counter}'); n=$((n+1)); echo $n > '${counter}'\n` +
      `[ "$n" -eq 1 ] && { printf '%s\\n' '${compliant}'; echo hello > hello.txt; } || { printf '%s\\n' '${summaryOnly}'; echo world > world.txt; }`,
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");

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
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 18400, output: 18400, cost: 0.37 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    assert.equal((await runner.tick()).result, "queued");

    const ends = readEvents(repo).filter((e) => e.type === "tick_end");
    assert.equal(ends.length, 1, "one tick ran");
    // tokens is the AUTHOR run's window, costUsd its spend — the landing's own spend (the
    // zero-usage reviewer) rides the `landed` event instead.
    assert.equal(ends[0]!.tokens, 18400);
    assert.equal(ends[0]!.costUsd, 0.37);
    // The state file still carries the same per-tick window (the gen column's source).
    assert.equal(runner.state.generatedTokens, 18400);

    assert.equal(await landHead(repo, runner, defaultConfig(), "improve"), "changed");
    const landed = readEvents(repo).filter((e) => e.type === "landed");
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
  const runner = new LoopRunner(repo, "director", defaultConfig(), "main");
  assert.equal((await runner.tick()).result, "skipped");

  const ends = readEvents(repo).filter((e) => e.type === "tick_end");
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
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
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
    const runner = new LoopRunner(repo, "feature", defaultConfig(), "main");
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
    const checks = readEvents(repo).filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.scope, "baseline");
    assert.equal(checks[0]!.status, "failed");
    assert.equal(checks[0]!.loop, "feature");
    assert.ok(Number(checks[0]!.durationMs) >= 0);

    // Exactly one harness-level warning for the red SHA: script name + clipped first failure line.
    const warnings = readEvents(repo).filter((e) => e.type === "warning" && e.loop === "harness");
    assert.equal(warnings.length, 1);
    const message = String(warnings[0]?.message ?? "");
    assert.match(message, /is red \(test: baseline-failure-line\)/);
    assert.match(message, /code merges blocked until main is green/);

    // The tick_end lines carry the result + summary for the dashboards' last-result column.
    const ends = readEvents(repo).filter((e) => e.type === "tick_end");
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
    const runner = new LoopRunner(repo, "feature", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued");
    assert.equal(await landHead(repo, runner, defaultConfig(), "feature"), "changed");
    assert.ok(fs.existsSync(marker), "the authoring run started on a green main");
    // Two priced check runs: main's baseline before authoring, the gate's pre-check before merge.
    const scopes = readEvents(repo).filter((e) => e.type === "build_check").map((e) => `${e.scope}:${e.status}`);
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
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: note", { tokens: 7, output: 7, cost: 0.01 })}'`,
      `echo more >> PLANS.md`,
      `touch '${marker}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "readme", defaultConfig(), "main");
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
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: fix main", { tokens: 10, output: 10, cost: 0.01 })}'`,
      `echo hello > hello.txt`,
      `touch '${marker}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "bugfix", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "queued", "the healer authors on a red main (never blocked)");
    assert.ok(fs.existsSync(marker), "its pi run started");

    const run = fs.readFileSync(promptsFile, "utf8");
    assert.ok(run.includes("<main-red>"), "the tick prompt carries the red-main block");
    assert.ok(run.includes("baseline-failure-line"), "…naming the failure headline");
    assert.ok(run.includes("test"), "…and the failing script");

    // The healer's check is priced in the feed under bugfix, and the red SHA warns once.
    const checks = readEvents(repo).filter((e) => e.type === "build_check");
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.loop, "bugfix");
    assert.equal(checks[0]!.scope, "baseline");
    assert.equal(checks[0]!.status, "failed");
    assert.equal(readEvents(repo).filter((e) => e.type === "warning" && e.loop === "harness").length, 1);
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
    const runner = new LoopRunner(repo, "feature", defaultConfig(), "main");
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
  fs.writeFileSync(
    path.join(piDir, "pi"),
    `#!/bin/sh\n${[
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
      // Redirection, not touch: the restricted PATH below has no /usr/bin, so this script
      // may rely on shell builtins only.
      `printf ok > '${marker}'`,
    ].join("\n")}\n`,
  );
  fs.chmodSync(path.join(piDir, "pi"), 0o755);

  const gitBin = tmpdir();
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(gitBin, "git"));

  const oldPath = process.env.PATH;
  process.env.PATH = `${piDir}:${gitBin}`; // pi + git only — no npm anywhere
  try {
    const runner = new LoopRunner(repo, "feature", defaultConfig(), "main");
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
    const harnessWarnings = readEvents(repo).filter((e) => e.type === "warning" && e.loop === "harness");
    assert.equal(harnessWarnings.length, 0, `no verified-red warning for an unverified main:\n${JSON.stringify(harnessWarnings)}`);
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
    const runner = new LoopRunner(repo, "perf", defaultConfig(), "main");
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
    const resumes = readEvents(repo).filter((e) => e.type === "resume");
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
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main", controller.signal);
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
    const resumed = new LoopRunner(repo, "clean", defaultConfig(), "main");
    assert.equal((await resumed.tick()).result, "no_change");
    const run = fs.readFileSync(promptsFile, "utf8");
    assert.match(run, /The harness was restarted while you/);
    assert.doesNotMatch(run, /ran out of context/);
    const [resume] = readEvents(repo).filter((e) => e.type === "resume");
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
    const runner = new LoopRunner(repo, "clean", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the retry's verdict stands in for the tick");
    assert.ok(!runner.state.lastError, `no error recorded: ${runner.state.lastError}`);
    const runs = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    assert.equal(runs.length, 2);
    assert.ok(!runs[0]!.includes("--continue"), "the first attempt was the fresh tick run");
    assert.ok(runs[1]!.includes("--continue"), "the retry continued the crashed run's session");
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
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
// into the pin scheme and re-lands it through the same review gate — invariant 1 must hold
// whether or not the pin survived (plans/merge-queue.md).
test("a failed pin leaves the commit on the branch; the next tick recovers and lands it", async () => {
  const repo = await initializedRepo();
  // Tick 1: one authoring run that makes a change. The tick ends at commit + pin, so the
  // VERDICT branch below only guards against the review prompt ever reaching this script.
  const restore1 = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("done\nSUMMARY: add hello file", { tokens: 42, output: 42, cost: 0.05 })}'`,
      `echo hello > hello.txt`,
    ].join("\n"),
  );
  const blockedRef = path.join(repo, ".git", "refs", "tumwater", "landing", "improve");
  fs.mkdirSync(blockedRef, { recursive: true });
  fs.writeFileSync(path.join(blockedRef, "blocker"), "keep the directory non-empty\n");
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
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
    const warnings = readEvents(repo).filter((e) => e.type === "warning").map((e) => String(e.message));
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

  // Unblock done (finally); tick 2's authoring run finds nothing to do, but the leftover
  // recovery re-lands the unpinned commit first — through the same gate, with the approve.
  const restore2 = fakePi(
    [
      `for a in "$@"; do case "$a" in *"VERDICT:"*) printf '%s\n' '${assistantLine("VERDICT: approve")}'; exit 0;; esac; done`,
      `printf '%s\n' '${assistantLine("TUMWATER_NOTHING_TO_DO")}'`,
    ].join("\n"),
  );
  try {
    const runner = new LoopRunner(repo, "improve", defaultConfig(), "main");
    const outcome = await runner.tick();
    assert.equal(outcome.result, "no_change", "the authoring run did nothing; the recovery did the work");
    assert.ok(fs.existsSync(path.join(repo, "hello.txt")), "the recovered commit landed on main");
    assert.match(sh(repo, "git", "log", "-1", "--format=%s"), /tumwater\(improve\): add hello file/);
    assert.equal(sh(repo, "git", "rev-list", "--count", "main..tumwater/improve").trim(), "0", "the branch is back at main");
    assert.equal(await refSha(repo, landingRefName("improve")), null, "the landed pin is deleted");
    assert.equal(queueDepth(repo), 0);
    // Like the pinned-recovery case, the landing is recorded as a merged event (what the
    // usage report counts) rather than via the tick outcome — tick 2's own authoring run
    // found nothing to do.
    const merged = readEvents(repo).filter((e) => e.type === "merged");
    assert.equal(merged.length, 1);
    // The merged summary names what landed — the recovered commit's own subject — not
    // merely that a recovery happened, so the failure digest's "Landed in the window" is
    // never opaque (BUGS.md 2026-09-21).
    assert.equal(String(merged[0]!.summary), "recovered leftover work from improve: add hello file");
  } finally {
    restore2();
  }
});
