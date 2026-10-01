import test from "node:test";
import assert from "node:assert/strict";
import { cmdHistory } from "../src/ui/history.js";
import { logEvent } from "../src/events.js";
import { makeRepo } from "./repo-fixtures.js";
import { expectFailAsync, expectOkAsync } from "./exit-capture.js";
import { displayWidth } from "../src/text-width.js";

// The rendering half of `tumwater history` (ui/history.ts) had no direct tests: the
// history-data.test.ts slice covers the row collector, and gui-endpoints covers its JSON
// payload, but the CLI table renderer — column alignment, the grep haystack, the empty-log
// and no-match prose, the --since/--json surface, and the rival-flag failures — went
// unmeasured. These tests call cmdHistory directly, in-process, the way
// log-commands-views.test.ts drives cmdLogs: stdout captured, fail() branches caught via
// the exit stub. Pure in-process awaits only (the command only reads the event log).

const NOW = Date.now();

/** A repo whose event log holds two completed ticks (role `dry`, then role `clean`,
 * newest last) plus a `docs` tick_end with no matching tick_start — the unpaired case a
 * rotation-cut log produces, which must render an em dash for its duration. */
function repoWithTicks(): string {
  const repo = makeRepo();
  logEvent(repo, { ts: NOW - 120_000, loop: "dry", type: "tick_start", tick: 1 });
  logEvent(repo, {
    ts: NOW - 60_000,
    loop: "dry",
    type: "tick_end",
    tick: 1,
    result: "error",
    error: "the suite went red",
    tokens: 400,
    costUsd: 0.01,
  });
  logEvent(repo, { ts: NOW - 60_000, loop: "clean", type: "tick_start", tick: 1 });
  logEvent(repo, {
    ts: NOW - 30_000,
    loop: "clean",
    type: "tick_end",
    tick: 1,
    result: "changed",
    summary: "Fix the flake in the parser",
    tokens: 1200,
    costUsd: 0.03,
  });
  logEvent(repo, {
    ts: NOW - 10_000,
    loop: "docs",
    type: "tick_end",
    tick: 2,
    result: "changed",
    summary: "touch up the readme",
  });
  return repo;
}

