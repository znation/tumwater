import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent } from "../src/events/events.js";
import { initProject } from "../src/init/init.js";
import { cmdTick, renderTickDetail } from "../src/tick/tick-detail.js";
import { readTickDetail, type TickDetail } from "../src/tick/tick-detail-data.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { expectFailAsync, expectOkAsync } from "./helpers/exit-capture.js";

// The `tick <role> <n>` command: the readTickDetail collector's window bracketing and
// unpaired/in-flight behavior as unit cases, the renderer's summary header, and the CLI
// surface — the --json shape and the arg-error cases, driven in-process the way
// cli-history-views.test.ts drives cmdHistory (pure in-process reads only; the subprocess dispatch
// gets one smoke run through the real binary, as cli-history.test.ts does).

function start(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "bugfix", type: "run_start", run: 3, ...over } as HarnessEvent;
}

function end(over: Partial<HarnessEvent>): HarnessEvent {
  return { ts: 0, loop: "bugfix", type: "run_end", run: 3, result: "changed", ...over } as HarnessEvent;
}

test("readTickDetail returns exactly one loop's tick block, bracketed by its start and end", () => {
  const root = makeRepo();
  writeEvents(root, [
    // A neighbor loop's tick with the SAME number contributes nothing.
    start({ ts: 1000, loop: "feature" }),
    { ts: 2000, loop: "feature", type: "review_verdict", head: "abc" } as HarnessEvent,
    end({ ts: 3000, loop: "feature", result: "no_change" }),
    // The asked run: start, a tick-less in-tick event, the queued pin, the end.
    start({ ts: 4000 }),
    { ts: 5000, loop: "bugfix", type: "review_verdict", head: "def", durationMs: 9000 } as HarnessEvent,
    { ts: 6000, loop: "bugfix", type: "land_queued", commit: "abc1234def", summary: "the fix" } as HarnessEvent,
    end({ ts: 7000, result: "changed", summary: "the fix", tokens: 1200, costUsd: 0.03 }),
    // After the block: another loop, and the asked loop's NEXT tick — both excluded.
    { ts: 8000, loop: "clean", type: "run_start", run: 1 } as HarnessEvent,
    start({ ts: 9000, run: 4 }),
  ]);
  const d = readTickDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.role, "bugfix");
  assert.equal(d.tick, 3);
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
      ["land_queued", 6000],
      ["run_end", 7000],
    ],
  );
});

test("readTickDetail picks the newest occurrence of a recurring tick number", () => {
  // A counter reset makes an old tick number recur; asking by number means the recent one.
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    end({ ts: 2000, result: "no_change", summary: "the old one" }),
    start({ ts: 3000 }),
    end({ ts: 4000, result: "changed", summary: "the new one" }),
  ]);
  const d = readTickDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.startTs, 3000);
  assert.equal(d.result, "changed");
  assert.deepEqual(
    d.events.map((e) => e.ts),
    [3000, 4000],
  );
});

test("readTickDetail marks an in-flight run: events so far, no end, no duration", () => {
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, loop: "bugfix", type: "build_check", scope: "gate", script: "npm test", status: "running" } as HarnessEvent,
  ]);
  const d = readTickDetail(root, "bugfix", 3);
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

test("readTickDetail bounds a rotation-cut block at the loop's next run_start", () => {
  // The run_end was lost to rotation; the next tick's start closes the window exclusive, so
  // the following tick's events never leak into this one.
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, loop: "bugfix", type: "review_verdict", head: "def" } as HarnessEvent,
    start({ ts: 3000, run: 4 }),
    end({ ts: 4000, run: 4 }),
  ]);
  const d = readTickDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.endTs, null);
  assert.deepEqual(
    d.events.map((e) => e.ts),
    [1000, 2000],
  );
});

test("readTickDetail answers unpaired when only the run_end survived rotation", () => {
  const root = makeRepo();
  writeEvents(root, [end({ ts: 5000, tokens: 700, costUsd: 0.02 })]);
  const d = readTickDetail(root, "bugfix", 3);
  assert.ok(d !== null);
  assert.equal(d.startTs, null);
  assert.equal(d.endTs, 5000);
  assert.equal(d.durationMs, null);
  assert.equal(d.result, "changed");
  assert.equal(d.tokens, 700);
  assert.deepEqual(d.events.map((e) => e.ts), [5000]);
});

