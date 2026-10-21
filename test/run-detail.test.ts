import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events/events.js";
import { initProject } from "../src/init/init.js";
import { cmdRunDetail, renderRunDetail } from "../src/run/run-detail.js";
import { readRunDetail, type RunDetail } from "../src/run/run-detail-data.js";
import { writeEvents, writeLogLines } from "./fixtures/log-fixtures.js";
import { piLogPath } from "../src/paths.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { expectFailAsync, expectOkAsync } from "./helpers/exit-capture.js";

// The `run <role> <n>` command: the readRunDetail collector's window bracketing and
// unpaired/in-flight behavior as unit cases, the renderer's summary header, and the CLI
// surface — the --json shape and the arg-error cases, driven in-process the way
// cli-history-views.test.ts drives cmdHistory (pure in-process reads only; the subprocess dispatch
// gets one smoke run through the real binary, as cli-history.test.ts does).

function start(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "bugfix", type: "run_start", run: 3, ...over } as HarnessEvent; // retired-name-ok: legacy event field in a fixture
}

function end(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "bugfix", type: "run_end", run: 3, result: "changed", ...over } as HarnessEvent; // retired-name-ok: legacy event field in a fixture
}

test("readRunDetail returns exactly one role's run block, bracketed by its start and end", () => {
  const root = makeRepo();
  writeEvents(root, [
    // A neighbor role's run with the SAME number contributes nothing.
    start({ ts: 1000, loop: "feature" }), // retired-name-ok: legacy event field in a fixture
    { ts: 2000, source: "feature", type: "review_verdict", head: "abc" } as HarnessEvent,
    end({ ts: 3000, loop: "feature", result: "no_change" }), // retired-name-ok: legacy event field in a fixture
    // The asked run: start, a run-less in-run event, the queued pin, the end.
    start({ ts: 4000 }),
    { ts: 5000, source: "bugfix", type: "review_verdict", head: "def", durationMs: 9000 } as HarnessEvent,
    { ts: 6000, source: "bugfix", type: "merge_queued", commit: "abc1234def", summary: "the fix" } as HarnessEvent,
    end({ ts: 7000, result: "changed", summary: "the fix", tokens: 1200, costUsd: 0.03 }),
    // After the block: another role, and the asked role's NEXT run — both excluded.
    { ts: 8000, source: "clean", type: "run_start", run: 1 } as HarnessEvent,
    start({ ts: 9000, run: 4 }),
  ]);
  const d = readRunDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.role, "bugfix");
  assert.equal(d.run, 3);
  assert.equal(d.startTs, 4000);
  assert.equal(d.endTs, 7000);
  assert.equal(d.durationMs, 3000);
  assert.equal(d.result, "changed");
  assert.equal(d.tokens, 1200);
  assert.equal(d.costUsd, 0.03);
  assert.deepEqual(
    d.events.map((e) => [e.type, e.ts]),
    [
      ["run_start", 4000],
      ["review_verdict", 5000],
      ["merge_queued", 6000],
      ["run_end", 7000],
    ],
  );
});

test("readRunDetail picks the newest occurrence of a recurring run number", () => {
  // A counter reset makes an old run number recur; asking by number means the recent one.
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    end({ ts: 2000, result: "no_change", summary: "the old one" }),
    start({ ts: 3000 }),
    end({ ts: 4000, result: "changed", summary: "the new one" }),
  ]);
  const d = readRunDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.startTs, 3000);
  assert.equal(d.result, "changed");
  assert.deepEqual(
    d.events.map((e) => e.ts),
    [3000, 4000],
  );
});

test("readRunDetail marks an in-flight run: events so far, no end, no duration", () => {
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, source: "bugfix", type: "build_check", scope: "gate", script: "npm test", status: "running" } as HarnessEvent,
  ]);
  const d = readRunDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.startTs, 1000);
  assert.equal(d.endTs, null);
  assert.equal(d.durationMs, null);
  assert.equal(d.result, null);
  assert.equal(d.tokens, 0);
  assert.equal(d.costUsd, 0);
  assert.deepEqual(
    d.events.map((e) => e.ts),
    [1000, 2000],
  );
});

test("readRunDetail bounds a rotation-cut block at the role's next run_start", () => {
  // The run_end was lost to rotation; the next run's start closes the window exclusive, so
  // the following run's events never leak into this one.
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, source: "bugfix", type: "review_verdict", head: "def" } as HarnessEvent,
    start({ ts: 3000, run: 4 }),
    end({ ts: 4000, run: 4 }),
  ]);
  const d = readRunDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.endTs, null);
  assert.deepEqual(
    d.events.map((e) => e.ts),
    [1000, 2000],
  );
});

