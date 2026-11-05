import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdRole } from "../src/cli/cli-role-command.js";
import { initProject } from "../src/init/init.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { roleNotesPath } from "../src/paths.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `role -f` runs in-process with the follow's parent-death and TTY seams, driving the
// follow determinically the way cli-questions-follow.test.ts drives `questions -f`: mock
// only setInterval so each repaint and each parent-death poll is a tick, never a wall-clock
// budget the suite's concurrent load can starve.

const CLEAR = "\x1b[H\x1b[2J";

async function seedRoleRepo(name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  await sleep(50);
  return repo;
}

/** Start a follow on `repo` with `setInterval` mocked, drive it with `t.mock.timers.tick`:
 * wait (real time, generously) for the first frame to render — that is when the follow's
 * repaint and parent-death intervals exist as mock timers — then tick the 5 ms cadence
 * until `count` reads `waitForFrames` frames, flip the parent away, tick once more for the
 * death-watch to end the follow, and confirm nothing repaints once it has. */
async function runFollow(
  t: TestContext,
  repo: string,
  args: string[],
  seams: Parameters<typeof cmdRole>[2],
  waitForFrames: number,
  count: (out: string) => number,
  flipParent: () => void,
): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdRole(repo, args, seams).then(
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

test("role -f repaints the role's document until its parent exits, then prints nothing", async (t) => {
  const repo = await seedRoleRepo("role follow");
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["feature", "-f"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    2,
    (o) => (o.match(/# tumwater role: feature/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.match(out, /## Notes/);
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
});

test("role --follow repaints too (long flag spelling)", async (t) => {
  const repo = await seedRoleRepo("role follow long");
  const parent = { value: 4242 };
  const out = await runFollow(
    t,
    repo,
    ["feature", "--follow"],
    { ppid: () => parent.value, intervalMs: 5, tty: false },
    2,
    (o) => (o.match(/# tumwater role: feature/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.match(out, /# tumwater role: feature/);
});

test("role -f shows a notes change between frames in the next frame", async (t) => {
  const repo = await seedRoleRepo("role follow notes");
  const parent = { value: 4242 };
  const flipParent = (): void => {
    parent.value = 1;
  };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdRole(repo, ["feature", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    // Wait for the first frame (the note-less role on screen).
    let out = cap.out();
    for (let i = 0; i < 3000 && !out.includes("# tumwater role: feature") && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    // Write the role's notes from another process; the next repaint must carry them, and
    // the first frame must still show the note-less placeholder.
    const notes = roleNotesPath(repo, "feature");
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.writeFileSync(notes, "the marker note landed\n");
    for (let guard = 0; guard < 10_000 && !out.includes("the marker note landed"); guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
    }
    assert.ok(out.includes("the marker note landed"), "the rewritten note shows in a later frame");
    const firstFrame = out.slice(0, out.indexOf("the marker note landed"));
    assert.doesNotMatch(firstFrame, /the marker note landed/, "the frame before the write is note-less");
    assert.match(firstFrame, /## Notes/);
    flipParent();
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
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

test("role -f clears the screen only on a TTY", async (t) => {
  const repo = await seedRoleRepo("role follow tty");
  let parent = { value: 4242 };
  const ttyOut = await runFollow(
    t,
    repo,
    ["feature", "-f"],
    { ppid: () => parent.value, intervalMs: 5, tty: true },
    1,
    (o) => (o.match(/# tumwater role: feature/g) ?? []).length,
    () => (parent.value = 1),
  );
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
});

test("role -f --json is refused with no frame, no clear-screen and no JSON", async () => {
  const repo = await seedRoleRepo("role follow json");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdRole(repo, ["feature", "-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /role --json prints one document/);
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
    assert.ok(!cap.out().includes("# tumwater role:"), "no frame printed");
    assert.ok(!cap.out().includes("{"), "no JSON document printed");
  } finally {
    cap.restore();
  }
});

test("role -f refuses a write flag, names it, and performs no write", async () => {
  const repo = await seedRoleRepo("role follow write");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() =>
      cmdRole(repo, ["feature", "-f", "--notes-file", "note.md"], { ppid: () => 4242, intervalMs: 5 }),
    );
    assert.match(err, /notes writes/);
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
    assert.ok(!cap.out().includes("# tumwater role:"), "no frame printed");
    assert.ok(!fs.existsSync(roleNotesPath(repo, "feature")), "no note written");
  } finally {
    cap.restore();
  }
});

test("role -f refuses --enable naming it, and performs no write", async () => {
  const repo = await seedRoleRepo("role follow enable");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdRole(repo, ["feature", "-f", "--enable"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /enable writes/);
    assert.ok(!cap.out().includes("# tumwater role:"), "no frame printed");
  } finally {
    cap.restore();
  }
});

test("role nosuchrole -f fails with the unknown-role wording before the loop starts", async () => {
  // The unknown-role answer is a thrown Error (the CLI's main catch turns it into exit 1),
  // not a fail() — so assert the throw's wording and that no frame was painted, the same
  // wording the one-shot form's collector throws.
  const repo = await seedRoleRepo("role follow unknown");
  const cap = captureStdout();
  try {
    let thrown: unknown = null;
    try {
      await cmdRole(repo, ["nosuchrole", "-f"], { ppid: () => 4242, intervalMs: 5 });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, "an unknown id throws before the loop starts");
    assert.match((thrown as Error).message, /unknown role: nosuchrole \(valid ids: /);
    assert.ok(!cap.out().includes(CLEAR), "no clear-screen printed");
    assert.ok(!cap.out().includes("# tumwater role:"), "no frame printed");
  } finally {
    cap.restore();
  }
});