test("readTickDetail returns null for a tick the scan does not hold", () => {
  const missing = makeRepo();
  assert.equal(readTickDetail(missing, "bugfix", 3), null);
  const root = makeRepo();
  writeEvents(root, [start({ ts: 1000, run: 2 }), end({ ts: 2000, run: 2 })]);
  assert.equal(readTickDetail(root, "bugfix", 3), null);
  assert.equal(readTickDetail(root, "clean", 2), null);
});

test("renderTickDetail prints the summary header, the commit sha, and formatEvent lines", () => {
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, loop: "bugfix", type: "land_queued", commit: "abc1234def7890", summary: "the fix" } as HarnessEvent,
    end({ ts: 61_000, result: "changed", summary: "the fix", tokens: 1200, costUsd: 0.03 }),
  ]);
  const d = readTickDetail(root, "bugfix", 3)!;
  const out = renderTickDetail(d);
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^bugfix run #3 — merged · 60s · /);
  assert.match(lines[0]!, / tok · \$0\.03 · commit abc1234/);
  // The trail is the shared event rendering, one line per event, in ts order.
  assert.match(lines[1]!, /run #3 started/);
  assert.match(lines[3]!, /run #3 merged — the fix/);
});

test("renderTickDetail renders a corrupt outcome as ?, never undefined", () => {
  const root = makeRepo();
  writeEvents(root, [start({ ts: 1000 }), end({ ts: 2000, result: 7 } as never)]);
  const d = readTickDetail(root, "bugfix", 3)!;
  assert.match(renderTickDetail(d).split("\n")[0]!, /^bugfix run #3 — \?( ·.*)?$/);
});

test("renderTickDetail marks an in-flight tick in its header", () => {
  const root = makeRepo();
  writeEvents(root, [
    start({ ts: 1000 }),
    { ts: 2000, loop: "bugfix", type: "review_start", head: "def" } as HarnessEvent,
  ]);
  const d = readTickDetail(root, "bugfix", 3)!;
  assert.match(renderTickDetail(d).split("\n")[0]!, /^bugfix run #3 — in flight( ·.*)?$/);
});

test("cmdTick prints the human view, the --json payload, and the not-found line", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick detail test");
  writeEvents(repo, [
    start({ ts: 1000 }),
    end({ ts: 31_000, result: "changed", summary: "the fix", tokens: 1200, costUsd: 0.03 }),
  ]);
  const { stdout } = await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], false));
  assert.match(stdout, /^bugfix run #3 — merged · 30s · /);
  assert.match(stdout, /run #3 started/);

  const json = await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], true));
  const payload = JSON.parse(json.stdout) as TickDetail;
  assert.equal(payload.role, "bugfix");
  assert.equal(payload.tick, 3);
  assert.equal(payload.startTs, 1000);
  assert.equal(payload.endTs, 31_000);
  assert.equal(payload.durationMs, 30_000);
  assert.equal(payload.result, "changed");
  assert.equal(payload.tokens, 1200);
  assert.equal(payload.costUsd, 0.03);
  assert.equal(payload.usage, "1200 tok · $0.03");
  assert.equal(payload.events.length, 2);

  // An unpaired tick keeps durationMs null in the payload.
  writeEvents(repo, [end({ ts: 5000, run: 9, result: "skipped" })]);
  const unpaired = JSON.parse(
    (await expectOkAsync(() => cmdTick(repo, ["bugfix", "9"], true))).stdout,
  ) as TickDetail;
  assert.equal(unpaired.startTs, null);
  assert.equal(unpaired.durationMs, null);

  // A tick the scan does not hold: a not-found line, exit 0 — and under --json a parseable
  // `null` document, never the prose line a jq pipe would choke on (the history --json
  // precedent: every exit-0 output is JSON).
  const none = await expectOkAsync(() => cmdTick(repo, ["bugfix", "42"], false));
  assert.match(none.stdout, /no run #42 for bugfix/);
  const noneJson = await expectOkAsync(() => cmdTick(repo, ["bugfix", "42"], true));
  assert.equal(JSON.parse(noneJson.stdout), null);
});

