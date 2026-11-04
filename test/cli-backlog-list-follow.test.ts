import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listAndAnnounce } from "../src/cli/backlog-cli-view.js";
import { initProject } from "../src/init/init.js";
import { makeRepo, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { loadRunnerState } from "../src/runner/runner-state-load.js";
import { saveRunnerState } from "../src/runner/runner-state.js";
import { entryKey } from "../src/backlog/backlog-parts.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { cli } from "./helpers/cli-harness.js";

// `plan|bug --list -f` runs in-process with the follow's parent-death and TTY seams, driving
// the follow deterministically the way cli-backlog-follow.test.ts drives `backlog -f`: mock
// only setInterval so each repaint and each parent-death poll is a tick, never a wall-clock
// budget the suite's concurrent load can starve.

const CLEAR = "\x1b[H\x1b[2J";

const PLANS_THREE_PARTS =
  "### Export series, part 1/3: add export (planned 2026-10-01)\n\nbody one\n\n### Export series, part 2/3: add import (planned 2026-10-02) (requires Export series 1/3 landed)\n\nbody two\n\n### Export series, part 3/3: add polish (planned 2026-10-03) (requires Export series 2/3 landed)\n\nbody three\n";
/** A ready repo whose PLANS.md ## Planned holds `plans` and BUGS.md an open bug, flushed past
 * the previous test's runner output (the list shells have no requireReadyRepo gate, but the
 * init keeps the seeding shape aligned with the other follow tests). */
async function seedRepo(plans: string, name: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, name);
  writeBacklogFile(repo, "PLANS.md", [
    { heading: "## Planned", body: plans },
    { heading: "## Done" },
  ]);
  writeBacklogFile(repo, "BUGS.md", [
    { heading: "## Open", body: "### An open bug (reported by the operator 2026-10-01)\n\nbody\n" },
    { heading: "## Fixed" },
  ]);
  await sleep(50);
  return repo;
}

/** Start a follow of `listAndAnnounce` on `repo` with `setInterval` mocked, drive it with
 * `t.mock.timers.tick`: wait (real time, generously) for the first frame to render — that is
 * when the follow's repaint and parent-death intervals exist as mock timers — then tick the
 * 5 ms cadence until `count` reads `waitForFrames` frames, flip the parent away, tick once
 * more for the death-watch to end the follow, and confirm nothing repaints once it has.
 * Returns the output captured before the parent flip, with the follow already resolved. */
