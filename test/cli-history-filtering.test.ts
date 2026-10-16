import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { formatTimestamp } from "../src/text/datetime.js";
import { seededHistoryRepo } from "./fixtures/history-fixtures.js";

// The `history` command's window-and-filter views — --since and --grep — split from
// cli-history.test.ts so node --test runs the two files in parallel processes, the way
// cli-logs-filtering.test.ts was split from cli-logs.test.ts. That file keeps the core views
// (the table, --role, -n, --json, the flag edges); the tickRows collector's unit cases live
// in test/history-data.test.ts and the direct in-process cmdHistory views in
// cli-history-views.test.ts.

// --- --since <duration>: the window-shaped view (the sibling of logs --since / report --since)

/** Seed tick pairs at fixed ages before `now` (the pattern cli-logs-filtering.test.ts uses for
 * --since): one 2-day-old tick_end outside any sane window, then a clean tick (start 50m,
 * end 45m) and a feature tick (start 30m, end 10m) inside a 1h window. */
function seedWindowedHistory(repo: string, now = Date.now()): void {
  const age = (ms: number) => now - ms;
  writeEvents(repo, [
    { ts: age(2 * 86_400_000), loop: "feature", type: "tick_end", tick: 1, result: "changed", summary: "old work" },
    { ts: age(50 * 60_000), loop: "clean", type: "tick_start", tick: 2 },
    { ts: age(45 * 60_000), loop: "clean", type: "tick_end", tick: 2, result: "no_change", summary: "tidied" },
    { ts: age(30 * 60_000), loop: "feature", type: "tick_start", tick: 3 },
    { ts: age(10 * 60_000), loop: "feature", type: "tick_end", tick: 3, result: "changed", summary: "new work", tokens: 1200, costUsd: 0.01 },
  ]);
}

test("history --since returns exactly the ticks of the window, newest first, with durations where starts survive", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since window");
  seedWindowedHistory(repo);

  const r = await cli(repo, "history", "--since", "1h");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2, r.stdout);
  // Newest first; the 2-day-old tick is outside the window on both the day key and ts.
  assert.match(lines[0]!, /feature\s+#3\s+merged\s+20m\s+1200 tok · \$0\.01\s+new work/);
  assert.match(lines[1]!, /clean\s+#2\s+no change\s+5m\s+tidied/);
  assert.ok(!r.stdout.includes("old work"), r.stdout);
  // The log's oldest retained event (2d) predates the cutoff, so the window is provably
  // covered: no rotation note.
  assert.ok(!r.stdout.includes("note:"), r.stdout);

  // --role composes with --since: history's --role is a row filter, not a rival view.
  const scoped = await cli(repo, "history", "--since", "1h", "--role", "clean");
  assert.equal(scoped.code, 0);
  assert.equal(scoped.stdout.trim().split("\n").length, 1);
  assert.match(scoped.stdout, /clean\s+#2/);
  assert.ok(!scoped.stdout.includes("feature"), scoped.stdout);
});

test("history --since --json emits the window's rows raw and an empty document for an empty window", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since json");
  const seededAt = Date.now();
  seedWindowedHistory(repo, seededAt);

  const r = await cli(repo, "history", "--since", "1h", "--json");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { rows: Array<Record<string, unknown>> };
  assert.deepEqual(payload.rows.map((row) => [row.loop, row.tick]), [["feature", 3], ["clean", 2]]);
  // Raw epoch ms, not the rendered time: exactly the seeded 10m-ago tick_end's stamp — compared
  // to the seed's own clock, not a read after the CLI ran, which a loaded host pushed past the
  // old 5 s tolerance (7-8 s CLI runs, BUGS.md 2026-10-01).
  assert.equal(payload.rows[0]!["ts"], seededAt - 10 * 60_000, "the 10m-ago instant, as raw epoch ms");
  assert.equal(payload.rows[0]!["tokens"], 1200);
  assert.equal(payload.rows[0]!["costUsd"], 0.01);
  // The note never touches JSON output — a parsing consumer reads rows only.
  assert.ok(!r.stdout.includes("note:"), r.stdout);

  // A window holding no tick_end answers as an empty document, never prose.
  const empty = await cli(repo, "history", "--since", "1s", "--json");
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { rows: [] });
});

