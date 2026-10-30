import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { seededHistoryRepo, seedWindowedHistory } from "./fixtures/history-fixtures.js";

// The `history` command's window-and-filter views — --since, --grep and --until — split from
// cli-history.test.ts so node --test runs the files in parallel processes, the way
// cli-logs-filtering.test.ts was split from cli-logs.test.ts. That file keeps the core views
// (the table, --role, -n, --json, the flag edges); cli-history-result.test.ts holds the --result
// and --summary views and cli-history-model.test.ts the --role list and --model views, split
// off so each file fits the gate's 30 s budget. The runRows collector's unit cases live in
// test/history-data.test.ts and the direct in-process cmdHistory views in
// cli-history-views.test.ts.

// --- --since <duration>: the window-shaped view (the sibling of logs --since / report --since)

test("history --since returns exactly the runs of the window, newest first, with durations where starts survive", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history since window");
  seedWindowedHistory(repo);

  const r = await cli(repo, "history", "--since", "1h");
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2, r.stdout);
  // Newest first; the 2-day-old run is outside the window on both the day key and ts.
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
  assert.deepEqual(payload.rows.map((row) => [row.role, row.run]), [["feature", 3], ["clean", 2]]);
  // Raw epoch ms, not the rendered time: exactly the seeded 10m-ago run_end's stamp — compared
  // to the seed's own clock, not a read after the CLI ran, which a loaded host pushed past the
  // old 5 s tolerance (7-8 s CLI runs, BUGS.md 2026-10-01).
  assert.equal(payload.rows[0]!["ts"], seededAt - 10 * 60_000, "the 10m-ago instant, as raw epoch ms");
  assert.equal(payload.rows[0]!["tokens"], 1200);
  assert.equal(payload.rows[0]!["costUsd"], 0.01);
  // The note never touches JSON output — a parsing consumer reads rows only.
  assert.ok(!r.stdout.includes("note:"), r.stdout);

  // A window holding no run_end answers as an empty document, never prose.
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
    { ts: now - 10 * 60_000, loop: "clean", type: "run_start", run: 1 }, // retired-name-ok: legacy event field in a fixture
    { ts: now - 5 * 60_000, loop: "clean", type: "run_end", run: 1, result: "no_change", summary: "tidied" }, // retired-name-ok: legacy event field in a fixture
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
  const type = await cli(repo, "history", "--grep", "run_end");
  assert.equal(type.code, 0);
  assert.equal(type.stdout.trim().split("\n").length, 3);
});

test("history --grep treats a flag-shaped pattern as text, not a flag", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history grep impersonation");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "run_end", run: 7, result: "changed", summary: "reverted --since handling" }, // retired-name-ok: legacy event field in a fixture
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

  // The 2-day-old run sits outside the window, so its detail matches nothing here — the
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
  const payload = JSON.parse(r.stdout) as { rows: Array<{ role: string }> };
  assert.deepEqual(payload.rows.map((row) => row.role), ["feature"]);

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

test("history --since --until keeps only the runs that ended between the two edges", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history until window");
  seedWindowedHistory(repo);

  const r = await cli(repo, "history", "--since", "1h", "--until", "30m");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().split("\n").length, 1, r.stdout);
  assert.match(r.stdout, /clean\s+#2\s+no change\s+5m\s+tidied/);
  assert.ok(!r.stdout.includes("new work"), r.stdout);
  assert.ok(!r.stdout.includes("old work"), r.stdout);

  const json = await cli(repo, "history", "--since", "1h", "--until", "30m", "--json");
  const rows = (JSON.parse(json.stdout) as { rows: { role: string }[] }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.role, "clean");

  const scoped = await cli(repo, "history", "--since", "1h", "--until", "30m", "--role", "feature");
  assert.match(scoped.stdout, /no runs between 1h and 30m ago/);
});

test("history --until with an empty window names both edges", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history until empty");
  seedWindowedHistory(repo);

  const r = await cli(repo, "history", "--since", "1h", "--until", "50m");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no runs between 1h and 50m ago/);
});

test("history --until is refused without --since or when not shorter", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history until refused");
  seedWindowedHistory(repo);

  for (const args of [["--until", "1h"], ["-f", "--until", "1h"]]) {
    const r = await cli(repo, "history", ...args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /history --until requires --since/);
  }
  for (const until of ["2h", "1h"]) {
    const r = await cli(repo, "history", "--since", "1h", "--until", until);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /history --until \(.*\) must be shorter than --since/);
  }
  const missing = await cli(repo, "history", "--since", "1h", "--until");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /history --until needs a value/);
});