async function runFollow(
  t: TestContext,
  repo: string,
  command: string,
  fileName: string,
  sectionTitle: string,
  args: string[],
  seams: Parameters<typeof listAndAnnounce>[5],
  waitForFrames: number,
  count: (out: string) => number,
  flipParent: () => void,
): Promise<string> {
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = listAndAnnounce(repo, args, command, fileName, sectionTitle, seams).then(
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

test("plan --list -f repaints the numbered list until its parent exits", async (t) => {
  const repo = await seedRepo(PLANS_THREE_PARTS, "plan list follow");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, "plan", "PLANS.md", "Planned", ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/Export series, part 1\/3/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /planned features in PLANS\.md:/);
  assert.match(out, /1\. Export series, part 1\/3/);
  // The two blocked parts compress to one line naming their positions, as the one-shot list does.
  assert.match(out, /2–3\. Export series, 2 blocked parts/);
  assert.ok(!out.includes(CLEAR), "non-TTY shape has no clear-screen");
});

test("bug --list --follow repaints the open list too (long flag spelling)", async (t) => {
  const repo = await seedRepo(PLANS_THREE_PARTS, "bug list follow");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, "bug", "BUGS.md", "Open", ["--follow"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/An open bug/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /open bugs in BUGS\.md:/);
  assert.match(out, /1\. An open bug/);
});

test("plan --list -f renumbers when an entry is removed between frames", async (t) => {
  const repo = await seedRepo(
    "### Alpha (planned 2026-10-01)\n\nBody.\n\n### Beta (planned 2026-10-02)\n\nBody.\n",
    "plan list follow removed",
  );
  const parent = { value: 4242 };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = listAndAnnounce(repo, ["-f"], "plan", "PLANS.md", "Planned", { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    let out = cap.out();
    for (let i = 0; i < 3000 && !out.includes("Beta") && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.match(out, /1\. Alpha/, "first frame shows position 1");
    assert.match(out, /2\. Beta/, "first frame shows position 2");
    // Remove Alpha; only the frames painted after the write are checked — the capture accumulates.
    const before = cap.out();
    fs.writeFileSync(path.join(repo, "PLANS.md"), `# Plans\n\n## Planned\n\n### Beta (planned 2026-10-02)\n\nBody.\n\n## Done\n\n_None yet._\n`);
    await sleep(50);
    let after = "";
    for (let guard = 0; guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      after = cap.out().slice(before.length);
      if (after.includes("1. Beta")) break;
    }
    assert.match(after, /1\. Beta/, "the survivor renumbers to position 1");
    assert.doesNotMatch(after, /Alpha/, "the removed entry is gone");
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done);
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

test("plan --list --done -f repaints the finished list until its parent exits", async (t) => {
  const repo = await seedRepo("### Still planned (planned 2026-10-01)\n\nbody\n", "plan list done follow");
  fs.writeFileSync(
    path.join(repo, "PLANS.md"),
    `# Plans\n\n## Planned\n\n### Still planned (planned 2026-10-01)\n\nbody\n\n## Done\n\n### Done one (done 2026-10-01)\n\n### Done two (done 2026-10-02)\n`,
  );
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, "plan", "PLANS.md", "Planned", ["--done", "-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/Done one/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /done plans in PLANS\.md, newest first:/);
  assert.match(out, /1\. Done one \(done 2026-10-01\)/);
  assert.match(out, /2\. Done two \(done 2026-10-02\)/);
});

test("plan --list -f shows the working-on-it mark for a claim made between frames", async (t) => {
  const repo = await seedRepo("### Alpha (planned 2026-10-01)\n\nBody.\n", "plan list follow claim");
  // Claim the entry before the first frame so frame 1 is unmarked and a later frame — after the
  // state write is picked up by the per-frame re-read — carries the mark.
  const parent = { value: 4242 };
  const cap = captureStdout();
  let done = false;
  let failure: unknown = null;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const promise = listAndAnnounce(repo, ["-f"], "plan", "PLANS.md", "Planned", { ppid: () => parent.value, intervalMs: 5, tty: false }).then(
    () => (done = true),
    (err: unknown) => {
      failure = err;
      done = true;
    },
  );
  try {
    let out = cap.out();
    for (let i = 0; i < 3000 && !out.includes("Alpha") && !done; i++) {
      await sleep(10);
      out = cap.out();
    }
    assert.match(out, /1\. Alpha/, "the entry prints before the claim lands");
    saveRunnerState(repo, {
      ...loadRunnerState(repo, "feature-2"),
      claim: { file: "PLANS.md", key: entryKey("Alpha"), title: "Alpha", at: 1, source: "assigned" },
    });
    await sleep(50);
    for (let guard = 0; guard < 10_000; guard++) {
      t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
      out = cap.out();
      if (out.includes("[working on it: feature #2]")) break;
    }
    assert.match(out, /\[working on it: feature #2\]/, "the claim's mark appears in a later frame");
    parent.value = 1;
    t.mock.timers.tick(5); // retired-name-ok: node:test mock clock
    await promise;
    assert.ok(done);
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

test("plan --list --grep -f treats -f as the literal grep pattern, one snapshot then exit", async () => {
  const repo = await seedRepo("### Dash-f plan (planned 2026-10-01)\n\nThe -f flag lives in this body.\n", "plan list grep dash-f");
  // The pattern "-f" must be read as the grep text, not the follow flag: one snapshot frame
  // and exit-0, no repaint (cli() bounds the run at 60 s, so a follow here would time out).
  const r = await cli(repo, "plan", "--list", "--grep", "-f");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Dash-f plan/);
  assert.equal((r.stdout.match(/Dash-f plan/g) ?? []).length, 1, "one snapshot frame, then it exited");
});

test("plan --list -f --grep composes the follow with the pattern", async (t) => {
  const repo = await seedRepo("### Zebra plan (planned 2026-10-01)\n\nFeed the zebra.\n\n### Other plan (planned 2026-10-02)\n\nOther body.\n", "plan list follow grep");
  const parent = { value: 4242 };
  const out = await runFollow(t, repo, "plan", "PLANS.md", "Planned", ["-f", "--grep", "Zebra"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 2, (o) => (o.match(/Zebra plan/g) ?? []).length, () => (parent.value = 1));
  assert.match(out, /Zebra plan/);
  assert.doesNotMatch(out, /Other plan/, "a --grep follow keeps only matching entries");
});

test("plan --list -f --json is refused before anything prints", async () => {
  const repo = await seedRepo("### Alpha (planned 2026-10-01)\n\nBody.\n", "plan list follow json");
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => listAndAnnounce(repo, ["-f", "--json"], "plan", "PLANS.md", "Planned", { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /plan --list --json prints one document; -f\/--follow repaints a live view — drop one of them/);
    assert.equal(cap.out(), "", "no frame, no clear-screen, no JSON document printed");
  } finally {
    cap.restore();
  }
});

test("bug --list -f --json is refused with the bug's name", async () => {
  const repo = await seedRepo("### Alpha (planned 2026-10-01)\n\nBody.\n", "bug list follow json");
  const err = await expectFailAsync(() => listAndAnnounce(repo, ["--follow", "--json"], "bug", "BUGS.md", "Open", { ppid: () => 4242, intervalMs: 5 }));
  assert.match(err, /bug --list --json prints one document/);
});

test("plan --list refuses a repeated follow flag with the shared wording", async () => {
  const repo = await seedRepo("### Alpha (planned 2026-10-01)\n\nBody.\n", "plan list repeat follow");
  const r = await cli(repo, "plan", "--list", "-f", "--follow");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /-f\/--follow may only be given once/);
});

test("plan --list -f clears the screen only on a TTY", async (t) => {
  const repo = await seedRepo("### Alpha (planned 2026-10-01)\n\nBody.\n", "plan list follow tty");
  let parent = { value: 4242 };
  const ttyOut = await runFollow(t, repo, "plan", "PLANS.md", "Planned", ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: true }, 1, (o) => (o.match(/Alpha/g) ?? []).length, () => (parent.value = 1));
  assert.ok(ttyOut.startsWith(CLEAR), "TTY follow starts with a clear-screen");
  parent = { value: 4242 };
  const pipedOut = await runFollow(t, repo, "plan", "PLANS.md", "Planned", ["-f"], { ppid: () => parent.value, intervalMs: 5, tty: false }, 1, (o) => (o.match(/Alpha/g) ?? []).length, () => (parent.value = 1));
  assert.ok(!pipedOut.includes(CLEAR), "non-TTY follow never clears the screen");
});