test("history --since prints the hedged rotation note after the table, table mode only", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since note");
  // Every event lies inside the 1h window, so the oldest retained event cannot prove the
  // window's coverage (rotation or idleness — the hedged phrasing stays true either way).
  const now = Date.now();
  writeEvents(repo, [
    { ts: now - 10 * 60_000, loop: "clean", type: "tick_start", tick: 1 },
    { ts: now - 5 * 60_000, loop: "clean", type: "tick_end", tick: 1, result: "no_change", summary: "tidied" },
  ]);

  const r = await cli(repo, "history", "--since", "1h");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2, r.stdout);
  assert.match(lines[0]!, /clean\s+#1/);
  assert.equal(
    lines[1],
    "note: the log's oldest retained event lies inside this window; older events may have rotated out",
    "the note rides the table's end, cmdLogs' wording verbatim",
  );

  const json = await cli(repo, "history", "--since", "1h", "--json");
  assert.equal(json.code, 0);
  assert.ok(!json.stdout.includes("note:"), json.stdout);
});

test("history --since refuses the rival shape and validates through the shared duration helpers", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since validation");

  const rival = await cli(repo, "history", "--since", "1h", "-n", "5");
  assert.equal(rival.code, 1);
  assert.match(rival.stderr, /--since .*-n/);
  assert.match(rival.stderr, /rival shapes/);

  const overCap = await cli(repo, "history", "--since", "8d");
  assert.equal(overCap.code, 1);
  assert.match(overCap.stderr, /history --since is capped at 7d \(got 8d\)/);

  const malformed = await cli(repo, "history", "--since", "45x");
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /history --since needs a duration like 45s, 90m, 1h30m, or 2d/);

  const valueless = await cli(repo, "history", "--since");
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /history --since needs a value/);

  // Table mode's empty-window prose: `no runs in <duration>`, durationLabel's phrasing.
  seedWindowedHistory(repo);
  const empty = await cli(repo, "history", "--since", "1s");
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, "no runs in 1s\n");
});

// --- --grep <text>: the row filter its sibling logs --grep already has

test("history --grep keeps only rows whose rendered line matches, case-insensitively", async () => {
  const repo = await seededHistoryRepo();

  const r = await cli(repo, "history", "--grep", "WIDGET");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /feature\s+#7\s+merged/);
  assert.match(lines[0]!, /added a widget/);

  // An empty match names the pattern, never the empty-log prose: "no runs yet" would be a
  // false statement about a log this command just scanned (the logs --grep rule).
  const none = await cli(repo, "history", "--grep", "no such text");
  assert.equal(none.code, 0);
  assert.equal(none.stdout, 'no runs matching "no such text"\n');

  // The stable event id is greppable: the haystack prefixes the raw type.
  const type = await cli(repo, "history", "--grep", "tick_end");
  assert.equal(type.code, 0);
  assert.equal(type.stdout.trim().split("\n").length, 3);
});

test("history --grep treats a flag-shaped pattern as text, not a flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history grep impersonation");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "tick_end", tick: 7, result: "changed", summary: "reverted --since handling" },
  ]);
  const r = await cli(repo, "history", "--grep", "--since");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /reverted --since handling/);
});

test("history --grep composes with -n, which bounds the scanned window", async () => {
  const repo = await seededHistoryRepo();

  // The last two rows are bugfix #9 and clean #3: feature #7 lies outside the scan — a
  // scanned-but-unmatched window says so, it does not claim the log was empty.
  const narrow = await cli(repo, "history", "-n", "2", "--grep", "widget");
  assert.equal(narrow.code, 0);
  assert.equal(narrow.stdout, 'no runs matching "widget"\n');

  const wide = await cli(repo, "history", "-n", "3", "--grep", "widget");
  assert.equal(wide.code, 0);
  assert.match(wide.stdout, /added a widget/);
});

