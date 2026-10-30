import test from "node:test";
import assert from "node:assert/strict";
import { collectReport } from "../src/report/report-data.js";
import { collectReportSince } from "../src/report/report-since-data.js";
import { renderReportMarkdown } from "../src/report/report-render.js";
import { atLocalTs as at, dayKey, HOUR, ago, todayTs } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { cli, runCli } from "./helpers/cli-harness.js";

// The `tumwater report` CLI entry point and its --json payloads (see report.test.ts for the
// split): the window bound, the collectors' payloads with their merge fields, and the merge
// outcome breakdowns. Like report.test.ts, assertions match combined stdout+stderr via the
// shared runCli bridge; the few that need the streams apart call cli-harness's cli().

// --- report through the real CLI entry point: main()'s wiring that report.test.ts's
// in-process pins cannot see — report runs WITHOUT a readiness gate (it degrades to zeros in
// any directory) and --days shares /api/report's window bound: above it the command fails fast
// with the offending value instead of building an unbounded series.

test("report prints a zero-filled window outside a repo and honors --days", async () => {
  // No readiness gate: in a bare directory every source degrades to zeros, so the report
  // still renders (an all-zero default window).
  const r = await cli(tmpdir(), "report");
  assert.equal(r.code, 0, `expected exit 0 in any directory:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^# tumwater usage report$/m);
  assert.match(r.stdout, /\(14 days\)/);

  const r2 = await cli(tmpdir(), "report", "--days", "3");
  assert.equal(r2.code, 0, `expected exit 0 with --days 3:\n${r2.stdout}\n${r2.stderr}`);
  assert.match(r2.stdout, /\(3 days\)/);
});

test("report --days above the shared bound fails fast with the offending value", async () => {
  const r = await cli(tmpdir(), "report", "--days", "91");
  assert.equal(r.code, 1, `expected exit 1 for --days 91:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /--days must be between 1 and 90 \(got "91"\)/);

  // The bound itself is allowed — the GUI clamps to it, so the CLI accepts exactly that.
  const ok = await cli(tmpdir(), "report", "--days", "90");
  assert.equal(ok.code, 0, `expected exit 0 at the bound:\n${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /\(90 days\)/);
});

// ---- report --json ----

test("report --json --days prints the collector's payload; the Markdown render is untouched", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(3), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 500, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "run_end", run: 2, result: "no_change", tokens: 42 }), // retired-name-ok: legacy event field in a fixture
  ]);
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned" },
    { heading: "## Done", body: `- Epitaph (planned 2026-09-01, done ${dayKey(at(0))}; commit abc)` },
  ]);

  const json = await runCli(root, "report", "--json", "--days", "4");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out); // one document, parseable, nothing else on the stream
  const direct = collectReport(root, 4);
  assert.deepEqual(parsed, direct, "--json prints the collector's own payload");
  assert.equal(parsed.days, 4);
  assert.equal(parsed.from, dayKey(at(3)));
  assert.equal(parsed.to, dayKey(at(0)));
  assert.equal(parsed.totals.tokensOut, 542);
  assert.equal(parsed.totals.featuresDone, 1);

  // The same fixtures through the Markdown path render identically: --json swapped only the
  // printing, not the collection, so both views agree on the numbers they show.
  const md = await runCli(root, "report", "--days", "4");
  assert.equal(md.code, 0);
  assert.equal(md.out, renderReportMarkdown(direct) + "\n");
  assert.match(md.out, /542 output tokens/);
  assert.match(md.out, /1 features done/);

  const help = await runCli(root, "help", "report");
  assert.equal(help.code, 0);
  assert.match(help.out, /--json/);
});

test("report --since --role omits Estimated by role when the scoped role spent none", async () => {
  const root = makeRepo();
  // The team window has notional spend (plan's run), but feature spends none — scoping to
  // feature must drop the line/field, not render an empty "Estimated by role: -".
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "plan", type: "run_end", run: 1, result: "changed", tokens: 10, notionalCostUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(9 * 60_000), loop: "feature", type: "merged", commit: "abc1234" }), // retired-name-ok: legacy event field in a fixture
  ]);

  const scoped = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /\*\*Commits by role:\*\* feature — 1/);
  assert.ok(!scoped.out.includes("**Estimated by role:"), "a scoped role with no notional omits the line");

  const scopedJson = JSON.parse((await runCli(root, "report", "--role", "feature", "--json", "--since", "6h")).out);
  assert.deepEqual(scopedJson.commitsByRole, { feature: 1 });
  assert.ok(!("notionalByRole" in scopedJson), "the scoped role's JSON carries no notionalByRole");

  const team = await runCli(root, "report", "--since", "6h");
  assert.equal(team.code, 0);
  assert.match(team.out, /\*\*Estimated by role:\*\* plan — \$0\.50/, "the team window still shows the notional spend");
});

test("report --json --since prints the window totals with the coverage proof", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(8 * HOUR), loop: "feature", type: "run_end", run: 2, result: "no_change", tokens: 999 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 777, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const json = await runCli(root, "report", "--json", "--since", "6h");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  // The cutoff instant is the collector's own now, so only its payload fields are pinned;
  // fromIso is checked as a fresh ISO string rather than deep-equalled across two nows.
  const direct = collectReportSince(root, 6 * HOUR);
  assert.equal(parsed.sinceMs, 6 * HOUR);
  assert.notEqual(Date.parse(parsed.fromIso), NaN, "fromIso is an ISO instant");
  assert.deepEqual(parsed.totals, direct.totals);
  assert.deepEqual(parsed.runsByRole, direct.runsByRole);
  assert.deepEqual(parsed.costByRole, direct.costByRole);
  assert.equal(parsed.totals.runs, 1);
  const oldNames = /"(ticks|ticksByRole|failedTicksByRole|landing\w+|landedByRole)"/;
  assert.doesNotMatch(JSON.stringify(parsed), oldNames, "no retired key at any depth");
  assert.equal(parsed.totals.tokensOut, 777);
  assert.deepEqual(parsed.runsByRole, { feature: 1 });
  assert.deepEqual(parsed.commitsByRole, {}, "the since payload carries commitsByRole always");
  assert.ok(!("notionalByRole" in parsed), "notionalByRole is absent when the window has none");
  assert.equal(parsed.coversFullWindow, true, "the log reaches back before the cutoff");
  assert.ok(!("series" in parsed), "the since shape carries totals, not a day series");
});

test("report --json carries the merge fields in totals and the day series", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const json = await runCli(root, "report", "--json", "--days", "2");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.totals.mergeRuns, 1);
  assert.equal(parsed.totals.mergeTokens, 45_200);
  assert.ok(Math.abs(parsed.totals.mergeCostUsd - 0.84) < 1e-9);
  const today = parsed.series[parsed.series.length - 1];
  assert.equal(today.mergeCostUsd, 0.84, "the day series carries mergeCostUsd");
  assert.ok(Math.abs(today.tokensOut - 45_300) < 1e-9, "the day's tokensOut includes the merge share");
});

test("report --json --days carries mergeFailed on the day and totals when a merge fails; merges 2 runs with 1 failed", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_failed", commit: "def5678", summary: "y", tokens: 10_000, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const json = await runCli(root, "report", "--json", "--days", "2");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  // mergeRuns still counts both merged and merge_failed together; mergeFailed names the flops.
  assert.equal(parsed.totals.mergeRuns, 2, "totals.mergeRuns unchanged — counts both outcomes");
  assert.equal(parsed.totals.mergeFailed, 1);
  const today = parsed.series[parsed.series.length - 1];
  assert.equal(today.mergeRuns, 2);
  assert.equal(today.mergeFailed, 1, "the day series carries mergeFailed when that day has one");

  // The merge share's token/cost totals fold both outcomes, untouched by the new counter.
  assert.equal(parsed.totals.mergeTokens, 55_200);
  assert.ok(Math.abs(parsed.totals.mergeCostUsd - 1.34) < 1e-9);

  // The Markdown render names the flop on the same line.
  const md = await runCli(root, "report", "--days", "2");
  assert.match(md.out, /of which merge runs: 2 runs \(1 failed\) · 55\.2k tokens · \$1\.34 \(reviewer \+ conflict resolution\)/);
});

test("report --json leaves mergeFailed absent on a failure-free window", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const parsed = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  assert.equal(parsed.totals.mergeRuns, 1);
  assert.ok(!("mergeFailed" in parsed.totals), "a failure-free window omits totals.mergeFailed");
  assert.ok(!("mergeFailed" in parsed.series[parsed.series.length - 1]), "a failure-free day omits day.mergeFailed");
  const md = await runCli(root, "report", "--days", "2");
  assert.match(md.out, /of which merge runs: 1 runs · 45\.2k tokens · \$0\.84 \(reviewer \+ conflict resolution\)/);
  assert.ok(!md.out.includes("0 failed"), "a failure-free window never prints (0 failed)");
});

test("report --json --since carries mergeFailed when a merge fails and omits it otherwise", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(5 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 100, costUsd: 0.1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(4 * 60_000), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(3 * 60_000), loop: "feature", type: "merge_failed", commit: "def5678", summary: "y", tokens: 10_000, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const parsed = JSON.parse((await runCli(root, "report", "--json", "--since", "6h")).out);
  assert.equal(parsed.totals.mergeRuns, 2);
  assert.equal(parsed.totals.mergeFailed, 1);

  const clean = makeRepo();
  writeEvents(clean, [
    JSON.stringify({ ts: ago(5 * 60_000), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const cleanParsed = JSON.parse((await runCli(clean, "report", "--json", "--since", "6h")).out);
  assert.equal(cleanParsed.totals.mergeRuns, 1);
  assert.ok(!("mergeFailed" in cleanParsed.totals), "a failure-free --since window omits mergeFailed");
});

test("team day report breaks merge outcomes down by role, folding instances into their base", async () => {
  const root = makeRepo();
  // feature-2's destination event must aggregate under feature (the same base-role keying as
  // Commits by role); bufixes' merge_failed bounces off the gate under bugfix.
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature-2", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "merge_failed", commit: "def5678", summary: "y", tokens: 10_000, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Merged by role:\*\* feature — 1/, "merged outcome folds feature-2 into feature");
  assert.match(md.out, /\*\*Merge failures by role:\*\* bugfix — 1/, "the gate's merge_failed names its authoring role");
  // The team totals stay exactly what they were: the per-role maps are a parallel tally.
  assert.match(md.out, /of which merge runs: 2 runs \(1 failed\)/);

  // The collector's day series and window totals carry the per-role maps too (zero-means-absent).
  const direct = collectReport(root, 2);
  const today = direct.series[direct.series.length - 1]!;
  assert.deepEqual(today.mergedByRole, { feature: 1 });
  assert.deepEqual(today.mergeFailedByRole, { bugfix: 1 });
  assert.equal(direct.totals.mergeRuns, 2);
  assert.equal(direct.totals.mergeFailed, 1);
});

test("team day report and --since break merge failures down by reason; scoped and merge-free omit them", async () => {
  const root = makeRepo();
  // Two rejections and a conflict today, a result-less legacy event and a blocked ff
  // yesterday: the reason line ranks count desc then code asc.
  writeEvents(root, [
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "merge_failed", commit: "a1", summary: "x", result: "rejected" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "merge_failed", commit: "a2", summary: "x", result: "rejected" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "bugfix", type: "merge_failed", commit: "b1", summary: "y", result: "merge_conflict" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "docs", type: "merge_failed", commit: "c1", summary: "z" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(1), loop: "feature", type: "merge_failed", commit: "a3", summary: "x", result: "merge_blocked" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Merge failures by role:\*\*/);
  assert.match(md.out, /\*\*Merge failures by reason:\*\* rejected — 2 · merge_blocked — 1 · merge_conflict — 1 · unknown — 1/, "the day report names each result, count desc then code asc");

  const since = await runCli(root, "report", "--since", "2d");
  assert.equal(since.code, 0);
  assert.match(since.out, /\*\*Merge failures by reason:\*\* rejected — 2 · merge_blocked — 1 · merge_conflict — 1 · unknown — 1/, "--since folds the same reasons across the window");

  // The collector's JSON carries the day-series and --since maps.
  const json = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  assert.deepEqual(json.series[json.series.length - 1].mergeFailedByReason, { rejected: 2, merge_conflict: 1, unknown: 1 });
  const sinceJson = JSON.parse((await runCli(root, "report", "--json", "--since", "2d")).out);
  assert.deepEqual(sinceJson.mergeFailedByReason, { rejected: 2, merge_conflict: 1, unknown: 1, merge_blocked: 1 });

  // A role-scoped day and --since report omit the merge lines entirely.
  const scopedDay = await runCli(root, "report", "--role", "feature", "--days", "2");
  assert.ok(!scopedDay.out.includes("**Merge failures by reason:"), "a scoped day report omits the reason line");
  const scopedSince = await runCli(root, "report", "--role", "feature", "--since", "2d");
  assert.ok(!scopedSince.out.includes("**Merge failures by reason:"), "a scoped --since report omits the reason line");
});

test("a merge-free report prints no Merge failures by reason line", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.ok(!md.out.includes("**Merge failures by reason:"), "a merge-free window omits the reason line");
  const since = await runCli(root, "report", "--since", "2d");
  assert.ok(!since.out.includes("**Merge failures by reason:"), "a merge-free --since window omits the reason line");
});

test("team day report omits Merge failures by role when none fail; a merge-free window omits both", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Merged by role:\*\* feature — 1/);
  assert.ok(!md.out.includes("**Merge failures by role:"), "no merge_failed omits the failure line entirely");
});

test("role-scoped day report omits the merge lines (merge runs are the merge slot's)", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--role", "feature", "--days", "2");
  assert.equal(md.code, 0);
  assert.ok(!md.out.includes("**Merged by role:"), "a scoped report omits the merged line");
  assert.ok(!md.out.includes("**Merge failures by role:"), "a scoped report omits the failures line");
  assert.match(md.out, /role scope: merge runs and backlog tallies \(features done \/ bugs fixed \/ plans added \/ bugs filed\) are team-wide and omitted/);
});

test("team report --since breaks merge outcomes by role and the scoped --since omits them; JSON carries the maps", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(5 * 60_000), loop: "feature-2", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(4 * 60_000), loop: "bugfix", type: "merge_failed", commit: "def5678", summary: "y", tokens: 10_000, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--since", "6h");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Merged by role:\*\* feature — 1/, "--since folds feature-2 into feature");
  assert.match(md.out, /\*\*Merge failures by role:\*\* bugfix — 1/);

  const json = JSON.parse((await runCli(root, "report", "--json", "--since", "6h")).out);
  assert.deepEqual(json.mergedByRole, { feature: 1 });
  assert.deepEqual(json.mergeFailedByRole, { bugfix: 1 });

  const scoped = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(scoped.code, 0);
  assert.ok(!scoped.out.includes("**Merged by role:"), "a scoped --since omits the merged line");
  assert.ok(!scoped.out.includes("**Merge failures by role:"), "a scoped --since omits the failures line");
});

test("team report tallies deferred maintenance runs by reason; scoped and deferral-free reports omit them", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: todayTs(5 * 60_000), loop: "feature", type: "run_deferred", reason: "backlog" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(4 * 60_000), loop: "feature", type: "run_deferred", reason: "no-work" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(3 * 60_000), loop: "feature", type: "run_deferred", reason: "backlog" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(2 * 60_000), loop: "feature", type: "run_deferred" }), // no reason: folds as no-work // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(1 * 60_000), loop: "feature", type: "run_deferred", reason: "plans-full" }), // retired-name-ok: legacy event field in a fixture
  ]);
  // The day report prints the tally beside the other per-role breakdowns (count desc, code
  // asc), and --since carries the same window map.
  const md = await runCli(root, "report", "--days", "3");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Deferred runs by reason:\*\* backlog — 2 · no-work — 2 · plans-full — 1/);
  const sinceMd = await runCli(root, "report", "--since", "6h");
  assert.equal(sinceMd.code, 0);
  assert.match(sinceMd.out, /\*\*Deferred runs by reason:\*\* backlog — 2 · no-work — 2 · plans-full — 1/);

  // The day series and --since JSON carry the per-reason map (zero-means-absent).
  const json = JSON.parse((await runCli(root, "report", "--json", "--days", "3")).out);
  assert.deepEqual(json.series[json.series.length - 1].deferredByReason, { backlog: 2, "no-work": 2, "plans-full": 1 });
  const sinceJson = JSON.parse((await runCli(root, "report", "--json", "--since", "6h")).out);
  assert.deepEqual(sinceJson.deferredByReason, { backlog: 2, "no-work": 2, "plans-full": 1 });

  // A reason is not a role, so a role-scoped day and --since omit the line and the field.
  const scoped = await runCli(root, "report", "--role", "feature", "--days", "3");
  assert.ok(!scoped.out.includes("**Deferred runs by reason:"), "a scoped day report omits it");
  const scopedSince = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.ok(!scopedSince.out.includes("**Deferred runs by reason:"), "a scoped --since omits it");
  assert.ok(!("deferredByReason" in JSON.parse((await runCli(root, "report", "--json", "--role", "feature", "--days", "3")).out).series[0]));
  assert.ok(!("deferredByReason" in JSON.parse((await runCli(root, "report", "--json", "--role", "feature", "--since", "6h")).out)));

  // A deferral-free window prints no line and omits the field.
  const clean = makeRepo();
  writeEvents(clean, [JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 1 })]); // retired-name-ok: legacy event field in a fixture
  const cleanMd = await runCli(clean, "report", "--days", "3");
  assert.ok(!cleanMd.out.includes("**Deferred runs by reason:"), "no deferral prints no line");
  assert.ok(!("deferredByReason" in JSON.parse((await runCli(clean, "report", "--json", "--days", "3")).out).series[0]));
});

test("report --json omits mergedByRole/mergeFailedByRole when no role has either; carries them when one does", async () => {
  const clean = makeRepo();
  const cleanParsed = JSON.parse((await runCli(clean, "report", "--json", "--days", "2")).out);
  assert.ok(!("mergedByRole" in cleanParsed.series[cleanParsed.series.length - 1]), "a merge-free day omits mergedByRole");

  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const parsed = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  assert.deepEqual(parsed.series[parsed.series.length - 1].mergedByRole, { feature: 1 });
  // The --since payload always carries both maps, like commitsByRole: a within-window merge
  // fills mergedByRole, and a failure-free window's mergeFailedByRole stays empty.
  const sinceRoot = makeRepo();
  writeEvents(sinceRoot, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "merge_done", commit: "abc1234", summary: "x", tokens: 45_200, costUsd: 0.84 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const since = JSON.parse((await runCli(sinceRoot, "report", "--json", "--since", "6h")).out);
  assert.deepEqual(since.mergedByRole, { feature: 1 });
  assert.deepEqual(since.mergeFailedByRole, {});
});

test("report --failures --json prints the digest's collected data; --since --json stays legal", async () => {
  const root = makeRepo();
  // The digest's FailureReportData is the machine-readable form (the time-and-spend fold gave
  // it a stable shape), so --failures --json prints the collector's own payload — the
  // report --json and doctor --json precedent — instead of refusing the combination.
  const parsed = JSON.parse((await runCli(root, "report", "--failures", "--json")).out) as {
    runs: number;
    lossCauses: unknown[];
  };
  assert.equal(parsed.runs, 0);
  assert.deepEqual(parsed.lossCauses, []);

  // --since --json stays legal: --json composes with every report shape.
  const sinceJson = await runCli(root, "report", "--json", "--since", "6h");
  assert.equal(sinceJson.code, 0);
});

test("report --json carries imageReroutesByRole on the day and --since report that have image reroutes", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "image_reroute", preflight: true }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "qa", type: "image_reroute", preflight: false }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "image_reroute", preflight: false }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--days", "1");
  assert.match(md.out, /\*\*Image reroutes by role:\*\* feature — 2 · qa — 1/);
  const day = JSON.parse((await runCli(root, "report", "--json", "--days", "1")).out);
  assert.deepEqual(day.series[day.series.length - 1].imageReroutesByRole, { feature: 2, qa: 1 });
  const since = JSON.parse((await runCli(root, "report", "--json", "--since", "3h")).out);
  assert.deepEqual(since.imageReroutesByRole, { feature: 2, qa: 1 });
});