test("readRunDetail answers unpaired when only the run_end survived rotation", () => {
  const root = makeRepo();
  writeEvents(root, [end({ ts: 5000, tokens: 700, costUsd: 0.02 })]);
  const d = readRunDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.startTs, null);
  assert.equal(d.endTs, 5000);
  assert.equal(d.durationMs, null);
  assert.equal(d.result, "changed");
  assert.equal(d.tokens, 700);
  assert.deepEqual(d.events.map((e) => e.ts), [5000]);
});

test("readRunDetail returns null for a run the scan does not hold", () => {
  const missing = makeRepo();
  assert.equal(readRunDetail(missing, "bugfix", 3), null);
  const root = makeRepo();
  writeEvents(root, [start({ ts: 1000, run: 2 }), end({ ts: 2000, run: 2 })]);
  assert.equal(readRunDetail(root, "bugfix", 3), null);
  assert.equal(readRunDetail(root, "clean", 2), null);
});

test("renderRunDetail prints the summary header, the commit sha, and formatEvent lines", () => {
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, source: "bugfix", type: "merge_queued", commit: "abc1234def7890", summary: "the fix" } as HarnessEvent,
    end({ ts: 61_000, result: "changed", summary: "the fix", tokens: 1200, costUsd: 0.03 }),
  ]);
  const d = readRunDetail(root, "bugfix", 3)!;
  const out = renderRunDetail(d);
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^bugfix run #3 — merged · 60s · /);
  assert.match(lines[0]!, / tok · \$0\.03 · commit abc1234/);
  // The trail is the shared event rendering, one line per event, in ts order.
  assert.match(lines[1]!, /run #3 started/);
  assert.match(lines[3]!, /run #3 merged — the fix/);
});

test("renderRunDetail renders a corrupt outcome as ?, never undefined", () => {
  const root = makeRepo();
  writeEvents(root, [start({ ts: 1000 }), end({ ts: 2000, result: 7 } as never)]);
  const d = readRunDetail(root, "bugfix", 3)!;
  assert.match(renderRunDetail(d).split("\n")[0]!, /^bugfix run #3 — \?( ·.*)?$/);
});

test("renderRunDetail marks an in-flight run in its header", () => {
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, source: "bugfix", type: "review_start", head: "def" } as HarnessEvent,
  ]);
  const d = readRunDetail(root, "bugfix", 3)!;
  assert.match(renderRunDetail(d).split("\n")[0]!, /^bugfix run #3 — in flight( ·.*)?$/);
});

test("cmdRunDetail prints the human view, the --json payload, and the not-found line", async () => {
  const repo = makeRepo();
  await initProject(repo, "run detail test");
  writeEvents(repo, [
    start({ ts: 1000 }),
    end({ ts: 31_000, result: "changed", summary: "the fix", tokens: 1200, costUsd: 0.03 }),
  ]);
  const { stdout } = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false));
  assert.match(stdout, /^bugfix run #3 — merged · 30s · /);
  assert.match(stdout, /run #3 started/);

  const json = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], true));
  const payload = JSON.parse(json.stdout) as RunDetail;
  assert.equal(payload.role, "bugfix");
  assert.equal(payload.run, 3);
  assert.equal(payload.startTs, 1000);
  assert.equal(payload.endTs, 31_000);
  assert.equal(payload.durationMs, 30_000);
  assert.equal(payload.result, "changed");
  assert.equal(payload.tokens, 1200);
  assert.equal(payload.costUsd, 0.03);
  assert.equal(payload.usage, "1200 tok · $0.03");
  assert.equal(payload.mergedSha, null);
  assert.equal(payload.events.length, 2);

  // An unpaired run keeps durationMs null in the payload.
  writeEvents(repo, [end({ ts: 5000, run: 9, result: "skipped" })]);
  const unpaired = JSON.parse(
    (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "9"], true))).stdout,
  ) as RunDetail;
  assert.equal(unpaired.startTs, null);
  assert.equal(unpaired.durationMs, null);

  // A run the scan does not hold: a not-found line, exit 0 — and under --json a parseable
  // `null` document, never the prose line a jq pipe would choke on (the history --json
  // precedent: every exit-0 output is JSON).
  const none = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "42"], false));
  assert.match(none.stdout, /no run #42 for bugfix/);
  const noneJson = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "42"], true));
  assert.equal(JSON.parse(noneJson.stdout), null);
});

