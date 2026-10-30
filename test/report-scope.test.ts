import test from "node:test";
import assert from "node:assert/strict";
import { collectReportSince } from "../src/report/report-since-data.js";
import type { ReportData } from "../src/report/report-types.js";
import { collectFailureReportSince } from "../src/failure/failure-data.js";
import { renderReportMarkdown } from "../src/report/report-render.js";
import { HOUR, ago, todayTs } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";
import { runCli } from "./helpers/cli-harness.js";

// The narrowed reports (see report.test.ts for the split): --role scoping, one role or a
// comma list, and the --since --until window, for the Markdown report, its --json payload and
// the --failures digest.

test("renderReportMarkdown scopes a role report: role line, no backlog tail, scope note", () => {
  const data: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    role: "feature",
    series: [
      { date: "2026-09-09", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 500, runsByRole: { feature: 1 }, costByRole: { feature: 0.5 }, commits: 1, commitsByRole: { feature: 1 }, workCommits: 1, maintenanceCommits: 0, costUsd: 0.5, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 500, runs: 1, commits: 1, costUsd: 0.5, featuresDone: 0, bugsFixed: 0, commitsByRole: { feature: 1 }, workCommits: 1, maintenanceCommits: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  const out = renderReportMarkdown(data);
  assert.match(out, /^role: feature$/m);
  assert.match(out, /^\*\*Totals:\*\* 500 output tokens · 1 runs · 1 commits · \$0\.50$/m);
  assert.ok(!out.includes('features done · 0 bugs fixed'), "the team backlog cells are dropped from the totals line");
  assert.ok(!out.includes("of which merge runs"), "no merge-share line prints");
  assert.match(out, /role scope: merge runs and backlog tallies \(features done \/ bugs fixed \/ plans added \/ bugs filed\) are team-wide and omitted/);
});

test("tumwater report --role scopes the report, scopes --since/--json, and validates the flag", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 313, costUsd: 0.31 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(9 * 60_000), loop: "bugfix", type: "run_end", run: 2, result: "changed", tokens: 42, costUsd: 0.04 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const scoped = await runCli(root, "report", "--role", "feature");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /^role: feature$/m);
  assert.match(scoped.out, /313 output tokens/);
  assert.ok(!scoped.out.includes("42 output tokens"), "the other role's tokens are excluded");
  assert.match(scoped.out, /role scope: merge runs and backlog tallies/);

  const team = await runCli(root, "report");
  assert.ok(!/^role:/m.test(team.out), "the team report carries no role line");

  const json = JSON.parse((await runCli(root, "report", "--role", "feature", "--json")).out) as {
    role?: string;
    totals: { tokensOut: number };
  };
  assert.equal(json.role, "feature");
  assert.equal(json.totals.tokensOut, 313);

  const since = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(since.code, 0);
  assert.match(since.out, /^role: feature$/m);
  assert.match(since.out, /role scope: merge runs and backlog tallies/);
  // The scope note already states the backlog-tally omission, so the --days pointer (which
  // would imply a scoped day report shows tallies it too omits) must not also print.
  assert.ok(!since.out.includes("need the day report"), "scoped --since does not repeat the --days tally pointer");

  const bogus = await runCli(root, "report", "--role", "bogus");
  assert.notEqual(bogus.code, 0);
  assert.match(bogus.out, /unknown role: bogus/);

  // --role now scopes the failure digest too: the old rival-shape rejection is retired.
  const scopedFailures = await runCli(root, "report", "--role", "feature", "--failures");
  assert.equal(scopedFailures.code, 0);
  assert.match(scopedFailures.out, /^role: feature$/m);
  const failuresJson = JSON.parse(
    (await runCli(root, "report", "--failures", "--role", "feature", "--json")).out,
  ) as { role?: string };
  assert.equal(failuresJson.role, "feature");

  const scopedSince = await runCli(root, "report", "--failures", "--role", "feature", "--since", "6h");
  assert.equal(scopedSince.code, 0);
  assert.match(scopedSince.out, /^role: feature$/m);

  const bogusFailures = await runCli(root, "report", "--failures", "--role", "bogus");
  assert.notEqual(bogusFailures.code, 0);
  assert.match(bogusFailures.out, /unknown role: bogus/);

  const trailing = await runCli(root, "report", "--role");
  assert.notEqual(trailing.code, 0);
  assert.match(trailing.out, /--role needs a role id/);
});

test("report --role takes a comma list and sums the listed roles", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: todayTs(30 * 60_000), loop: "clean", type: "run_end", run: 1, result: "changed", tokens: 10, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(20 * 60_000), loop: "dedupe", type: "run_end", run: 1, result: "changed", tokens: 20, costUsd: 0.25 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 40, costUsd: 1 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const day = JSON.parse((await runCli(root, "report", "--role", "clean,dedupe", "--json", "--days", "1")).out);
  assert.equal(day.role, "clean,dedupe");
  const today = day.series[day.series.length - 1];
  assert.deepEqual(Object.keys(today.runsByRole).sort(), ["clean", "dedupe"]);
  assert.deepEqual(Object.keys(today.costByRole).sort(), ["clean", "dedupe"]);
  assert.equal(today.tokensOut, 30);
  assert.equal(today.costUsd, 0.75);

  const since = JSON.parse((await runCli(root, "report", "--role", "clean,dedupe", "--json", "--since", "6h")).out);
  assert.equal(since.totals.runs, 2);
  const md = await runCli(root, "report", "--role", "clean,dedupe", "--since", "6h");
  assert.equal(md.code, 0);
  assert.match(md.out, /role: clean,dedupe/);

  const dup = JSON.parse((await runCli(root, "report", "--role", "dedupe,clean,dedupe", "--json", "--days", "1")).out);
  assert.equal(dup.role, "dedupe,clean");
});

