import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cmdHistory } from "../src/history/history.js";
import { eventsLogPath } from "../src/paths.js";
import { ensureParentDir } from "../src/files/files.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { captureStdout, expectFailAsync } from "./helpers/exit-capture.js";
import { sleep } from "./helpers/wait.js";

// `history -f` runs in-process with the follow's parent-death seams, the way
// cli-log-commands.test.ts drives `logs -f`. The `--summary -f` follow takes the same seams
// through cmdHistory's FollowViewSeams parameter (the tty seam selects the frame shape).

const at = (n: number) => Date.UTC(2026, 0, 1, 0, 0, n);
const line = (o: object) => JSON.stringify(o) + "\n";
const start = (source: string, run: number, n: number, model = "acme/m1") =>
  line({ ts: at(n), source, type: "run_start", run, model });
const end = (source: string, run: number, n: number, result: string) =>
  line({ ts: at(n), source, type: "run_end", run, result, summary: `${source} ${run} done` });

async function follow(args: string[], seed: string, appended: string[]): Promise<string> {
  const repo = makeRepo();
  const file = eventsLogPath(repo);
  ensureParentDir(file);
  fs.writeFileSync(file, seed);
  // Let the runner flush the previous test's result before stdout is captured.
  await new Promise((r) => setTimeout(r, 50));
  const cap = captureStdout();
  let parent = 4242;
  let done = false;
  try {
    void cmdHistory(repo, args, { ppid: () => parent, intervalMs: 10 }).then(() => (done = true));
    await sleep(100);
    for (const a of appended) fs.appendFileSync(file, a);
    await sleep(1200);
    parent = 1;
    for (let i = 0; i < 500 && !done; i++) await sleep(10);
    assert.ok(done, "follow resolves once the parent is gone");
    const before = cap.out();
    fs.appendFileSync(file, start("clean", 90, 90) + end("clean", 90, 91, "changed"));
    await sleep(1200);
    assert.equal(cap.out(), before, "nothing printed after the follow ended");
    return before;
  } finally {
    cap.restore();
  }
}

// The piped summary follow's frames: followView separates them with a blank line when stdout
// is not a TTY (the test process is not a TTY, so the piped shape is the one that prints).
// Each summary frame is one table, so splitting on the blank line recovers the frames.
const framesOf = (out: string): string[] => out.split("\n\n").filter((f) => f !== "");

async function followSummary(args: string[], seed: string, appended: string[]): Promise<string[]> {
  const out = await follow(args, seed, appended);
  return framesOf(out);
}

const seed = start("clean", 1, 1) + end("clean", 1, 2, "no_change") + start("feature", 2, 3) + end("feature", 2, 4, "changed");