test("cmdRunDetail fails with the usage on a missing, unknown, or extra positional and a bad n", async () => {
  const repo = makeRepo();
  await initProject(repo, "run arg errors");
  // Missing role / missing n / stray extra: arity is exactly <role> <n>.
  for (const argv of [[], ["bugfix", "3", "extra"]]) {
    assert.match(await expectFailAsync(() => cmdRunDetail(repo, argv, false)), /usage: tumwater history <role> \[<n>\] \[--last \[--result <class>\[,\.\.\.\]\] \[--model <selector>\[,\.\.\.\]\]\] \[--stat\] \[--patch\] \[--transcript \[--prompt\] \[--grep <text>\]\] \[--json\]/);
  }
  // Unknown role: the shared unknown-role wording plus the usage.
  const role = await expectFailAsync(() => cmdRunDetail(repo, ["nosuch", "3"], false));
  assert.match(role, /unknown role: nosuch/);
  assert.match(role, /usage: tumwater history <role>/);
  // A non-positive or non-numeric n: the shared count parser's wording, naming the command
  // so a bare `<n>` cannot leave the operator guessing which argument it means.
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    assert.match(await expectFailAsync(() => cmdRunDetail(repo, ["bugfix", bad], false)), /history <n> needs a positive integer/);
  }
});

test("cmdRunDetail names an unknown role before the positional count", async () => {
  const repo = makeRepo();
  await initProject(repo, "run role first");
  const typo = await expectFailAsync(() => cmdRunDetail(repo, ["featuer"], false));
  assert.match(typo, /unknown role: featuer/);
  assert.match(typo, /did you mean `feature`/);
  assert.match(typo, /usage: tumwater history <role>/);
  assert.match(await expectFailAsync(() => cmdRunDetail(repo, ["nosuch", "3", "extra"], false)), /unknown role: nosuch/);
  const viaCli = await cli(repo, "history", "featuer");
  assert.equal(viaCli.code, 1);
  assert.match(viaCli.stderr, /unknown role: featuer/);
});

test("a bare history <role> names the missing run number or --last", async () => {
  const repo = makeRepo();
  await initProject(repo, "run bare role");
  const bare = await expectFailAsync(() => cmdRunDetail(repo, ["bugfix"], false));
  assert.match(bare, /needs a run number or --last/);
  assert.match(bare, /tumwater history --role bugfix/);
  assert.match(bare, /usage: tumwater history <role>/);
  assert.match(
    await expectFailAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { last: true })),
    /--last takes no run number \(got "3"\)/,
  );
});

test("tumwater tick dispatches through the real binary, flags gated", async () => {
  const repo = makeRepo();
  await initProject(repo, "run cli smoke");
  writeEvents(repo, [start({ ts: 1000 }), end({ ts: 2000, result: "no_change" })]);
  const ok = await cli(repo, "tick", "bugfix", "3");
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^bugfix run #3 — no change · 1s\n/);
  // Unknown flags fail with the unknown-argument error, before the ready-repo gate can mask it.
  const bad = await cli(repo, "tick", "bugfix", "3", "--rol");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--rol/);
});

test("tumwater history <role> <n> prints the trail run prints; a listing flag beside it is refused", async () => {
  const repo = makeRepo();
  await initProject(repo, "history trail smoke");
  writeEvents(repo, [start({ ts: 1000 }), end({ ts: 2000, result: "no_change" })]);
  const viaRun = await cli(repo, "tick", "bugfix", "3");
  const viaHistory = await cli(repo, "history", "bugfix", "3");
  assert.equal(viaHistory.code, 0);
  assert.equal(viaHistory.stdout, viaRun.stdout);
  const last = await cli(repo, "history", "bugfix", "--last");
  assert.equal(last.code, 0);
  assert.equal(last.stdout, viaRun.stdout);
  const json = await cli(repo, "history", "--json", "bugfix", "3");
  assert.equal(json.code, 0);
  assert.doesNotThrow(() => JSON.parse(json.stdout));
  const bad = await cli(repo, "history", "bugfix", "3", "--role", "qa");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--role/);
});

test("tick's dispatcher fails a wrong positional count with its usage, before the ready-repo gate", async () => {
  // The dispatcher repeats cmdRunDetail's arity guard (cli.ts's tick case), so a malformed
  // invocation fails with the usage no matter the directory — including one that is not
  // even a git repository, where a dropped guard would surface as an environment error.
  // run outside any repo on purpose: the arity check must precede the ready-repo gate.
  const empty = tmpdir();
  for (const args of [["tick"], ["tick", "bugfix", "3", "extra"]]) {
    const r = await cli(empty, ...args);
    assert.equal(r.code, 1, `tumwater ${args.join(" ")}`);
    assert.match(r.stderr, /usage: tumwater history <role> \[<n>\] \[--last \[--result <class>\[,\.\.\.\]\] \[--model <selector>\[,\.\.\.\]\]\] \[--stat\] \[--patch\] \[--transcript \[--prompt\] \[--grep <text>\]\] \[--json\]/, `tumwater ${args.join(" ")}`);
    assert.doesNotMatch(r.stderr, /not a git repository/, `tumwater ${args.join(" ")}`);
  }
});