test("cmdTick fails with the usage on a missing, unknown, or extra positional and a bad n", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick arg errors");
  // Missing role / missing n / stray extra: arity is exactly <role> <n>.
  for (const argv of [[], ["bugfix", "3", "extra"]]) {
    assert.match(await expectFailAsync(() => cmdTick(repo, argv, false)), /usage: tumwater history <role> \[<n>\] \[--last\] \[--stat\] \[--json\]/);
  }
  // Unknown role: the shared unknown-role wording plus the usage.
  const role = await expectFailAsync(() => cmdTick(repo, ["nosuch", "3"], false));
  assert.match(role, /unknown role: nosuch/);
  assert.match(role, /usage: tumwater history <role>/);
  // A non-positive or non-numeric n: the shared count parser's wording, naming the command
  // so a bare `<n>` cannot leave the operator guessing which argument it means.
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    assert.match(await expectFailAsync(() => cmdTick(repo, ["bugfix", bad], false)), /history <n> needs a positive integer/);
  }
});

test("tumwater tick dispatches through the real binary, flags gated", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick cli smoke");
  writeEvents(repo, [start({ ts: 1000 }), end({ ts: 2000, result: "no_change" })]);
  const ok = await cli(repo, "tick", "bugfix", "3");
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^bugfix run #3 — no change · 1s\n/);
  // Unknown flags fail with the unknown-argument error, before the ready-repo gate can mask it.
  const bad = await cli(repo, "tick", "bugfix", "3", "--rol");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--rol/);
});

test("tumwater history <role> <n> prints the trail tick prints; a listing flag beside it is refused", async () => {
  const repo = makeRepo();
  await initProject(repo, "history trail smoke");
  writeEvents(repo, [start({ ts: 1000 }), end({ ts: 2000, result: "no_change" })]);
  const viaTick = await cli(repo, "tick", "bugfix", "3");
  const viaHistory = await cli(repo, "history", "bugfix", "3");
  assert.equal(viaHistory.code, 0);
  assert.equal(viaHistory.stdout, viaTick.stdout);
  const last = await cli(repo, "history", "bugfix", "--last");
  assert.equal(last.code, 0);
  assert.equal(last.stdout, viaTick.stdout);
  const json = await cli(repo, "history", "--json", "bugfix", "3");
  assert.equal(json.code, 0);
  assert.doesNotThrow(() => JSON.parse(json.stdout));
  const bad = await cli(repo, "history", "bugfix", "3", "--role", "qa");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--role/);
});

test("tick's dispatcher fails a wrong positional count with its usage, before the ready-repo gate", async () => {
  // The dispatcher repeats cmdTick's arity guard (cli.ts's tick case), so a malformed
  // invocation fails with the usage no matter the directory — including one that is not
  // even a git repository, where a dropped guard would surface as an environment error.
  // run outside any repo on purpose: the arity check must precede the ready-repo gate.
  const empty = tmpdir();
  for (const args of [["tick"], ["tick", "bugfix", "3", "extra"]]) {
    const r = await cli(empty, ...args);
    assert.equal(r.code, 1, `tumwater ${args.join(" ")}`);
    assert.match(r.stderr, /usage: tumwater history <role> \[<n>\] \[--last\] \[--stat\] \[--json\]/, `tumwater ${args.join(" ")}`);
    assert.doesNotMatch(r.stderr, /not a git repository/, `tumwater ${args.join(" ")}`);
  }
});

test("cmdTick --last resolves the newest tick's trail, identical to naming that number", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick last test");
  writeEvents(repo, [
    start({ ts: 1000, run: 2 }),
    end({ ts: 2000, run: 2, result: "no_change", summary: "older" }),
    start({ ts: 3000, run: 7 }),
    end({ ts: 31_000, run: 7, result: "changed", summary: "the newest", tokens: 900, costUsd: 0.01 }),
  ]);
  // --last prints exactly what the numbered form prints for the newest tick number.
  const last = await expectOkAsync(() => cmdTick(repo, ["bugfix"], false, true));
  const numbered = await expectOkAsync(() => cmdTick(repo, ["bugfix", "7"], false));
  assert.equal(last.stdout, numbered.stdout);
  assert.match(last.stdout, /^bugfix run #7 — merged · 28s · /);
  // And the JSON payload matches too.
  const lastJson = JSON.parse(
    (await expectOkAsync(() => cmdTick(repo, ["bugfix"], true, true))).stdout,
  ) as TickDetail;
  const numJson = JSON.parse(
    (await expectOkAsync(() => cmdTick(repo, ["bugfix", "7"], true))).stdout,
  ) as TickDetail;
  assert.deepEqual(lastJson, numJson);
});

