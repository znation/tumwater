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
// cli-log-commands.test.ts drives `logs -f`.

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
  for (const rival of [["--since", "1h"], ["--summary"]]) {
    const err = await expectFailAsync(() => cmdHistory(repo, ["-f", ...rival]));
    assert.match(err, new RegExp(`${rival[0]}.*-f|-f.*${rival[0]}`));
  }
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