test("cmdRunDetail --last resolves the newest run's trail, identical to naming that number", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last test");
  writeEvents(repo, [
    start({ ts: 1000, run: 2 }),
    end({ ts: 2000, run: 2, result: "no_change", summary: "older" }),
    start({ ts: 3000, run: 7 }),
    end({ ts: 31_000, run: 7, result: "changed", summary: "the newest", tokens: 900, costUsd: 0.01 }),
  ]);
  // --last prints exactly what the numbered form prints for the newest run number.
  const last = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], false, { last: true }));
  const numbered = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "7"], false));
  assert.equal(last.stdout, numbered.stdout);
  assert.match(last.stdout, /^bugfix run #7 — merged · 28s · /);
  // And the JSON payload matches too.
  const lastJson = JSON.parse(
    (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], true, { last: true }))).stdout,
  ) as RunDetail;
  const numJson = JSON.parse(
    (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "7"], true))).stdout,
  ) as RunDetail;
  assert.deepEqual(lastJson, numJson);
});

test("cmdRunDetail --last --result picks the newest run in the listed classes", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last result");
  writeEvents(repo, [
    start({ ts: 1000, run: 2 }),
    end({ ts: 2000, run: 2, result: "changed" }),
    start({ ts: 3000, run: 5 }),
    end({ ts: 4000, run: 5, result: "error" }),
    start({ ts: 5000, run: 7 }),
    end({ ts: 6000, run: 7, result: "no_change" }),
  ]);
  const out = async (argv: string[], opts: { last?: boolean; result?: string } = {}, json = false) =>
    (await expectOkAsync(() => cmdRunDetail(repo, argv, json, opts))).stdout;
  const run5 = await out(["bugfix", "5"]);
  const run2 = await out(["bugfix", "2"]);
  assert.equal(await out(["bugfix"], { last: true, result: "problems" }), run5);
  assert.equal(await out(["bugfix"], { last: true, result: "merged" }), run2);
  assert.equal(await out(["bugfix"], { last: true, result: "problems,merged" }), run5);
  assert.equal(await out(["bugfix"], { last: true, result: "changes" }), run2);
  assert.deepEqual(
    JSON.parse(await out(["bugfix"], { last: true, result: "problems" }, true)),
    JSON.parse(await out(["bugfix", "5"], {}, true)),
  );
});

test("cmdRunDetail --last with no role opens the newest run of any role, narrowed by result and model", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last any role");
  writeEvents(repo, [
    start({ ts: 1000, run: 2 }),
    end({ ts: 2000, run: 2, result: "changed" }),
    start({ ts: 3000, run: 4, loop: "feature" }), // retired-name-ok: legacy event field in a fixture
    end({ ts: 4000, run: 4, loop: "feature", result: "error" }), // retired-name-ok: legacy event field in a fixture
    start({ ts: 5000, run: 5 }),
    end({ ts: 6000, run: 5, result: "no_change" }),
  ]);
  const out = async (argv: string[], opts: { last?: boolean; result?: string } = {}, json = false) =>
    (await expectOkAsync(() => cmdRunDetail(repo, argv, json, opts))).stdout;
  assert.equal(await out([], { last: true }), await out(["bugfix", "5"]));
  assert.equal(await out([], { last: true, result: "problems" }), await out(["feature", "4"]));
  assert.equal(await out([], { last: true, result: "merged" }), await out(["bugfix", "2"]));
  assert.deepEqual(JSON.parse(await out([], { last: true }, true)), JSON.parse(await out(["bugfix", "5"], {}, true)));
  const miss = await out([], { last: true, result: "refused" });
  assert.match(miss, /^no completed run with result "refused" for any role in the scanned window/);
  assert.equal(JSON.parse(await out([], { last: true, result: "refused" }, true)), null);
  const bare = await expectFailAsync(() => cmdRunDetail(repo, [], false));
  assert.match(bare, /usage: tumwater history <role>/);
});

test("history --last with no role through the CLI opens the newest run of any role", async () => {
  const repo = makeRepo();
  await initProject(repo, "run cli any role");
  writeEvents(repo, [
    start({ ts: 3000, run: 4, loop: "feature" }), // retired-name-ok: legacy event field in a fixture
    end({ ts: 4000, run: 4, loop: "feature", result: "error" }), // retired-name-ok: legacy event field in a fixture
    start({ ts: 5000, run: 5 }),
    end({ ts: 6000, run: 5, result: "no_change" }),
  ]);
  const r = await cli(repo, "history", "--last", "--result", "problems");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^feature run #4 /);
});

