import test from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init/init.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { cli } from "./helpers/cli-harness.js";
import { formatTimestamp } from "../src/text/datetime.js";
import { seededHistoryRepo, seedWindowedHistory } from "./fixtures/history-fixtures.js";

// The `history` command's outcome views — --result and --summary — split from
// cli-history-filtering.test.ts (see there for the split) so each file fits the gate's 30 s
// budget.

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
  const payload = JSON.parse(json.stdout) as { rows: Array<{ role: string; result: string }> };
  assert.deepEqual(payload.rows.map((r) => [r.role, r.result]), [["bugfix", "error"]]);
});

test("history --result takes a comma list of outcome classes", async () => {
  const repo = await seededHistoryRepo();
  const none = await cli(repo, "history", "--result", "none");
  const problems = await cli(repo, "history", "--result", "problems");
  const both = await cli(repo, "history", "--result", "none,problems");
  assert.equal(both.code, 0);
  const lines = both.stdout.trim().split("\n");
  // Column widths follow the listed rows, so compare rows with whitespace runs collapsed.
  const flat = (out: string) => out.trim().split("\n").map((l) => l.replace(/\s+/g, " "));
  assert.deepEqual(flat(both.stdout), [...flat(problems.stdout), ...flat(none.stdout)]);
  for (const form of [" none , problems ", "none,none,problems"]) {
    assert.equal((await cli(repo, "history", "--result", form)).stdout, both.stdout);
  }
  const json = await cli(repo, "history", "--result", "none,problems", "--json");
  const payload = JSON.parse(json.stdout) as { rows: Array<{ role: string }> };
  assert.equal(payload.rows.length, lines.length);

  const summary = await cli(repo, "history", "--result", "merged,refused", "--summary");
  assert.equal(summary.code, 0);

  const empty = await cli(repo, "history", "--result", "refused,problems", "--role", "clean");
  assert.match(empty.stdout, /no runs with result "refused,problems"/);

  const bad = await cli(repo, "history", "--result", "none,problms");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /got "problms"/);
  assert.match(bad.stderr, /problems/);
  const comma = await cli(repo, "history", "--result", ",");
  assert.equal(comma.code, 1);
  assert.match(comma.stderr, /history --result needs a value/);
});

test("--result refused gets its own class, so a deliberate refusal stops folding into problems", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history refused");
  writeEvents(repo, [
    { ts: Date.now() - 60_000, loop: "feature", type: "run_end", run: 1, result: "refused", summary: "declined" }, // retired-name-ok: legacy event field in a fixture
    { ts: Date.now() - 30_000, loop: "bugfix", type: "run_end", run: 2, result: "error", error: "pi unreachable" }, // retired-name-ok: legacy event field in a fixture
  ]);

  const refused = await cli(repo, "history", "--result", "refused");
  assert.equal(refused.code, 0);
  assert.equal(refused.stdout.trim().split("\n").length, 1);
  assert.match(refused.stdout, /feature\s+#1\s+refused/);

  // The refusal no longer lands in the problems bucket.
  const problems = await cli(repo, "history", "--result", "problems");
  assert.equal(problems.code, 0);
  assert.equal(problems.stdout.trim().split("\n").length, 1);
  assert.match(problems.stdout, /bugfix\s+#2\s+error/);
  assert.doesNotMatch(problems.stdout, /feature/);

  // The JSON payload filters to the refused row alone.
  const json = await cli(repo, "history", "--result", "refused", "--json");
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout) as { rows: Array<{ role: string; result: string }> };
  assert.deepEqual(payload.rows.map((r) => [r.role, r.result]), [["feature", "refused"]]);
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

  // A log holding no runs at all: the result filter removed nothing, so naming the class
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
  assert.match(bogus.stderr, /merged, none, refused, problems/);
  assert.match(bogus.stderr, /got "bogus"/);
  assert.ok(!bogus.stderr.includes("did you mean"), bogus.stderr); // not a near-miss

  // A near-miss of a real result gets the did-you-mean, the same typoSuffix `logs --type` gives.
  const typo = await cli(repo, "history", "--result", "mergd");
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /merged, none, refused, problems/);
  assert.match(typo.stderr, /got "mergd"/);
  assert.match(typo.stderr, /did you mean `merged`\?/);
});

test("history --summary tallies each role's outcomes over the rows the table would print", async () => {
  const repo = await seededHistoryRepo();
  const when = formatTimestamp(1787222695956);
  const text = await cli(repo, "history", "--summary");
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout.split("\n").map((l) => l.trimEnd()), [
    "role     runs  changes  none  refused  problems  tokens  peak ctx   cost  time  last change",
    "bugfix      1        0     0        0         1       0         —  $0.00     —  —",
    "clean       1        0     1        0         0       0         —  $0.00     —  —",
    `feature     1        1     0        0         0    2400         —  $0.02    4s  ${when}`,
    `total       3        1     1        0         1    2400         —  $0.02    4s  ${when}`,
    "",
  ]);

  const json = await cli(repo, "history", "--summary", "--json");
  const payload = JSON.parse(json.stdout) as { roles: unknown[]; total: unknown };
  assert.equal(payload.roles.length, 3);
  // The timed feature run #7 (run_start 1787222691956 → run_end 1787222695956) folds a 4s span
  // into the summary; the clean and bugfix runs had no start, so only total and feature carry it.
  assert.deepEqual(payload.total, { role: "total", runs: 3, changes: 1, none: 1, refused: 0, problems: 1, tokens: 2400, costUsd: 0.02, durationMs: 4000, lastChangeTs: 1787222695956 });

  const scoped = await cli(repo, "history", "--summary", "--role", "feature");
  assert.equal(scoped.stdout.trim().split("\n").length, 3);
  assert.match(scoped.stdout, /^feature /m);

  const problems = await cli(repo, "history", "--summary", "--result", "problems");
  // The problems class is the bugfix error run: no start was logged, so its time cell is a dash.
  assert.match(problems.stdout, /^total +1 +0 +0 +0 +1 +0 +— +\$0\.00 +— +—$/m);
  assert.doesNotMatch(problems.stdout, /^clean/m);
});

test("history --summary keeps the empty-state output on an empty log", async () => {
  const repo = makeRepo();
  await initProject(repo, "cli history summary empty");
  assert.equal((await cli(repo, "history", "--summary")).stdout, "no runs yet\n");
  assert.deepEqual(JSON.parse((await cli(repo, "history", "--summary", "--json")).stdout), { rows: [] });
});