test("report --failures --role takes a comma list and scopes the digest to those roles", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "clean", type: "run_end", run: 1, result: "error", tokens: 1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(20 * 60_000), loop: "dedupe", type: "run_end", run: 1, result: "error", tokens: 1 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "error", tokens: 1 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const out = await runCli(root, "report", "--failures", "--role", "clean,dedupe", "--json");
  assert.equal(out.code, 0);
  const digest = JSON.parse(out.out);
  assert.equal(digest.role, "clean,dedupe");
  assert.ok(digest.outcomes.length > 0);
  assert.ok(!JSON.stringify(digest.outcomes).includes("feature"));
});

test("report --role rejects an unknown id and an empty list in a comma list", async () => {
  const root = makeRepo();
  const ghost = await runCli(root, "report", "--role", "clean,ghost");
  assert.notEqual(ghost.code, 0);
  assert.match(ghost.out, /unknown role: ghost/);
  const empty = await runCli(root, "report", "--role", ",");
  assert.notEqual(empty.code, 0);
  assert.match(empty.out, /--role needs a role id/);
});

function seedWindowEvents(root: string): void {
  writeEvents(root, [
    JSON.stringify({ ts: ago(8 * HOUR), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 999 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(3 * HOUR), loop: "feature", type: "run_end", run: 2, result: "changed", tokens: 555, costUsd: 0.25 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(HOUR / 2), loop: "feature", type: "run_end", run: 3, result: "changed", tokens: 777 }), // retired-name-ok: legacy event field in a fixture
  ]);
}

test("report --since --until totals only the events between the two edges", async () => {
  const root = makeRepo();
  seedWindowEvents(root);
  const md = await runCli(root, "report", "--since", "6h", "--until", "1h");
  assert.equal(md.code, 0);
  assert.match(md.out, /window: 6h to 1h ago \(since .*, until .*\)/);
  assert.match(md.out, /555 output tokens/);
  assert.doesNotMatch(md.out, /777|999/);
  const json = JSON.parse((await runCli(root, "report", "--since", "6h", "--until", "1h", "--json")).out);
  assert.equal(json.untilMs, HOUR);
  assert.equal(typeof json.toIso, "string");
  assert.equal(json.totals.tokensOut, 555);
  const open = JSON.parse((await runCli(root, "report", "--since", "6h", "--json")).out);
  assert.ok(!("untilMs" in open) && !("toIso" in open), "an unbounded window omits the until keys");
});

test("collectReportSince with untilMs drops events at or after the window end", () => {
  const root = makeRepo();
  seedWindowEvents(root);
  assert.equal(collectReportSince(root, 6 * HOUR, undefined, HOUR).totals.tokensOut, 555);
  assert.equal(collectReportSince(root, 6 * HOUR).totals.tokensOut, 1332);
});

test("report --until is refused without --since, and when not shorter", async () => {
  const root = makeRepo();
  const cases: Array<[string[], RegExp]> = [
    [["--until", "1h"], /report --until requires --since/],
    [["--since", "1h", "--until", "2h"], /report --until \(.*\) must be shorter than --since/],
    [["--since", "1h", "--until", "1h"], /report --until \(.*\) must be shorter than --since/],
    [["--since", "6h", "--until", "6h", "--failures"], /report --until \(.*\) must be shorter than --since/],
    [["--since", "6h", "--until"], /report --until needs a value/],
  ];
  for (const [flags, re] of cases) {
    const r = await runCli(root, "report", ...flags);
    assert.notEqual(r.code, 0, flags.join(" "));
    assert.match(r.out, re, flags.join(" "));
  }
  assert.match((await runCli(root, "help", "report")).out, /--until <duration>/);
});

function seedBoundedFailures(root: string): void {
  writeEvents(root, [
    { ts: ago(8 * HOUR), error: "prior-a" },
    { ts: ago(3 * HOUR), error: "current-b" },
    { ts: ago(HOUR / 2), error: "after-c" },
  ].map((e, i) => JSON.stringify({ ...e, loop: "feature", type: "run_end", run: i + 1, result: "error" }))); // retired-name-ok: legacy event field in a fixture
}

test("report --failures --since --until digests only the bounded window and compares the same length before", async () => {
  const root = makeRepo();
  seedBoundedFailures(root);
  const md = await runCli(root, "report", "--failures", "--since", "6h", "--until", "1h");
  assert.equal(md.code, 0, md.out);
  assert.match(md.out, /window: 6h to 1h ago \(since .*, until .*\) · 1 runs/);
  assert.match(md.out, /## Deltas vs the preceding 5h/);
  const json = JSON.parse((await runCli(root, "report", "--failures", "--since", "6h", "--until", "1h", "--json")).out) as {
    runs: number;
    untilMs: number;
    toIso: unknown;
    deltas: Array<{ role: string; runs: number; prevRuns: number }>;
  };
  assert.equal(json.runs, 1);
  assert.equal(json.untilMs, HOUR);
  assert.equal(typeof json.toIso, "string");
  const row = json.deltas.find((d) => d.role === "feature");
  assert.equal(row?.runs, 1);
  assert.equal(row?.prevRuns, 1);
});

test("collectFailureReportSince with untilMs drops events at or after the window end", () => {
  const root = makeRepo();
  seedBoundedFailures(root);
  assert.equal(collectFailureReportSince(root, 6 * HOUR, undefined, HOUR).runs, 1);
  const unbounded = collectFailureReportSince(root, 6 * HOUR);
  assert.equal(unbounded.runs, 2);
  assert.ok(!("untilMs" in unbounded));
});