test("history renders the last ticks newest-first with duration, usage, and detail", async () => {
  const repo = repoWithTicks();
  const { stdout: out } = await expectOkAsync(() => cmdHistory(repo, []));
  const cleanIdx = out.indexOf("clean");
  const testsIdx = out.indexOf("dry");
  assert.ok(cleanIdx >= 0 && testsIdx >= 0, `both rows print: ${JSON.stringify(out)}`);
  assert.ok(cleanIdx < testsIdx, "newest first: clean's tick_end is the newest");
  assert.match(out, /clean\s+#1\s+changed\s+30s\s+1200 tok · \$0\.03\s+Fix the flake/);
  assert.match(out, /dry\s+#1\s+error\s+60s\s+400 tok · \$0\.01\s+the suite went red/);
  // The unpaired tick_end (its tick_start never logged) renders the em dash for duration.
  assert.match(out, /docs\s+#2\s+changed\s+—\s+touch up the readme/);
});

test("history -n bounds the printed rows", async () => {
  const repo = repoWithTicks();
  const { stdout: out } = await expectOkAsync(() => cmdHistory(repo, ["-n", "1"]));
  assert.match(out, /docs\s+#2/, "the newest row survives the limit");
  assert.ok(!out.includes("clean"), `older rows are cut: ${JSON.stringify(out)}`);
});

test("history --role filters the rows to one loop", async () => {
  const repo = repoWithTicks();
  const { stdout: out } = await expectOkAsync(() => cmdHistory(repo, ["--role", "dry"]));
  assert.match(out, /dry\s+#1\s+error/);
  assert.ok(!out.includes("clean"), `other roles are filtered out: ${JSON.stringify(out)}`);
});

test("history --grep filters on the rendered row line (plus the tick_end type), case-insensitively", async () => {
  const repo = repoWithTicks();
  // Matches through the detail column — the row as it renders.
  const { stdout: rendered } = await expectOkAsync(() => cmdHistory(repo, ["--grep", "FLAKE"]));
  assert.match(rendered, /clean\s+#1\s+changed\s+30s/);
  assert.ok(!rendered.includes("dry"), `unmatched rows are filtered out: ${JSON.stringify(rendered)}`);

  // The raw event type id is greppable the way logs --grep's haystack carries it.
  const { stdout: raw } = await expectOkAsync(() => cmdHistory(repo, ["--grep", "tick_end"]));
  assert.match(raw, /clean\s+#1/);
  assert.match(raw, /dry\s+#1/);
  assert.match(raw, /docs\s+#2/);
});

test("history --grep with no matches names the pattern, not the empty-log prose", async () => {
  const repo = repoWithTicks();
  const { stdout } = await expectOkAsync(() => cmdHistory(repo, ["--grep", "no-such-thing"]));
  assert.equal(stdout, 'no ticks matching "no-such-thing"\n');
});

test("history on an empty log prints the empty-log prose; --json prints a bare document", async () => {
  const repo = makeRepo();
  const { stdout } = await expectOkAsync(() => cmdHistory(repo, []));
  assert.equal(stdout, "no ticks yet\n");
  const { stdout: json } = await expectOkAsync(() => cmdHistory(repo, ["--json"]));
  assert.deepEqual(JSON.parse(json), { rows: [] });
});

test("history --json serves the rows as raw data, newest first", async () => {
  const repo = repoWithTicks();
  const { stdout } = await expectOkAsync(() => cmdHistory(repo, ["--json"]));
  const parsed = JSON.parse(stdout) as { rows: Array<{ loop: string; ts: number; tokens: number; costUsd: number; result: string }> };
  assert.deepEqual(
    parsed.rows.map((r) => r.loop),
    ["docs", "clean", "dry"],
  );
  const clean = parsed.rows[1]!;
  assert.equal(clean.ts, NOW - 30_000);
  assert.equal(clean.tokens, 1200);
  assert.equal(clean.costUsd, 0.03);
  assert.equal(clean.result, "changed");
});

test("history --since prints the windowed rows and the rotation caveat; an empty window says so", async () => {
  const repo = repoWithTicks();
  const { stdout: out } = await expectOkAsync(() => cmdHistory(repo, ["--since", "2h"]));
  assert.match(out, /clean\s+#1\s+changed/, "rows within the window print");
  // A fresh repo's log cannot prove it covers the window's start, so the caveat rides along.
  assert.match(out, /older events may have rotated out/);
  const empty = makeRepo();
  const { stdout: emptyOut } = await expectOkAsync(() => cmdHistory(empty, ["--since", "2h"]));
  assert.match(emptyOut, /no ticks in 2h/);
  assert.ok(!emptyOut.includes("rotated out"), "no rows means no sparse-window note");
});

test("history rejects rival flag shapes and over-cap values with the shared wordings", async () => {
  const repo = makeRepo();
  assert.match(
    await expectFailAsync(() => cmdHistory(repo, ["--since", "1h", "-n", "5"])),
    /--since cannot be combined with -n \(a count and a window are rival shapes\)/,
  );
  assert.match(await expectFailAsync(() => cmdHistory(repo, ["--since", "30d"])), /capped at 7d/);
  assert.match(await expectFailAsync(() => cmdHistory(repo, ["-n", "201"])), /must be between 1 and 200/);
  assert.match(await expectFailAsync(() => cmdHistory(repo, ["--grep"])), /--grep needs a pattern/);
  assert.match(await expectFailAsync(() => cmdHistory(repo, ["--grep", ""])), /--grep needs a pattern/);
  assert.match(await expectFailAsync(() => cmdHistory(repo, ["-n", "0"])), /-n needs a positive integer/);
});

test("history pads text columns by display width, so a wide-character loop name aligns", async () => {
  const repo = makeRepo();
  logEvent(repo, { ts: NOW - 60_000, loop: "a", type: "tick_start", tick: 1 });
  logEvent(repo, { ts: NOW - 50_000, loop: "a", type: "tick_end", tick: 1, result: "changed", summary: "first" });
  logEvent(repo, { ts: NOW - 40_000, loop: "日本", type: "tick_start", tick: 1 });
  logEvent(repo, { ts: NOW - 30_000, loop: "日本", type: "tick_end", tick: 1, result: "changed", summary: "second" });
  const { stdout } = await expectOkAsync(() => cmdHistory(repo, []));
  const lines = stdout.trimEnd().split("\n");
  // The "#" that starts the tick column sits at the same terminal display column on
  // every row — a code-unit padEnd would leave the CJK row's later columns drifted right.
  const hashColumns = lines.map((line) => {
    const idx = line.indexOf("#");
    assert.ok(idx >= 0, `every row has a tick cell: ${JSON.stringify(line)}`);
    return displayWidth(line.slice(0, idx));
  });
  assert.equal(new Set(hashColumns).size, 1, `aligned: ${JSON.stringify(lines)}`);
});