test("--last --result with no matching run: not-found line at exit 0, null under --json", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last result miss");
  writeEvents(repo, [start({ ts: 1000, run: 2 }), end({ ts: 2000, run: 2, result: "changed" })]);
  const miss = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], false, { last: true, result: "refused" }));
  assert.match(miss.stdout, /^no completed run with result "refused" for bugfix in the scanned window/);
  const json = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], true, { last: true, result: "refused" }));
  assert.equal(JSON.parse(json.stdout), null);
});

test("--result needs --last and a known class", async () => {
  const repo = makeRepo();
  await initProject(repo, "run result guards");
  assert.match(
    await expectFailAsync(() => cmdRunDetail(repo, ["bugfix", "5"], false, { result: "problems" })),
    /--result needs --last/,
  );
  assert.match(
    await expectFailAsync(() => cmdRunDetail(repo, ["bugfix"], false, { last: true, result: "problemz" })),
    /history --result must be one of merged, none, refused, problems/,
  );
});

test("history <role> --last --result <class> through the CLI is not read as a run number", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last result cli");
  writeEvents(repo, [
    start({ ts: 3000, run: 5 }),
    end({ ts: 4000, run: 5, result: "error" }),
    start({ ts: 5000, run: 7 }),
    end({ ts: 6000, run: 7, result: "no_change" }),
  ]);
  const r = await cli(repo, "history", "bugfix", "--last", "--result", "problems");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^bugfix run #5 /);
});

test("cmdRunDetail --last on an empty log: not-found line at exit 0, parseable null under --json", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last empty");
  const none = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], false, { last: true }));
  assert.match(none.stdout, /^no completed run for bugfix in the scanned window/);
  const noneJson = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], true, { last: true }));
  assert.equal(JSON.parse(noneJson.stdout), null);
});

test("cmdRunDetail --last with a numeric n is refused with the usage, and an unknown role keeps its wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last rivals");
  // --last and a numeric <n> are rivals: either order, the usage.
  assert.match(await expectFailAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { last: true })), /usage: tumwater history <role>/);
  const unknown = await expectFailAsync(() => cmdRunDetail(repo, ["nosuch"], false, { last: true }));
  assert.match(unknown, /unknown role: nosuch/);
  assert.match(unknown, /usage: tumwater history <role>/);
});

test("run --stat appends the pinned commit's per-file summary, text and JSON", async () => {
  const repo = makeRepo();
  await initProject(repo, "run stat");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeEvents(repo, [
    start({ ts: 1000 }),
    { ts: 1500, source: "bugfix", type: "merge_queued", commit: sha, summary: "x" } as HarnessEvent,
    end({ ts: 2000 }),
  ]);
  const plain = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false))).stdout;
  const text = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { stat: true }))).stdout;
  assert.ok(text.startsWith(plain.trimEnd()), "header and trail unchanged");
  assert.match(text, new RegExp(` · commit ${sha.slice(0, 8)}`));
  assert.match(text, /README\.md +\| /);
  const json = JSON.parse((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], true, { stat: true }))).stdout);
  assert.match(json.stat, /README\.md +\| /);
  assert.equal("stat" in JSON.parse((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], true))).stdout), false);
  assert.equal((await cli(repo, "tick", "bugfix", "3", "--stat")).code, 0);
});

test("run --stat names a missing or foreign commit instead of failing", async () => {
  const repo = makeRepo();
  await initProject(repo, "run stat");
  writeEvents(repo, [start({ ts: 1000 }), end({ ts: 2000 })]);
  assert.match((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { stat: true }))).stdout, /\(no commit: this run sent nothing to merge\)/);
  writeEvents(repo, [
    start({ ts: 1000 }),
    { ts: 1500, source: "bugfix", type: "merge_queued", commit: "0".repeat(40), summary: "x" } as HarnessEvent,
    end({ ts: 2000 }),
  ]);
  assert.match((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { stat: true }))).stdout, /\(commit 00000000 is not in this repository\)/);
});

test("run --patch appends the pinned commit's patch, text and JSON", async () => {
  const repo = makeRepo();
  await initProject(repo, "run patch");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeEvents(repo, [
    start({ ts: 1000 }),
    { ts: 1500, source: "bugfix", type: "merge_queued", commit: sha, summary: "x" } as HarnessEvent,
    end({ ts: 2000 }),
  ]);
  const plain = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false))).stdout;
  const text = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { patch: true }))).stdout;
  assert.ok(text.startsWith(plain.trimEnd()), "header and trail unchanged");
  assert.match(text, /diff --git a\/README\.md b\/README\.md/);
  assert.match(text, /^\+.+$/m);
  const both = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { stat: true, patch: true }))).stdout;
  assert.ok(both.search(/README\.md +\| /) < both.indexOf("diff --git"), "stat block before patch block");
  const json = JSON.parse((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], true, { patch: true }))).stdout);
  assert.match(json.patch, /diff --git/);
  assert.equal("stat" in json, false);
  assert.equal((await cli(repo, "tick", "bugfix", "3", "--patch")).code, 0);
});

