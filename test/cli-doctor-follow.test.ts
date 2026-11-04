import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cmdDoctor } from "../src/cli/cli-doctor-command.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { diskHermeticRepo, hermeticHostBins } from "./fixtures/doctor-fixtures.js";
import { pathPrepend } from "./fakes/fake-commands.js";
import { attemptAsync, captureStdout } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { cli, spawnCli, exitCode } from "./helpers/cli-harness.js";

// `doctor -f` runs in-process with the follow's parent-death and TTY seams, driving the
// follow deterministically the way status-follow.test.ts drives `status -f`: mock only
// setInterval so each repaint and each parent-death poll is a tick, never a wall-clock
// budget the suite's concurrent load can starve. One in-process frame runs the doctor's
// own checks (which spawn ps and lsof on this host), so the capture window is the
// accepted scope-limit exception: every other frame spawn is bounded, and a lost runner
// line would surface as a test count that no assertion explains.

const CLEAR = "\x1b[H\x1b[2J";

/** The frame's header is one stable line per repaint (doctor has no readiness gate, so the
 * first frame renders as soon as runDoctor's first check resolves — a handful of spawns). */
// Non-anchored: on a TTY every frame is prefixed by the clear-screen escape, so an anchored
// ^ would never see the second-or-later frames.
const frames = (out: string) => (out.match(/tumwater doctor — /g) ?? []).length;

/** Doctor follow frames are async (the checks spawn ps), so a death tick that ends the
 * follow can still have one slow frame in flight; its paint lands in real time and, unwaited,
 * bleeds past the test's restore() into the next test's stdout capture. Wait until the captured
 * output stops changing for three beats, so that in-flight frame lands in this test's capture
 * instead of the next one's. A landed frame is this follow's own, so returning it is safe. */
