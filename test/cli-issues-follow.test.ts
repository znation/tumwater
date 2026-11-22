import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cmdIssues } from "../src/cli/cli-query-commands.js";
import { initProject } from "../src/init/init.js";
import { githubIssuesPath } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync, expectOkAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";
import { writeScript } from "./fakes/fake-commands.js";
import { CLI, cliWithEnv } from "./helpers/cli-harness.js";

// `issues -f` runs in-process with the follow's repaint-interval and parent-death seams, the way
// test/cli-quarantine-follow.test.ts drives `quarantine -f` — a real interval (so the repaint
// loop's frame paint is exercised) and a fake parent whose death resolves the follow. The ledger
// is written with writeFileDeep at the path src/github/github-issues-state.ts reads, so no test
// here shells out to `gh` or calls the scan (plans/github-issues.md invariant 2).

const CLEAR = "\x1b[H\x1b[2J";

/** One ledger row, the shape `readGithubIssues` declares. `updatedAt` is set relative to now so
 * the row's own age sits in the seconds bucket, where it visibly advances between frames. */
function issueRow(number: number, title: string): unknown {
  return {
    number,
    title,
    url: `https://github.com/znation/proj/issues/${number}`,
    author: "outsider",
    trusted: false,
    mirrored: false,
    labels: [],
    updatedAt: new Date(Date.now() - 40_000).toISOString(),
    authorAssociation: "NONE",
  };
}

/** A ledger scanned `ageMs` ago holding `open`, written the way a scan writes it. */
function writeLedger(repo: string, open: unknown[], ageMs = 40_000): void {
  writeFileDeep(
    githubIssuesPath(repo),
    JSON.stringify({
      repo: "znation/proj",
      branch: "main",
      checkedAt: Date.now() - ageMs,
      gh: "ok",
      open,
    }),
  );
}

/** Collapse the two age phrases a frame renders from that frame's clock, so a frame and the
 * one-shot list for the same ledger can be compared for everything else exactly. */
function maskAges(text: string): string {
  return text.replace(/checked \d+[smhd] ago/g, "checked AGO").replace(/updated \d+[smhd] ago/g, "updated AGO");
}

/** Drive `issues -f` in-process until `drive` (which gets the capture, a `done()` poll and a
 * `stop()` that flips the seam's parent to PID 1) returns. `stop()` runs even if `drive` throws,
 * so a failing branch never leaves the follow repainting into real stdout. */
async function withIssuesFollow(
  seed: (repo: string) => void,
  args: string[],
  intervalMs: number,
  tty: boolean,
  drive: (h: { cap: { out: () => string }; done: () => boolean; stop: () => void; repo: string }) => Promise<void> | void,
): Promise<void> {
  const repo = makeRepo();
  await initProject(repo, "issues follow");
  seed(repo);
  // Let the runner flush the previous test's result before stdout is captured.
  await sleep(50);
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  const onDone = () => (done = true);
  const promise = cmdIssues(repo, args, { ppid: () => parent, intervalMs, tty }).then(onDone);
  try {
    await drive({ cap, done: () => done, stop: () => (parent = 1), repo });
  } finally {
    parent = 1;
    try {
      await promise;
    } catch {
      // The follow failed; whatever it printed is already captured. Nothing to rethrow here.
    }
    cap.restore();
  }
}

/** The last frame a captured non-TTY stream painted: frames are separated by a blank line, so
 * the trailing separator leaves the last element empty. */
function lastFrame(text: string): string {
  const frames = text.split("\n\n").filter((f) => f.trim() !== "");
  return frames[frames.length - 1] ?? "";
}

/** The ages one phrase names in the seconds bucket, in frame order (`checked <n>s ago` or
 * `updated <n>s ago`). */
function secondAges(text: string, phrase: "checked" | "updated"): number[] {
  return [...text.matchAll(new RegExp(`${phrase} (\\d+)s ago`, "g"))].map((m) => Number(m[1]));
}

