import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cmdPrompt } from "../src/inbox/prompt-commands.js";
import { initProject } from "../src/init/init.js";
import { dequeuePrompt, inboxSize } from "../src/inbox/inbox.js";
import { submitPrompt, submitRolePrompt } from "../src/inbox/inbox-submit.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { cli } from "./helpers/cli-harness.js";

// `prompt --list -f` runs in-process with the follow's parent-death and TTY seams, driving
// the follow deterministically the way cli-backlog-follow.test.ts drives `backlog -f`: mock
// only setInterval so each repaint and each parent-death poll is a tick, never a wall-clock
// budget the suite's concurrent load can starve.

const CLEAR = "\x1b[H\x1b[2J";

/** A repo with one queued prompt per role section, flushed past the previous test's runner
 * output (the init keeps the seeding shape aligned with the other follow tests). */
async function seedPromptRepo(name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  submitPrompt(repo, "director task");
  submitRolePrompt(repo, "qa", "qa one");
  submitRolePrompt(repo, "qa", "qa two");
  submitRolePrompt(repo, "readme", "docs task");
  await sleep(50);
  return repo;
}

/** Start a follow on `repo` with `setInterval` mocked, drive it with `t.mock.timers.tick`:
 * wait (real time, generously) for the first frame to render — that is when the follow's
 * repaint and parent-death intervals exist as mock timers — then tick the 5 ms cadence until
 * `waitForFrames` frames have painted, flip the parent away, tick once more for the
 * death-watch to end the follow, and confirm nothing repaints once it has. Returns the
 * output captured before the parent flip, with the follow already resolved. */
async function runFollow(
  t: TestContext,
  repo: string,
  args: string[],
  seams: Parameters<typeof cmdPrompt>[2],
  waitForFrames: number,
  count: (out: string) => number,
  flipParent: () => void,
): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  // The follow's promise is driven by mock ticks, so it is awaited only after the death-watch
  // tick resolves it; the rejection branch records a real follow failure (surfaced below)
  // while still setting `done`, so the waits terminate and no rejection goes unhandled.
  const promise = cmdPrompt(repo, args, seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    }
  );
  try {
    let out = cap.out();
    for (let i = 0; i < 3000 && count(out) < 1 && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.ok(count(out) >= 1, "first frame rendered");
    for (let guard = 0; count(out) < waitForFrames && guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
    }
    assert.ok(count(out) >= waitForFrames, `got ${count(out)} of ${waitForFrames} frames`);
    const repainted = out;
    flipParent();
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
    // Nothing is repainted once the follow ended: both intervals were cleared on resolve, so
    // advancing the mock clock far cannot change the captured output.
    const settled = cap.out();
    t.mock.timers.tick(60_000); // retired-name-ok: node:test mock clock
    assert.equal(cap.out(), settled, "nothing printed after the follow ended");
    return repainted;
  } finally {
    // Flip and await even when an assertion above throws, so a failure never leaves the
    // follow's interval or watch running into real stdout or keeping the test process alive.
    flipParent();
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    try {
      await promise;
    } catch {
      // Rejection already recorded above.
    }
    t.mock.timers.reset();
    cap.restore();
  }
}

test("prompt --list -f repaints the grouped queue until its parent exits, then prints nothing", async (t) => {
  const repo = await seedPromptRepo("prompt list follow");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, ["--list", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/director task/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /director task/);
  assert.match(out, /qa:/);
  assert.match(out, /docs task/);
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
});

test("prompt --list -f shows a prompt enqueued or dequeued between ticks, renumbered", async (t) => {
  const repo = await seedPromptRepo("prompt list follow renumber");
  const parent = { value: 4242 };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdPrompt(repo, ["--list", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    }
  );
  try {
    // Wait (real time) for the first frame — that is when the repaint interval is armed.
    for (let i = 0; i < 3000 && !cap.out().includes("qa one") && !done; i++) await sleep(10);
    const first = cap.out();
    assert.ok(first.includes("director task"), "the first frame shows the pre-mutation queue");
    // Between the first frame and the next tick: a new prompt is enqueued and the director's
    // first is dequeued. The next frame must show the enqueue and be missing the dequeue —
    // numbered as a fresh --list would number them.
    submitPrompt(repo, "late task");
    assert.equal(dequeuePrompt(repo), "director task", "the dequeued prompt is the first one");
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    const second = cap.out().split(/\n\n/).filter(Boolean).pop() as string;
    assert.ok(second.includes("late task"), "the repainted frame carries the enqueue");
    assert.ok(!second.includes("director task"), "the dequeued prompt is gone from the repainted frame");
    assert.match(second, /^1\. late task/m, "the survivor renumbers as a fresh list would");
    // Flip the parent away; the death-watch poll (same 5 ms cadence) fires on the next tick.
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
  } finally {
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    try {
      await promise;
    } catch {
      // Rejection already recorded above.
    }
    t.mock.timers.reset();
    cap.restore();
  }
});