test("history --grep composes with --role", async () => {
  const repo = await seededHistoryRepo();

  const unscoped = await cli(repo, "history", "--grep", "no_change");
  assert.equal(unscoped.code, 0);
  assert.match(unscoped.stdout, /clean\s+#3/);

  const scoped = await cli(repo, "history", "--role", "feature", "--grep", "no_change");
  assert.equal(scoped.code, 0);
  assert.equal(scoped.stdout, 'no runs matching "no_change"\n');
});

test("history --since --grep filters the window's rows", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since grep");
  seedWindowedHistory(repo);

  const r = await cli(repo, "history", "--since", "1h", "--grep", "new work");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  assert.match(r.stdout, /feature\s+#3/);

  // The 2-day-old tick sits outside the window, so its detail matches nothing here — the
  // empty-match wording names the pattern, not a window the log disproves.
  const outside = await cli(repo, "history", "--since", "1h", "--grep", "old work");
  assert.equal(outside.code, 0);
  assert.equal(outside.stdout, 'no runs matching "old work"\n');

  // Without --grep the empty window keeps its own prose — the pattern branch never leaks.
  const plain = await cli(repo, "history", "--since", "1s");
  assert.equal(plain.code, 0);
  assert.equal(plain.stdout, "no runs in 1s\n");
});

test("history --grep --json filters the payload and stays a document when empty", async () => {
  const repo = await seededHistoryRepo();

  const r = await cli(repo, "history", "--json", "--grep", "widget");
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout) as { rows: Array<{ loop: string }> };
  assert.deepEqual(payload.rows.map((row) => row.loop), ["feature"]);

  const empty = await cli(repo, "history", "--json", "--grep", "no such text");
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { rows: [] });
});

test("history --grep fails with its own wording when the value is missing or empty", async () => {
  const repo = await seededHistoryRepo();

  const valueless = await cli(repo, "history", "--grep");
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /history --grep needs a pattern/);

  const empty = await cli(repo, "history", "--grep", "");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /history --grep needs a pattern/);
});

// --- --result <class>: the outcome filter its dashboard History sibling already has