async function drainInFlight(capture: () => string): Promise<void> {
  let prev = capture();
  let stable = 0;
  // A doctor frame re-runs the checks, which spawn ps, so an in-flight frame can land up to a
  // couple of seconds after the death tick. Require three stable beats (not two) so a slow
  // frame landing between beats is caught, and give the guard a long bound so a slow frame
  // is never abandoned mid-paint.
  for (let guard = 0; stable < 3 && guard < 700; guard++) {
    await sleep(150);
    const cur = capture();
    if (cur === prev) stable += 1;
    else {
      stable = 0;
      prev = cur;
    }
  }
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
  seams: Parameters<typeof cmdDoctor>[2],
  waitForFrames: number,
  flipParent: () => void,
): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  // The follow's promise is driven by mock ticks, so it is awaited only after the death-watch
  // tick resolves it; the rejection branch records a real follow failure (surfaced below)
  // while still setting `done`, so the waits terminate and no rejection goes unhandled.
  const promise = cmdDoctor(repo, args, seams).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    let out = cap.out();
    for (let i = 0; i < 6000 && frames(out) < 1 && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.ok(frames(out) >= 1, "first frame rendered");
    // A doctor frame is async (the checks spawn ps), so its read resolves in real time: the
    // tick that fires it and the paint it lands on are separated by a short real sleep, and
    // the guard bounds that wait so a wedged frame fails the test instead of hanging it.
    for (let guard = 0; frames(out) < waitForFrames && guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      await sleep(5);
      out = cap.out();
    }
    assert.ok(frames(out) >= waitForFrames, `got ${frames(out)} of ${waitForFrames} frames`);
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
    // The death tick can also start one slow repaint frame (doctor frames spawn ps); drain it
    // into this capture before restore(), so it does not bleed into the next test's stdout.
    await drainInFlight(cap.out);
    return cap.out();
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

/** A duplicated `## Planned` heading in PLANS.md is a warn on the `backlog headings` row —
 * the warn/ok flip the repaint test drives. A duplicated `## Open` heading in BUGS.md is a
 * second warn, so the `--problems` frame keeps more than one shown row. */
function seedDuplicateHeadings(repo: string): void {
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# plans\n\n## Planned\n\n### first\n\nbody\n\n## Planned\n\n### dup\n\ndup\n\n");
  fs.writeFileSync(path.join(repo, "BUGS.md"), "# bugs\n\n## Open\n\n### open bug\n\nbody\n\n## Open\n\n### dup\n\ndup\n\n");
}

/** Drop the duplicated heading from both backlog files — the next frame must reread them
 * past the check's stat cache (dev/ino/mtime/size all change on the rewrite) and show the
 * row back at ok. */
function repairDuplicateHeadings(repo: string): void {
  fs.writeFileSync(path.join(repo, "PLANS.md"), "# plans\n\n## Planned\n\n### first\n\nbody\n\n");
  fs.writeFileSync(path.join(repo, "BUGS.md"), "# bugs\n\n## Open\n\n### open bug\n\nbody\n\n");
}

test("doctor -f shows a check's row change between ticks", async (t) => {
  const repo = makeRepo();
  seedDuplicateHeadings(repo);
  await sleep(50);
  const parent = { value: 4242 };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  // Name the `backlog headings` check so the follow runs only that fast file-scan check —
  // a full 70-check frame on a loaded box is slow enough that its in-flight paint would
  // bleed into the next test's stdout capture.
  const promise = cmdDoctor(repo, ["backlog headings", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    // Wait (real time) for the first frame — that is when the repaint interval is armed.
    for (let i = 0; i < 3000 && frames(cap.out()) < 1 && !done; i++) await sleep(10);
    const first = cap.out();
    assert.match(first, /^warn\s+backlog headings/m, "the first frame carries the duplicate-heading warn");
    // Repair the duplicate between frames. The repaint's frame read is async (the checks
    // spawn ps), so the tick that fires it resolves in real time: wait for the newest frame
    // to show the repaired row. A stat cache serving the pre-repair read would keep it warn.
    repairDuplicateHeadings(repo);
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    let second = "";
    for (let i = 0; i < 3000 && !/^ok\s+backlog headings/m.test(second); i++) {
      await sleep(10);
      second = cap.out().split(/tumwater doctor — /).pop() as string;
    }
    assert.match(second, /^ok\s+backlog headings/m, "the repainted frame shows the repaired row as ok");
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
    await drainInFlight(cap.out);
    t.mock.timers.reset();
    cap.restore();
  }
});

test("doctor -f composes with a check name", async (t) => {
  // The `brief` check is the named-composition row: a makeRepo tree has no brief file, so it
  // is a stable warn, and a named follow must run only it — no `git binary` row in any frame.
  const repo = makeRepo();
  await sleep(50);
  const parent = { value: 4242 };
  const named = await runFollow(t, repo, ["brief", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, () => (parent.value = 1));
  assert.match(named, /^warn\s+brief/m);
  assert.doesNotMatch(named, /\bgit binary\b/, "the named-check follow runs only that check");
});

test("doctor -f composes with --problems", async (t) => {
  // Name the fast, ok `node` check: --problems hides its single ok row in every frame (the
  // hidden count shows, no ok row does) — without running the slow full report whose in-flight
  // frame would bleed into the next test's stdout on a loaded box.
  const repo = makeRepo();
  await sleep(50);
  const parent = { value: 4242 };
  const problems = await runFollow(t, repo, ["node", "--problems", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, () => (parent.value = 1));
  assert.match(problems, /1 ok check hidden/, "--problems counts the hidden ok row");
  assert.doesNotMatch(problems, /^ok\s+node/m, "--problems hides the ok row in every frame");
});

test("doctor -f clears the screen only on a TTY", async (t) => {
  // A single fast check keeps the frame quick so its in-flight paint cannot bleed into the
  // next test's stdout; the clear-screen behavior is independent of how many checks run.
  const repo = makeRepo();
  await sleep(50);
  const parent = { value: 4242 };
  const ttyOut = await runFollow(t, repo, ["brief", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: true }, 1, () => (parent.value = 1));
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
});

test("doctor -f ends by parent death leaving the exit code untouched", async (t) => {
  // A single fast check keeps the frame quick, so its in-flight paint cannot bleed into the
  // next test's stdout; the exit-code contract is independent of how many checks run. Name
  // `init`, which fails on a bare makeRepo tree (no tumwater.json), so this pins the contract
  // the acceptance names: a failing last frame still leaves the exit code untouched.
  const repo = makeRepo();
  await sleep(50);
  const parent = { value: 4242 };
  const cap = captureStdout();
  const exitCodeBefore = process.exitCode;
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = cmdDoctor(repo, ["init", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    for (let i = 0; i < 3000 && frames(cap.out()) < 1 && !done; i++) await sleep(10);
    assert.ok(frames(cap.out()) >= 1, "first frame rendered");
    assert.match(cap.out(), /^fail\s+init/m, "the last frame shows a failing check");
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done, "follow resolves once the parent is gone");
    if (failure !== null) throw failure;
    assert.equal(process.exitCode, exitCodeBefore, "the follow end leaves process.exitCode untouched");
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

test("doctor -f --json is refused before any frame", async () => {
  const repo = makeRepo();
  await sleep(50);
  // Inspect the outcome's own stdout: attemptAsync stubs process.stdout.write for the call, so
  // a separate captureStdout around it would stay empty even if the command painted a frame.
  const out = await attemptAsync(() => cmdDoctor(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
  if (!out.exited) assert.fail("expected the --json conflict to fail the command");
  assert.equal(out.code, 1);
  assert.match(out.stderr, /doctor --json prints one document/);
  assert.equal(out.stdout, "", "no frame printed");
  assert.ok(!out.stdout.includes(CLEAR), "no clear-screen printed");
});

test("doctor -f with a repair flag is refused naming the flag, before any side effect or frame", async () => {
  const repo = makeRepo();
  await sleep(50);
  for (const flag of ["--kill-orphans", "--commit-backlog", "--resync-install", "--drop-broken-pins", "--retire-leftovers"]) {
    // The outcome's own stdout, not an outer captureStdout (attemptAsync replaces the stream):
    // an outer capture would be empty even when a frame painted before the refusal.
    const out = await attemptAsync(() => cmdDoctor(repo, ["-f", flag], { ppid: () => 4242, intervalMs: 5 }));
    if (!out.exited) assert.fail(`expected ${flag} to fail the command`);
    assert.equal(out.code, 1);
    assert.match(out.stderr, new RegExp(`${flag} repairs`), `${flag} is named in the refusal`);
    assert.match(out.stderr, /read-only/);
    assert.equal(out.stdout, "", "no frame printed for any refused shape");
    assert.ok(!out.stdout.includes(CLEAR), "no clear-screen printed");
  }
});

test("doctor --verbose is still refused as an unknown argument beside the follow flag", async () => {
  const repo = makeRepo();
  const r = await cli(repo, "doctor", "--verbose");
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /unknown argument: --verbose/);
});

test("doctor one-shot is unchanged: exit 0 on the hermetic tree, and the help row names the follow", async () => {
  const repo = await diskHermeticRepo("cli doctor follow one-shot");
  // The hermetic PATH doctor.test.ts's plain-render wiring test uses: a fake `pi` and an
  // empty fake `ps` table, so the binary and orphan rows pass on any host and the exit-0
  // contract is a property of the fixture, not of the machine.
  const psRan = path.join(tmpdir("doctor-follow-ps-"), "ran");
  const restore = pathPrepend(hermeticHostBins(psRan));
  try {
    const r = await cli(repo, "doctor");
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  } finally {
    restore();
  }
  const help = await cli(repo, "doctor", "--help");
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /tumwater doctor \[<check>\.\.\.\] \[-f\/--follow\]/);
});

test("doctor -f as a CLI child repaints at the real cadence and ends with its parent", async () => {
  // The end-to-end shape the in-process frames cannot see: a spawned follow paints on the
  // real 2 s interval (two frames need ~4 s even unloaded; the 30 s deadline is the
  // cli-diff-follow waitForFollow's), and a killed child's exit code is 0 — the parent-death
  // end, not the one-shot's fail exit, even though a bare tree carries failing rows.
  const repo = makeRepo();
  const s = spawnCli(repo, ["doctor", "-f"]);
  try {
    await s.waitFor((o) => (o.match(/^tumwater doctor — /gm) ?? []).length >= 2, "the report to repaint twice", 30_000);
    assert.ok(!s.out().includes(CLEAR), "a piped follow separates frames with a blank line, never a clear-screen");
    // kill() signals the group after a SIGTERM grace: the exit is a clean 0 (the parent-death
    // end) or a signal death (null) — either way NOT the one-shot's fail exit, which a bare
    // tree with failing rows would take without a follow.
    s.kill();
    const code = await exitCode(s.child, 20_000);
    assert.ok(code === 0 || code === null, `the follow ends with its parent's death, not a fail exit (got ${String(code)})`);
  } finally {
    s.kill();
  }
});