test("cmdTick --last on an empty log: not-found line at exit 0, parseable null under --json", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick last empty");
  const none = await expectOkAsync(() => cmdTick(repo, ["bugfix"], false, true));
  assert.match(none.stdout, /^no completed run for bugfix in the scanned window/);
  const noneJson = await expectOkAsync(() => cmdTick(repo, ["bugfix"], true, true));
  assert.equal(JSON.parse(noneJson.stdout), null);
});

test("cmdTick --last with a numeric n is refused with the usage, and an unknown role keeps its wording", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick last rivals");
  // --last and a numeric <n> are rivals: either order, the usage.
  assert.match(await expectFailAsync(() => cmdTick(repo, ["bugfix", "3"], false, true)), /usage: tumwater history <role>/);
  const unknown = await expectFailAsync(() => cmdTick(repo, ["nosuch"], false, true));
  assert.match(unknown, /unknown role: nosuch/);
  assert.match(unknown, /usage: tumwater history <role>/);
});

test("tick --stat appends the pinned commit's per-file summary, text and JSON", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick stat");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeEvents(repo, [
    start({ ts: 1000 }),
    { ts: 1500, loop: "bugfix", type: "land_queued", commit: sha, summary: "x" } as HarnessEvent,
    end({ ts: 2000 }),
  ]);
  const plain = (await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], false))).stdout;
  const text = (await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], false, false, true))).stdout;
  assert.ok(text.startsWith(plain.trimEnd()), "header and trail unchanged");
  assert.match(text, new RegExp(` · commit ${sha.slice(0, 8)}`));
  assert.match(text, /README\.md +\| /);
  const json = JSON.parse((await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], true, false, true))).stdout);
  assert.match(json.stat, /README\.md +\| /);
  assert.equal("stat" in JSON.parse((await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], true))).stdout), false);
  assert.equal((await cli(repo, "tick", "bugfix", "3", "--stat")).code, 0);
});

test("tick --stat names a missing or foreign commit instead of failing", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick stat");
  writeEvents(repo, [start({ ts: 1000 }), end({ ts: 2000 })]);
  assert.match((await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], false, false, true))).stdout, /\(no commit: this run sent nothing to merge\)/);
  writeEvents(repo, [
    start({ ts: 1000 }),
    { ts: 1500, loop: "bugfix", type: "land_queued", commit: "0".repeat(40), summary: "x" } as HarnessEvent,
    end({ ts: 2000 }),
  ]);
  assert.match((await expectOkAsync(() => cmdTick(repo, ["bugfix", "3"], false, false, true))).stdout, /\(commit 00000000 is not in this repository\)/);
});

test("renderTickDetail and cmdTick --json show a queued tick's resolved landing", async () => {
  const repo = makeRepo();
  await initProject(repo, "tick detail landing test");
  const ev = (o: Partial<HarnessEvent>): HarnessEvent => ({ loop: "bugfix", ...o }) as HarnessEvent;
  writeEvents(repo, [
    start({ ts: 1000, run: 1 }),
    ev({ ts: 1100, type: "land_queued", commit: "sha1abcdef" }),
    end({ ts: 1200, run: 1, result: "queued" }),
    ev({ ts: 1300, type: "landed", commit: "sha1abcdef", result: "changed" }),
  ]);
  const text = (await expectOkAsync(() => cmdTick(repo, ["bugfix", "1"], false))).stdout;
  assert.match(text, /run #1 — merged/);
  const lines = text.trimEnd().split("\n");
  assert.match(lines[lines.length - 1]!, /merge of sha1abc\w* done/);
  const payload = JSON.parse((await expectOkAsync(() => cmdTick(repo, ["bugfix", "1"], true))).stdout) as TickDetail;
  assert.equal(payload.landing?.type, "landed");
  assert.equal(renderTickDetail(readTickDetail(repo, "bugfix", 1)!), text.trimEnd());
});