test("run --patch names a missing or foreign commit instead of failing", async () => {
  const repo = makeRepo();
  await initProject(repo, "run patch");
  writeEvents(repo, [start({ ts: 1000 }), end({ ts: 2000 })]);
  assert.match((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { patch: true }))).stdout, /\(no commit: this run sent nothing to merge\)/);
  writeEvents(repo, [
    start({ ts: 1000 }),
    { ts: 1500, source: "bugfix", type: "merge_queued", commit: "0".repeat(40), summary: "x" } as HarnessEvent,
    end({ ts: 2000 }),
  ]);
  assert.match((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { patch: true }))).stdout, /\(commit 00000000 is not in this repository\)/);
});

test("renderRunDetail and cmdRunDetail --json show a queued run's resolved merge", async () => {
  const repo = makeRepo();
  await initProject(repo, "run detail merge test");
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "bugfix", ...o }) as HarnessEvent; // retired-name-ok: legacy event field in a fixture
  writeEvents(repo, [
    start({ ts: 1000, run: 1 }),
    ev({ ts: 1100, type: "merge_queued", commit: "sha1abcdef" }),
    end({ ts: 1200, run: 1, result: "queued" }),
    ev({ ts: 1300, type: "merge_done", commit: "sha1abcdef", result: "changed" }),
  ]);
  const text = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "1"], false))).stdout;
  assert.match(text, /run #1 — merged/);
  const lines = text.trimEnd().split("\n");
  assert.match(lines[lines.length - 1]!, /merge of sha1abc\w* done/);
  const payload = JSON.parse((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "1"], true))).stdout) as RunDetail;
  assert.equal(payload.merge?.type, "merge_done");
  assert.equal(renderRunDetail(readRunDetail(repo, "bugfix", 1)!), text.trimEnd());
});

test("a leftover-recovery run's detail shows the failed attempt it re-queued, leading its trail", () => {
  // Run 2 only re-queued run 1's change after its review failed. Its verdict is that failure
  // (the history row's rule), and the failure was logged before run 2 began, so the trail
  // opens with it and stays in time order rather than ending on an earlier event.
  const root = makeRepo();
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "bugfix", ...o }) as HarnessEvent; // retired-name-ok: legacy event field in a fixture
  const recovered = "recovered leftover work from bugfix: the fix";
  writeEvents(root, [
    start({ ts: 1000, run: 1 }),
    ev({ ts: 1100, type: "merge_queued", commit: "sha1abcdef", summary: "the fix" }),
    end({ ts: 1200, run: 1, result: "queued" }),
    ev({ ts: 1500, type: "merge_failed", commit: "sha1abcdef", result: "review_error" }),
    start({ ts: 2000, run: 2 }),
    ev({ ts: 2100, type: "merge_queued", commit: "sha1abcdef", summary: recovered }),
    end({ ts: 2200, run: 2, result: "queued", summary: recovered }),
    ev({ ts: 3000, type: "merge_failed", commit: "sha1abcdef", result: "rejected" }),
  ]);
  const detail = readRunDetail(root, "bugfix", 2)!;
  assert.equal(detail.result, "review_error");
  assert.equal(detail.merge?.ts, 1500);
  const lines = renderRunDetail(detail).split("\n");
  assert.match(lines[0]!, /run #2 — review failed/);
  assert.match(lines[1]!, /merge of sha1abc\w* failed \(review failed\)/);
  assert.equal(lines.length, 5);
  // The authoring run keeps the change's final verdict, its outcome line last.
  const authoring = renderRunDetail(readRunDetail(root, "bugfix", 1)!).split("\n");
  assert.match(authoring[0]!, /run #1 — rejected in review/);
  assert.match(authoring.at(-1)!, /merge of sha1abc\w* failed \(rejected in review\)/);
});

test("renderRunDetail names the landed sha only when it differs from the pinned commit", () => {
  const base = readRunDetail(
    (() => {
      const root = tmpdir();
      writeEvents(root, [
        start({ ts: 1000 }),
        { ts: 1500, loop: "bugfix", source: "bugfix", type: "merge_queued", commit: "aaaaaaa1111" } as HarnessEvent, // retired-name-ok: legacy event field in a fixture
        end({ ts: 2000 }),
      ]);
      return root;
    })(),
    "bugfix",
    3,
  )!;
  const header = (mergedSha: string | null): string => renderRunDetail({ ...base, mergedSha }).split("\n")[0]!;
  assert.match(header("bbbbbbb2222"), / · commit aaaaaaa1 · merged as bbbbbbb2$/);
  assert.doesNotMatch(header("aaaaaaa1111"), /merged as/);
  assert.doesNotMatch(header(null), /merged as/);
});