test("history -f prints seed rows oldest first, then each run as it ends, once", async () => {
  const out = await follow(["-f"], seed, [start("clean", 3, 5, "acme/m2"), end("clean", 3, 6, "changed")]);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /clean\s+#1/);
  assert.match(lines[1]!, /feature\s+#2/);
  assert.match(lines[2]!, /clean\s+#3.*acme\/m2/);
  assert.match(lines[2]!, /merged/);
});

test("history -f applies --role and --result to followed rows", async () => {
  const more = [
    start("feature", 5, 5), end("feature", 5, 6, "changed"),
    start("clean", 6, 7), end("clean", 6, 8, "no_change"),
    start("clean", 7, 9), end("clean", 7, 10, "changed"),
  ];
  const byRole = await follow(["--role", "clean", "-f"], seed, more);
  assert.doesNotMatch(byRole, /feature/);
  assert.match(byRole, /#7/);
  const byResult = await follow(["--result", "merged", "-f"], seed, more);
  assert.doesNotMatch(byResult, /#6/);
  assert.match(byResult, /#7/);
});

test("history -f fails with its rival shapes", async () => {
  const repo = makeRepo();
  const err = await expectFailAsync(() => cmdHistory(repo, ["-f", "--since", "1h"]));
  assert.match(err, /--since.*-f|-f.*--since/);
});

// The test runner's own stream can interleave with captured stdout, even mid-line, so pull
// each row out by its first and last keys.
const jsonRows = (out: string) => (out.match(/\{"ts":\d+,.*?"detail":"[^"]*"\}/g) ?? []).map((l) => JSON.parse(l));

test("history -f --json streams one JSON row per line, seed oldest first", async () => {
  const out = await follow(["-f", "--json"], seed, [start("clean", 3, 5, "acme/m2"), end("clean", 3, 6, "changed")]);
  const rows = jsonRows(out);
  assert.deepEqual(rows.map((r) => `${r.role}#${r.run}`), ["clean#1", "feature#2", "clean#3"]);
  assert.equal(rows[2].model, "acme/m2");
  assert.equal(typeof rows[2].ts, "number");
});

test("history -f --json applies --result to followed rows", async () => {
  const more = [
    start("clean", 6, 7), end("clean", 6, 8, "no_change"),
    start("clean", 7, 9), end("clean", 7, 10, "changed"),
  ];
  const out = await follow(["--result", "merged", "-f", "--json"], seed, more);
  const runs = jsonRows(out).map((r) => r.run);
  assert.ok(runs.includes(7));
  assert.ok(!runs.includes(6));
});

test("history --summary -f repaints the tally as a run ends", async () => {
  const frames = await followSummary(["--summary", "-f"], seed, [start("clean", 3, 5), end("clean", 3, 6, "no_change")]);
  // The seed's first frame: clean 1 run / 1 none, feature 1 run / 1 change, total 2 runs.
  assert.ok(frames.some((f) => /(^|\n)clean\s+1\s+0\s+1/.test(f) && /(^|\n)total\s+2\s+1\s+1/.test(f)), "seed frame");
  // The appended clean run ends no_change: the next frame moves clean to 2 runs / 2 none and
  // the total to 3 runs / 2 none — the same rows a fresh `history --summary` would print.
  assert.ok(
    frames.some((f) => /(^|\n)clean\s+2\s+0\s+2/.test(f) && /(^|\n)total\s+3\s+1\s+2/.test(f)),
    "repainted frame",
  );
});

test("history --summary --by model -f repaints the per-model table", async () => {
  const frames = await followSummary(
    ["--summary", "--by", "model", "-f"],
    seed,
    [start("clean", 3, 5, "acme/m2"), end("clean", 3, 6, "changed")],
  );
  assert.ok(
    frames.some((f) => /(^|\n)acme\/m1\s+2/.test(f) && /(^|\n)total\s+2/.test(f)),
    "seed frame",
  );
  // The appended run started on acme/m2: the next frame names the new model's line and moves
  // the total to 3 runs.
  assert.ok(
    frames.some((f) => /(^|\n)acme\/m2\s+1/.test(f) && /(^|\n)total\s+3\s+2/.test(f)),
    "repainted frame",
  );
});

test("history --summary -f keeps --result and --role out of the tally", async () => {
  const more = [
    start("clean", 6, 7), end("clean", 6, 8, "no_change"),
    start("feature", 5, 9), end("feature", 5, 10, "changed"),
  ];
  // --result none: the appended changed run (feature) must never enter the tally. The
  // seed's feature change is excluded too, so the tally opens at clean's 1 no_change run,
  // grows by one when the appended clean no_change run lands, and never reaches the
  // feature run's third.
  const byResult = await followSummary(["--result", "none", "--summary", "-f"], seed, more);
  assert.ok(byResult.some((f) => /(^|\n)total\s+1\s+0\s+1/.test(f)), "seed frame");
  assert.ok(byResult.some((f) => /(^|\n)total\s+2\s+0\s+2/.test(f)), "appended no_change run joins");
  assert.ok(!byResult.some((f) => /(^|\n)total\s+3/.test(f)), "no changed run joins");
  // --role clean: the seed's feature run is out of scope, so the tally holds at clean's
  // 1 row until the appended clean run joins; the appended feature run never appears.
  const byRole = await followSummary(["--role", "clean", "--summary", "-f"], seed, more);
  assert.ok(byRole.some((f) => /(^|\n)total\s+1/.test(f)), "seed frame");
  assert.ok(byRole.some((f) => /(^|\n)total\s+2/.test(f)), "appended clean run joins");
  assert.ok(!byRole.some((f) => /(^|\n)total\s+3/.test(f)), "no out-of-scope run joins");
});

test("history --summary -f's first frame is the empty-state prose, then the table", async () => {
  const frames = await followSummary(["--summary", "-f"], "", [start("clean", 1, 1), end("clean", 1, 2, "changed")]);
  assert.ok(frames.some((f) => f === "no runs yet"), "empty first frame");
  assert.ok(frames.some((f) => /(^|\n)total\s+1\s+1/.test(f)), "table frame");
});

test("history --summary -f separates piped frames with a blank line", async () => {
  const out = await follow(["--summary", "-f"], seed, []);
  // Two or more frames: the seed frame plus at least one repaint.
  const frames = framesOf(out);
  assert.ok(frames.length >= 2, "repainted");
  assert.ok(out.includes("\n\n"), "blank-line separator");
});

test("history --summary -f --json is refused before any frame", async () => {
  const repo = makeRepo();
  const file = eventsLogPath(repo);
  ensureParentDir(file);
  fs.writeFileSync(file, seed);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdHistory(repo, ["--summary", "-f", "--json"]));
    assert.match(err, /history --summary --json prints one document; -f\/--follow repaints a live view — drop one of them/);
  } finally {
    cap.restore();
  }
  assert.equal(cap.out(), "", "no frame, clear-screen escape or JSON document printed");
});

test("history --summary -f fails a malformed -n or --result before any frame", async () => {
  const repo = makeRepo();
  const file = eventsLogPath(repo);
  ensureParentDir(file);
  fs.writeFileSync(file, seed);
  const cap = captureStdout();
  try {
    assert.match(
      await expectFailAsync(() => cmdHistory(repo, ["--summary", "-f", "-n", "0"])),
      /-n needs a positive integer/,
    );
    assert.match(
      await expectFailAsync(() => cmdHistory(repo, ["--summary", "-f", "--result", "bogus"])),
      /--result/,
    );
  } finally {
    cap.restore();
  }
  assert.equal(cap.out(), "", "no frame printed");
});

test("history --summary -f with a bad --by fails before any frame, one-shot wording", async () => {
  const repo = makeRepo();
  const file = eventsLogPath(repo);
  ensureParentDir(file);
  fs.writeFileSync(file, seed);
  const cap = captureStdout();
  try {
    const err = await expectFailAsync(() => cmdHistory(repo, ["--summary", "--by", "bogus", "-f"]));
    assert.match(err, /history --by must be one of role, model/);
  } finally {
    cap.restore();
  }
  assert.equal(cap.out(), "", "no frame printed");
});