/** Assert a phrase's ages never go backwards and do grow across the captured frames. */
function assertAgesGrow(text: string, phrase: "checked" | "updated"): void {
  const ages = secondAges(text, phrase);
  assert.ok(ages.length >= 4, `at least two frames name a ${phrase} age in seconds (got ${ages.length})`);
  for (let i = 1; i < ages.length; i++) assert.ok(ages[i]! >= ages[i - 1]!, `${phrase} age never goes backwards`);
  assert.ok(ages[ages.length - 1]! > ages[0]!, `the ${phrase} age grows across frames`);
}

test("issues -f's first frame is the one-shot list, and it repaints until its parent exits", async () => {
  const seed = (repo: string) => writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock"), issueRow(9, "Mirror skips a renamed issue")]);
  // The one-shot list over the same ledger, for the comparison the plan's first criterion asks
  // for: the follow's first frame is that text, ages aside.
  const oneShotRepo = makeRepo();
  await initProject(oneShotRepo, "issues one-shot frame");
  seed(oneShotRepo);
  const oneShot = (await expectOkAsync(() => cmdIssues(oneShotRepo, []))).stdout.trim();
  assert.match(oneShot, /github issues — znation\/proj \(main\): 2 open, checked \d+s ago/);
  await withIssuesFollow(seed, ["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(60);
    const frames = cap.out();
    assert.ok((frames.match(/github issues — znation\/proj \(main\): 2 open/g) ?? []).length >= 2, "at least two frames repainted");
    assert.equal(maskAges(frames.split("\n\n")[0]!.trim()), maskAges(oneShot), "the first frame is the one-shot list");
    assert.match(frames, /1\. #7 — Reclaim leaves a stale lock — untrusted, not mirrored/);
    assert.match(frames, /2\. #9 — Mirror skips a renamed issue/);
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
    assert.ok(done(), "follow resolves once the parent is gone");
    const before = cap.out();
    await sleep(30);
    assert.equal(cap.out(), before, "nothing printed after the follow ended");
  });
});

test("issues -f re-reads the ledger each frame — an added and a dropped issue show next frame", async () => {
  await withIssuesFollow(
    (repo) => writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock")]),
    ["-f"],
    5,
    false,
    async ({ cap, repo, stop }) => {
      await sleep(40);
      assert.match(cap.out(), /1\. #7 — Reclaim leaves a stale lock/);
      assert.doesNotMatch(cap.out(), /#9/, "the added issue is not on screen before the rewrite");
      writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock"), issueRow(9, "Mirror skips a renamed issue")]);
      await sleep(40);
      const added = cap.out();
      assert.match(added, /2 open/, "the header's count follows the rewrite");
      assert.match(added, /2\. #9 — Mirror skips a renamed issue/, "the added issue names itself next frame");
      writeLedger(repo, [issueRow(9, "Mirror skips a renamed issue")]);
      await sleep(40);
      stop();
      const dropped = lastFrame(cap.out());
      assert.match(dropped, /1\. #9 — Mirror skips a renamed issue/);
      assert.doesNotMatch(dropped, /#7/, "the dropped issue is gone from the last frame");
    },
  );
});

test("issues -f's ages advance between frames — no frozen first-frame age", async () => {
  await withIssuesFollow(
    (repo) => writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock")], 40_000),
    ["-f"],
    20,
    false,
    async ({ cap, stop }) => {
      await sleep(1_100);
      stop();
      const out = cap.out();
      assertAgesGrow(out, "checked");
      assertAgesGrow(out, "updated");
    },
  );
});

test("issues -f --grep keeps the whole-list numbering and repaints its no-match line", async () => {
  const seed = (repo: string) => writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock"), issueRow(9, "Mirror skips a renamed issue")]);
  await withIssuesFollow(seed, ["-f", "--grep", "stale"], 5, false, async ({ cap, stop }) => {
    await sleep(60);
    const frames = cap.out();
    assert.ok((frames.match(/1\. #7 — Reclaim leaves a stale lock/g) ?? []).length >= 2, "the kept row repaints");
    assert.doesNotMatch(frames, /#9/, "the filtered-out issue never appears");
    assert.match(frames, /github issues — znation\/proj \(main\): 2 open/, "the header names the mirror's own open count, not the kept rows");
    stop();
  });
  await withIssuesFollow(seed, ["-f", "--grep", "nomatch"], 5, false, async ({ cap, stop }) => {
    await sleep(60);
    const frames = cap.out();
    assert.ok((frames.match(/no GitHub issues match "nomatch"/g) ?? []).length >= 2, "the filter's line repaints");
    assert.doesNotMatch(frames, /#7/, "no rows behind a no-match frame");
    stop();
  });
});

test("issues -f prints the not-read frame until a ledger appears, then the list", async () => {
  await withIssuesFollow(() => {}, ["-f"], 5, false, async ({ cap, repo, stop }) => {
    await sleep(40);
    const frames = cap.out();
    assert.ok((frames.match(/the GitHub issues mirror has not been read yet/g) ?? []).length >= 2, "the not-read frame repaints");
    writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock")]);
    await sleep(40);
    stop();
    const last = lastFrame(cap.out());
    assert.match(last, /github issues — znation\/proj \(main\): 1 open, checked \d+s ago/);
    assert.match(last, /1\. #7 — Reclaim leaves a stale lock/);
  });
});

test("issues -f --json is refused before any frame, and -f beside --show is refused by the detail gate", async () => {
  const repo = makeRepo();
  await initProject(repo, "issues follow json");
  writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock")]);
  await sleep(50);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdIssues(repo, ["-f", "--json"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(err, /issues --json prints one document; -f\/--follow repaints a live view — drop one of them/);
    assert.doesNotMatch(cap.out(), /github issues/, "no frame before the refusal");
    const showErr = await expectFailAsync(() => cmdIssues(repo, ["-f", "--show", "1"], { ppid: () => 4242, intervalMs: 5 }));
    assert.match(showErr, /tumwater issues takes no arguments \(got "-f"\)/, "the detail branch's flag gate refuses -f");
    assert.doesNotMatch(cap.out(), /github issues/, "still no frame and no detail row");
  } finally {
    cap.restore();
  }
});

test("issues -f clears the screen only on a TTY", async () => {
  const seed = (repo: string) => writeLedger(repo, [issueRow(7, "Reclaim leaves a stale lock")]);
  await withIssuesFollow(seed, ["-f"], 5, true, async ({ cap, done, stop }) => {
    await sleep(20);
    assert.ok(cap.out().startsWith(CLEAR), "a TTY follow starts with a clear-screen");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
  await withIssuesFollow(seed, ["-f"], 5, false, async ({ cap, done, stop }) => {
    await sleep(20);
    assert.ok(!cap.out().includes(CLEAR), "a non-TTY follow never clears the screen");
    stop();
    for (let i = 0; i < 500 && !done(); i++) await sleep(10);
  });
});

test("issues -f repaints the one-shot list with only a fake gh on PATH, and calls it 0 times", async () => {
  const repo = makeRepo();
  await initProject(repo, "issues follow no gh");
  const open = [issueRow(7, "Reclaim leaves a stale lock")];
  writeLedger(repo, open);
  // A fake `gh` the command could call, logging every call, is the only thing on PATH: no real
  // gh is reachable, and the log staying unwritten is the counter the plan's criterion asks for.
  const bin = path.join(repo, ".tumwater", "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(repo, ".tumwater", "gh-calls.log");
  writeScript(path.join(bin, "gh"), `echo "$@" >> '${calls}'`);
  const oneShot = await cliWithEnv(repo, { PATH: bin }, ["issues"]);
  assert.equal(oneShot.code, 0, oneShot.stderr);
  assert.match(oneShot.stdout, /github issues — znation\/proj \(main\): 1 open/);
  // A real child process (so PATH is the command's own) running the follow.
  const child = spawn(process.execPath, [CLI, "issues", "-f"], {
    cwd: repo,
    env: { ...process.env, PATH: bin },
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 100 && (out.match(/github issues — znation\/proj/g) ?? []).length < 2; i++) await sleep(100);
    const frames = out.split("\n\n").filter((f) => f.trim() !== "");
    assert.ok(frames.length >= 2, `the follow repainted at least two frames (got ${JSON.stringify(out.slice(0, 200))})`);
    assert.equal(maskAges(frames[0]!.trim()), maskAges(oneShot.stdout.trim()), "the frame is the one-shot read's list");
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
  assert.ok(!fs.existsSync(calls), "the follow never invoked gh");
});