test("history --result narrows to one outcome class and composes with --json", async () => {
  const repo = await seededHistoryRepo();

  const changes = await cli(repo, "history", "--result", "changes");
  assert.equal(changes.code, 0);
  assert.equal(changes.stdout.trim().split("\n").length, 1);
  assert.match(changes.stdout, /feature\s+#7\s+merged/);

  const merged = await cli(repo, "history", "--result", "merged");
  assert.equal(merged.stdout, changes.stdout, "--result merged filters like the hidden --result changes");

  const none = await cli(repo, "history", "--result", "none");
  assert.equal(none.code, 0);
  assert.equal(none.stdout.trim().split("\n").length, 1);
  assert.match(none.stdout, /clean\s+#3\s+no change/);

  const problems = await cli(repo, "history", "--result", "problems");
  assert.equal(problems.code, 0);
  assert.equal(problems.stdout.trim().split("\n").length, 1);
  assert.match(problems.stdout, /bugfix\s+#9\s+error/);

  // --json swaps in the collector's payload: exactly the filtered rows, no prose or note.
  const json = await cli(repo, "history", "--result", "problems", "--json");
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout) as { rows: Array<{ loop: string; result: string }> };
  assert.deepEqual(payload.rows.map((r) => [r.loop, r.result]), [["bugfix", "error"]]);
});

test("history --result composes with --since and --role", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history result compose");
  seedWindowedHistory(repo);

  // The 1h window holds feature #3 (changed) and clean #2 (no_change); the class filter keeps
  // only the former.
  const changes = await cli(repo, "history", "--since", "1h", "--result", "changes");
  assert.equal(changes.code, 0);
  const lines = changes.stdout.trim().split("\n");
  assert.equal(lines.length, 1, changes.stdout);
  assert.match(lines[0]!, /feature\s+#3/);
  assert.ok(!changes.stdout.includes("clean"), changes.stdout);

  const scoped = await cli(repo, "history", "--since", "1h", "--role", "clean", "--result", "none");
  assert.equal(scoped.code, 0);
  assert.equal(scoped.stdout.trim().split("\n").length, 1);
  assert.match(scoped.stdout, /clean\s+#2/);
});

test("history --result empty state names the class, never the empty log", async () => {
  const repo = await seededHistoryRepo();

  // The last two scanned rows are bugfix #9 (error) and clean #3 (no_change): `changes` filters
  // both out of a window that held rows, so the wording names the class, not `no runs yet`.
  const none = await cli(repo, "history", "-n", "2", "--result", "changes");
  assert.equal(none.code, 0);
  assert.equal(none.stdout, 'no runs with result "changes"\n');

  // When grep admits rows but the result filter then removes them, the wording names the
  // result filter that emptied the set: `no runs matching "widget"` would be false, feature
  // #7 does match. (The GUI says the same: rows existed, the outcome filter excluded them.)
  const both = await cli(repo, "history", "--grep", "widget", "--result", "problems");
  assert.equal(both.code, 0);
  assert.equal(both.stdout, 'no runs with result "problems"\n');

  // With no grep match either, grep's own wording stays: the pattern is what emptied the set.
  const unmatched = await cli(repo, "history", "--grep", "no such text", "--result", "problems");
  assert.equal(unmatched.code, 0);
  assert.equal(unmatched.stdout, 'no runs matching "no such text"\n');

  // A log holding no ticks at all: the result filter removed nothing, so naming the class
  // would blame it for the log's emptiness. The empty-log prose stays.
  const blank = makeRepo();
  await initProject(blank, "cli history result empty log");
  const emptyLog = await cli(blank, "history", "--result", "changes");
  assert.equal(emptyLog.code, 0);
  assert.equal(emptyLog.stdout, "no runs yet\n");

  // A window that scanned no rows: same rule, the window is what the empty state names —
  // matching the dashboard's History view, which reports the window, not the outcome filter.
  const emptyWindow = await cli(repo, "history", "--since", "1s", "--result", "changes");
  assert.equal(emptyWindow.code, 0);
  assert.equal(emptyWindow.stdout, "no runs in 1s\n");
});

test("history --result fails with its own wording for a missing or unknown class", async () => {
  const repo = await seededHistoryRepo();

  const valueless = await cli(repo, "history", "--result");
  assert.equal(valueless.code, 1);
  assert.match(valueless.stderr, /history --result needs a value/);

  const empty = await cli(repo, "history", "--result", "");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /history --result needs a value/);

  const bogus = await cli(repo, "history", "--result", "bogus");
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /merged, none, problems/);
  assert.match(bogus.stderr, /got "bogus"/);
});

test("history --summary tallies each loop's outcomes over the rows the table would print", async () => {
  const repo = await seededHistoryRepo();
  const when = formatTimestamp(1787222695956);
  const text = await cli(repo, "history", "--summary");
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout.split("\n").map((l) => l.trimEnd()), [
    "role     runs  changes  none  problems  tokens   cost  last change",
    "bugfix      1        0     0         1       0  $0.00  —",
    "clean       1        0     1         0       0  $0.00  —",
    `feature     1        1     0         0    2400  $0.02  ${when}`,
    `total       3        1     1         1    2400  $0.02  ${when}`,
    "",
  ]);

  const json = await cli(repo, "history", "--summary", "--json");
  const payload = JSON.parse(json.stdout) as { loops: unknown[]; total: unknown };
  assert.equal(payload.loops.length, 3);
  assert.deepEqual(payload.total, { loop: "total", ticks: 3, changes: 1, none: 1, problems: 1, tokens: 2400, costUsd: 0.02, lastChangeTs: 1787222695956 });

  const scoped = await cli(repo, "history", "--summary", "--role", "feature");
  assert.equal(scoped.stdout.trim().split("\n").length, 3);
  assert.match(scoped.stdout, /^feature /m);

  const problems = await cli(repo, "history", "--summary", "--result", "problems");
  assert.match(problems.stdout, /^total +1 +0 +0 +1 +0 +\$0\.00 +—$/m);
  assert.doesNotMatch(problems.stdout, /^clean/m);
});

test("history --summary keeps the empty-state output on an empty log", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history summary empty");
  assert.equal((await cli(repo, "history", "--summary")).stdout, "no runs yet\n");
  assert.deepEqual(JSON.parse((await cli(repo, "history", "--summary", "--json")).stdout), { rows: [] });
});