test("history --transcript appends only the run's own agent runs, composes with --last/--stat, and notes a miss", async () => {
  const repo = makeRepo();
  writeEvents(repo, [
    start({ ts: 1000, run: 1 }),
    end({ ts: 2000, run: 1 }),
    start({ ts: 3000, run: 2 }),
    end({ ts: 4000, run: 2 }),
    start({ ts: 5000, run: 3 }),
    end({ ts: 6000, run: 3 }),
  ]);
  const seg = (ts: number, text: string) => [
    { type: "tumwater_run", kind: "author", agent: "pi", ts },
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts } },
  ];
  writeLogLines(piLogPath(repo, "bugfix"), [...seg(1500, "said-one"), ...seg(3500, "said-two")]);
  const out = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { transcript: true }))).stdout;
  assert.match(out, /said-two/);
  assert.doesNotMatch(out, /said-one/);
  const json = JSON.parse((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], true, { transcript: true }))).stdout);
  assert.ok(json.transcript.join("\n").includes("said-two"));
  const plain = JSON.parse((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], true))).stdout);
  assert.equal("transcript" in plain, false);
  const miss = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "3"], false, { transcript: true }))).stdout;
  assert.match(miss, /\(no transcript for bugfix run 3: /);
  const last = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], false, { last: true, transcript: true }))).stdout;
  assert.match(last, /no transcript for bugfix run 3/);
  const both = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { stat: true, transcript: true }))).stdout;
  assert.ok(both.indexOf("(no commit") < both.indexOf("said-two"));
});

test("history --transcript --grep keeps the run's matching entries, notes a miss, and needs --transcript", async () => {
  const repo = makeRepo();
  await initProject(repo, "history grep smoke");
  writeEvents(repo, [
    start({ ts: 1000, run: 1 }),
    end({ ts: 2000, run: 1 }),
    start({ ts: 3000, run: 2 }),
    end({ ts: 4000, run: 2 }),
  ]);
  const msg = (ts: number, text: string) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts },
  });
  writeLogLines(piLogPath(repo, "bugfix"), [
    { type: "tumwater_run", kind: "author", agent: "pi", ts: 1500 },
    { type: "agent_start" },
    msg(1500, "beta-one"),
    { type: "tumwater_run", kind: "author", agent: "pi", ts: 3500 },
    { type: "agent_start" },
    msg(3500, "alpha-two"),
    msg(3600, "beta-two"),
  ]);
  const out = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { transcript: true, grep: "BETA" }))).stdout;
  assert.match(out, /beta-two/);
  assert.match(out, /^── .+ ──$/m);
  assert.doesNotMatch(out, /alpha-two|beta-one/);
  const json = JSON.parse((await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], true, { transcript: true, grep: "BETA" }))).stdout);
  assert.ok(json.transcript.join("\n").includes("beta-two"));
  assert.ok(!json.transcript.join("\n").includes("alpha-two"));
  const miss = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { transcript: true, grep: "nope" }))).stdout;
  assert.match(miss, /\(no transcript entries matching "nope" in bugfix run 2\)/);
  assert.match(await expectFailAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { grep: "beta" })), /history --grep needs --transcript/);
  const viaCli = await cli(repo, "history", "bugfix", "2", "--transcript", "--grep", "beta");
  assert.equal(viaCli.code, 0, viaCli.stderr);
  assert.match(viaCli.stdout, /beta-two/);
  assert.doesNotMatch(viaCli.stdout, /alpha-two/);
  const bare = await cli(repo, "history", "bugfix", "2", "--transcript", "--grep");
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /history --grep needs a pattern/);
  const twice = await cli(repo, "history", "bugfix", "2", "--transcript", "--grep", "a", "--grep", "b");
  assert.notEqual(twice.code, 0);
  assert.match(twice.stderr, /--grep may only be given once/);
});