test("prompt --list -f composes with --role and --grep", async (t) => {
  const repo = await seedPromptRepo("prompt list follow filters");
  const parent = { value: 4242 };
  const roleOut = await runFollow(t, repo, ["--list", "-f", "--role", "qa"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/qa one/g) ?? []).length, () => (parent.value = 1));
  assert.match(roleOut, /qa:/);
  assert.match(roleOut, /^1\. qa one/m);
  assert.match(roleOut, /^2\. qa two/m);
  assert.ok(!roleOut.includes("director task") && !roleOut.includes("docs task"), "--role keeps only the listed role's section");

  const parent2 = { value: 4242 };
  const grepOut = await runFollow(t, repo, ["--list", "-f", "--grep", "task"], { ppid: () => parent2.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/director task/g) ?? []).length, () => (parent2.value = 1));
  assert.match(grepOut, /director task/);
  assert.match(grepOut, /docs task/);
  assert.ok(!grepOut.includes("qa one"), "--grep keeps only the matching rows, under their unfiltered numbers");
});

test("prompt --list -f clears the screen only on a TTY", async (t) => {
  const repo = await seedPromptRepo("prompt list follow tty");
  const parent = { value: 4242 };
  const ttyOut = await runFollow(t, repo, ["--list", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: true }, 1, (o) => (o.match(/director task/g) ?? []).length, () => (parent.value = 1));
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
});

test("prompt --list -f --json is refused before any frame", async () => {
  const repo = await seedPromptRepo("prompt list follow json");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdPrompt(repo, ["--list", "-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /prompt --json prints one document/);
    assert.ok(!cap.out().includes("director task"), "no frame printed");
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
    assert.ok(!cap.out().includes("{"), "no JSON document printed");
  } finally {
    cap.restore();
  }
});

test("prompt --list --grep -f treats -f as the literal pattern, one snapshot, then it exits", async () => {
  const repo = makeRepo();
  await initProject(repo, "prompt list grep dash-f");
  submitPrompt(repo, "the -f flag in the prompt");
  // The pattern "-f" is the grep's value token, not the follow flag: the command prints one
  // snapshot and exits. cli() bounds the run at 60 s, so a plain exit-0 with one matched
  // frame IS the assertion — a follow would never exit on its own.
  const r = await cli(repo, "prompt", "--list", "--grep", "-f");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /the -f flag in the prompt/);
  assert.equal((r.stdout.match(/the -f flag in the prompt/g) ?? []).length, 1, "one snapshot frame, then it exited");
});

test("prompt --list --grep --follow treats --follow as the literal pattern, one snapshot, then it exits", async () => {
  const repo = makeRepo();
  await initProject(repo, "prompt list grep follow spelling");
  submitPrompt(repo, "the --follow flag as text");
  // The pattern "--follow" is the grep's value token, not the follow flag: the command prints
  // one snapshot and exits. cli() bounds the run at 60 s, so a plain exit-0 with one matched
  // frame IS the assertion — a follow would never exit on its own.
  const r = await cli(repo, "prompt", "--list", "--grep", "--follow");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /the --follow flag as text/);
  assert.equal((r.stdout.match(/the --follow flag as text/g) ?? []).length, 1, "one snapshot frame, then it exited");
});

test("prompt --list --follow --grep --follow follows with the literal second --follow as pattern", async (t) => {
  const repo = await seedPromptRepo("prompt list follow grep follow spelling");
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["--list", "--follow", "--grep", "--follow"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    3,
    (o) => (o.match(/no queued prompt matches "--follow"/g) ?? []).length,
    () => (parent.value = 1),
  );
  // The first --follow is the real follow flag (the live view repaints every tick); the second
  // --follow is grep's literal pattern — no seeded prompt contains it, so every frame prints
  // the no-match line, and three frames mean it followed rather than exiting after one snapshot.
  assert.match(out, /no queued prompt matches "--follow"/);
});

test("prompt -f enqueues -f as prompt content; prompt --follow without --list is refused", async () => {
  const repo = makeRepo();
  await initProject(repo, "prompt follow single dash");

  // The free-form rule: a single-dash token is content, so -f rides into the queued text.
  const r = await cli(repo, "prompt", "-f", "follow me");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /added to the director's inbox/);
  assert.equal(dequeuePrompt(repo), "-f follow me");

  // The long form outside --list names the missing --list instead of queuing text.
  const bad = await cli(repo, "prompt", "--follow", "text");
  assert.equal(bad.code, 1, bad.stdout);
  assert.match(bad.stderr, /--follow only applies to --list/);
  assert.equal(inboxSize(repo), 0, "nothing was queued by the refusal");
});

test("prompt --list without a follow flag prints exactly the one-shot list", async () => {
  const repo = await seedPromptRepo("prompt list one shot");
  const r = await cli(repo, "prompt", "--list");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^director:/m);
  assert.match(r.stdout, /^1\. director task \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^qa:/m);
  assert.match(r.stdout, /^1\. qa one \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^2\. qa two \(queued \d+[smh] ago\)$/m);
  assert.match(r.stdout, /^readme:/m);
  assert.match(r.stdout, /^1\. docs task \(queued \d+[smh] ago\)$/m);
});
