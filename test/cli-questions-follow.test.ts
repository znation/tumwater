import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdQuestions } from "../src/cli/cli-question-commands.js";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { cli } from "./helpers/cli-harness.js";

// `questions -f` runs in-process with the follow's parent-death and TTY seams, driving the
// follow deterministically the way cli-backlog-follow.test.ts drives `backlog -f`: mock only
// setInterval so each repaint and each parent-death poll is a tick, never a wall-clock budget
// the suite's concurrent load can starve.

const CLEAR = "\x1b[H\x1b[2J";

const OPEN_ONE = "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n## Answered\n\n_None._\n";
const ANSWERED_ONE =
  "# q\n\n## Open\n\n_None._\n\n## Answered\n\n### Cap the spend?\n\n**Answered 2026-01-01 by the user:** no\n";

async function seedQuestionsRepo(markdown: string, name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  fs.writeFileSync(path.join(repo, "QUESTIONS.md"), markdown);
  await sleep(50);
  return repo;
}

/** Start a follow on `repo` with `setInterval` mocked, drive it with `t.mock.timers.tick`:
 * wait (real time, generously) for the first frame to render — that is when the follow's
 * repaint and parent-death intervals exist as mock timers — then tick the 5 ms cadence until
 * `count` reads `waitForFrames` frames, flip the parent away, tick once more for the
 * death-watch to end the follow, and confirm nothing repaints once it has. */
async function runFollow(
  t: TestContext,
  repo: string,
  args: string[],
  seams: Parameters<typeof cmdQuestions>[2],
  waitForFrames: number,
  count: (out: string) => number,
  flipParent: () => void,
): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdQuestions(repo, args, seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
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

test("questions -f repaints the open list until its parent exits, then prints nothing", async (t) => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow open");
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["-f"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    2,
    (o) => (o.match(/Cap the spend\?/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.match(out, /Cap the spend\?/);
  assert.match(out, /1\. Cap the spend\?/);
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
});

test("questions --follow repaints the open list too (long flag spelling)", async (t) => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow long");
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["--follow"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    2,
    (o) => (o.match(/Cap the spend\?/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.match(out, /Cap the spend\?/);
});

test("questions -f shows a question answered by another process in the next frame", async (t) => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow answered away");
  const parent = { value: 4242 };
  const flipParent = (): void => {
    parent.value = 1;
  };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdQuestions(repo, ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    // Wait for the first frame (the open question on screen).
    let out = cap.out();
    for (let i = 0; i < 3000 && !out.includes("Cap the spend?") && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    // Answer the question from another process; the next repaint must leave it.
    fs.writeFileSync(path.join(repo, "QUESTIONS.md"), ANSWERED_ONE);
    let frames = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
      if (out.includes("no open questions")) {
        frames++;
        break;
      }
    }
    assert.equal(frames, 1, "the answered question leaves the next frame");
    assert.match(out, /no open questions/);
    // Finish the follow deterministically.
    flipParent();
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done);
    if (failure !== null) throw failure;
  } finally {
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
});

test("questions --answered -f repaints the answered list until its parent exits", async (t) => {
  const repo = await seedQuestionsRepo(ANSWERED_ONE, "questions follow answered");
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["--answered", "-f"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    2,
    (o) => (o.match(/Cap the spend\?/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.match(out, /answered questions in QUESTIONS\.md, newest first:/);
  assert.match(out, /Cap the spend\?/);
});

test("questions -f --grep keeps only matching questions, under their unfiltered numbering", async (t) => {
  const repo = await seedQuestionsRepo(
    "# q\n\n## Open\n\n### Cap the spend?\n\nbody\n\n### Ship the zebra?\n\nother\n\n## Answered\n\n_None._\n",
    "questions follow grep",
  );
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["-f", "--grep", "zebra"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    2,
    (o) => (o.match(/Ship the zebra\?/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.match(out, /2\. Ship the zebra\?/, "the kept question keeps its unfiltered position");
  assert.doesNotMatch(out, /Cap the spend\?/, "a --grep follow keeps only matching questions");
});

test("questions -f clears the screen only on a TTY", async (t) => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow tty");
  let parent = { value: 4242 };
  const ttyOut = await runFollow(
    t,
    repo,
    ["-f"],
    { ppid: () => parent.value, intervalMs: 5, tty: true },
    1,
    (o) => (o.match(/Cap the spend\?/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
});

test("questions -f --json is refused with no frame, no clear-screen and no JSON", async () => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow json");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdQuestions(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /questions --json prints one document/);
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
    assert.ok(!cap.out().includes("Cap the spend?"), "no frame printed");
    assert.ok(!cap.out().includes("questions"), "no JSON document printed");
  } finally {
    cap.restore();
  }
});

test("questions -f --show is refused with no frame", async () => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow show");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdQuestions(repo, ["-f", "--show", "1"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /--show prints one question in full/);
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
  } finally {
    cap.restore();
  }
});

test("questions answer 1 -f keeps the follow token as decision text", async () => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow answer prose");
  // The answer form's decision is free-form prose, so `-f` past the question's number is a
  // decision word, not the follow flag — the same position rule the `--json` decision token
  // follows: a follow that fired here would hang the spawned CLI past its timeout.
  const r = await cli(repo, "questions", "answer", "1", "-f", "spend");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /answered question 1/);
  const md = fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8");
  assert.match(md, /\*\*Answered .* by the user:\*\* -f spend/);
});

test("questions -f answer is refused: the answer form writes one change", async () => {
  const repo = await seedQuestionsRepo(OPEN_ONE, "questions follow answer refused");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdQuestions(repo, ["-f", "answer", "1", "no"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /questions answer writes one change/);
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
    // The refusal happened before any write: the question is still open.
    assert.match(fs.readFileSync(path.join(repo, "QUESTIONS.md"), "utf8"), /## Open\n\n### Cap the spend\?/);
  } finally {
    cap.restore();
  }
});

test("questions --grep -f does not enter follow mode over its own pattern", async () => {
  const repo = await seedQuestionsRepo(
    "# q\n\n## Open\n\n### The -f flag?\n\nThe -f token lives in this heading.\n\n## Answered\n\n_None._\n",
    "questions grep dash-f pattern",
  );
  // The pattern "-f" used to be read as the follow flag itself: the command would hang
  // following the list instead of printing the one matched frame. cli() bounds the run, so
  // an exit-0 with the single snapshot line IS the assertion — pre-fix this test times out.
  const r = await cli(repo, "questions", "--grep", "-f");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /The -f flag\?/);
  assert.equal((r.stdout.match(/The -f flag\?/g) ?? []).length, 1, "one snapshot frame, then it exited");
});