test("history --transcript --prompt shows the run's own prompt, and --prompt needs --transcript", async () => {
  const repo = makeRepo();
  await initProject(repo, "history prompt smoke");
  writeEvents(repo, [
    start({ ts: 1000, run: 1 }),
    end({ ts: 2000, run: 1 }),
    start({ ts: 3000, run: 2 }),
    end({ ts: 4000, run: 2 }),
  ]);
  const seg = (ts: number, asked: string, said: string) => [
    { type: "tumwater_run", kind: "author", agent: "pi", ts },
    { type: "agent_start" },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: asked }], timestamp: ts } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: said }], timestamp: ts } },
  ];
  writeLogLines(piLogPath(repo, "bugfix"), [...seg(1500, "asked-one", "said-one"), ...seg(3500, "asked-two", "said-two")]);
  const out = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { transcript: true, prompt: true }))).stdout;
  assert.ok(out.includes("asked-two"));
  assert.ok(out.indexOf("asked-two") < out.indexOf("said-two"));
  assert.doesNotMatch(out, /asked-one|said-one/);
  const bare = (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { transcript: true }))).stdout;
  assert.match(bare, /said-two/);
  assert.doesNotMatch(bare, /asked-two/);
  const json = JSON.parse(
    (await expectOkAsync(() => cmdRunDetail(repo, ["bugfix", "2"], true, { transcript: true, prompt: true }))).stdout,
  );
  assert.ok(json.transcript.join("\n").includes("asked-two"));
  assert.match(await expectFailAsync(() => cmdRunDetail(repo, ["bugfix", "2"], false, { prompt: true })), /history --prompt needs --transcript/);
  const viaCli = await cli(repo, "history", "bugfix", "2", "--transcript", "--prompt");
  assert.equal(viaCli.code, 0);
  assert.ok(viaCli.stdout.includes("asked-two"));
});

test("cmdRunDetail --last --model picks the newest run on the listed models", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last model");
  writeEvents(repo, [
    start({ ts: 1000, run: 2, model: "a" }),
    end({ ts: 2000, run: 2, result: "changed" }),
    start({ ts: 3000, run: 5, model: "b" }),
    end({ ts: 4000, run: 5, result: "error" }),
    start({ ts: 5000, run: 7, model: "a" }),
    end({ ts: 6000, run: 7, result: "no_change" }),
    start({ ts: 7000, run: 9 }),
    end({ ts: 8000, run: 9, result: "changed" }),
  ]);
  const out = async (argv: string[], opts: { last?: boolean; result?: string; model?: string } = {}, json = false) =>
    (await expectOkAsync(() => cmdRunDetail(repo, argv, json, opts))).stdout;
  const run7 = await out(["bugfix", "7"]);
  assert.equal(await out(["bugfix"], { last: true, model: "a" }), run7);
  assert.equal(await out(["bugfix"], { last: true, model: "b" }), await out(["bugfix", "5"]));
  assert.equal(await out(["bugfix"], { last: true, model: "b,a" }), run7);
  assert.equal(await out(["bugfix"], { last: true, model: "a", result: "merged" }), await out(["bugfix", "2"]));
  assert.deepEqual(
    JSON.parse(await out(["bugfix"], { last: true, model: "a" }, true)),
    JSON.parse(await out(["bugfix", "7"], {}, true)),
  );
});

test("--last --model with no matching run: not-found line at exit 0, null under --json", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last model miss");
  writeEvents(repo, [
    start({ ts: 1000, run: 2, model: "b" }),
    end({ ts: 2000, run: 2, result: "changed" }),
  ]);
  const miss = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], false, { last: true, model: "zzz" }));
  assert.match(miss.stdout, /^no completed run on model "zzz" for bugfix in the scanned window/);
  const both = await expectOkAsync(() =>
    cmdRunDetail(repo, ["bugfix"], false, { last: true, model: "b", result: "refused" }),
  );
  assert.match(both.stdout, /^no completed run with result "refused" on model "b" for bugfix/);
  const json = await expectOkAsync(() => cmdRunDetail(repo, ["bugfix"], true, { last: true, model: "zzz" }));
  assert.equal(JSON.parse(json.stdout), null);
});

test("--model needs --last and a selector", async () => {
  const repo = makeRepo();
  await initProject(repo, "run model guards");
  assert.match(
    await expectFailAsync(() => cmdRunDetail(repo, ["bugfix", "5"], false, { model: "a" })),
    /--model needs --last/,
  );
  assert.match(
    await expectFailAsync(() => cmdRunDetail(repo, ["bugfix"], false, { last: true, model: "," })),
    /history --model needs a model selector/,
  );
});

test("history <role> --last --model <selector> through the CLI is not read as a run number", async () => {
  const repo = makeRepo();
  await initProject(repo, "run last model cli");
  writeEvents(repo, [
    start({ ts: 3000, run: 5, model: "b" }),
    end({ ts: 4000, run: 5, result: "error" }),
    start({ ts: 5000, run: 7, model: "a" }),
    end({ ts: 6000, run: 7, result: "no_change" }),
  ]);
  const r = await cli(repo, "history", "bugfix", "--last", "--model", "b");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^bugfix run #5 /);
});
