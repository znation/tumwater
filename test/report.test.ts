import test from "node:test";
import assert from "node:assert/strict";
import { collectReport, collectReportSince } from "../src/report/report-data.js";
import type { ReportData } from "../src/report/report-types.js";
import { collectFailureReportSince } from "../src/failure/failure-data.js";
import { renderReportMarkdown, renderSinceReportMarkdown } from "../src/report/report-render.js";
import { atLocalTs as at, dayKey, HOUR, ago, todayTs } from "./helpers/oracles.js";
import { writeEvents } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir, writeBacklogFile } from "./fixtures/repo-fixtures.js";
import { cli, runCli } from "./helpers/cli-harness.js";

// The usage collectors' unit tests (collectReport, collectReportSince) live in
// test/report-data.test.ts; this file pins the Markdown renders and the `tumwater report`
// CLI surface over them.

test("renderReportMarkdown pins the header, totals, table shape, and role line", () => {
  const from = "2026-09-08";
  const to = "2026-09-10";
  const data: ReportData = {
    days: 3,
    from,
    to,
    series: [
      { date: "2026-09-08", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-09", tokensOut: 600_000, runsByRole: { feature: 3, bugfix: 1 }, costByRole: {}, commits: 2, costUsd: 0.86, featuresDone: 1, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 1_234_567, runsByRole: { feature: 2 }, costByRole: {}, commits: 1, costUsd: 1.48, featuresDone: 0, bugsFixed: 1 },
    ],
    totals: { tokensOut: 1_834_567, runs: 6, commits: 3, costUsd: 2.34, featuresDone: 1, bugsFixed: 1, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  const lines = renderReportMarkdown(data).split("\n");

  assert.equal(lines[0], "# tumwater usage report");
  assert.equal(lines[1], "");
  assert.equal(lines[2], `Window: ${from} → ${to} (3 days) · source: events.jsonl (rotated at 16 MB, 5 kept)`);
  assert.equal(lines[3], "");
  assert.equal(
    lines[4],
    "**Totals:** 1.8M output tokens · 6 runs · 3 commits · $2.34 · 1 features done · 1 bugs fixed",
  );
  assert.equal(lines[5], "");
  assert.equal(lines[6], "| day | tokens out | runs | commits | cost |");
  assert.equal(lines[7], "| --- | ---: | ---: | ---: | ---: |");
  // Zero day: no bar, token count as-is.
  assert.equal(lines[8], `| 09-08 | 0 | 0 | 0 | $0.00 |`);
  // Middle day: one decimal + k suffix; bar = round(20·600000/1234567) = 10 blocks.
  assert.equal(lines[9], `| 09-09 | 600.0k ${"█".repeat(10)} | 4 | 2 | $0.86 |`);
  // Max day: exactly 20 blocks; M suffix above a million.
  assert.equal(lines[10], `| 09-10 | 1.2M ${"█".repeat(20)} | 2 | 1 | $1.48 |`);
  assert.equal(lines[11], "");
  // Window totals per role: feature 3+2=5 before bugfix 1 (count desc); the cost line under
  // it renders "-" — no role in this fixture carries spend.
  assert.equal(lines[12], "**Runs by role:** feature — 5 · bugfix — 1");
  assert.equal(lines[13], "**Tokens by role:** -", "no token spend renders '-' like the cost line");
  assert.equal(lines[14], "**Cost by role:** -");
  assert.equal(lines[15], "**Rejections by role:** -", "no rejections renders the line as '-', the shared zero-means-absent convention");
  assert.equal(lines[16], "**Post-merge rejections by role:** -", "no post-merge rejections renders the line as '-', its sibling's convention");
});

test("renderReportMarkdown appends the window's newly filed plans and bugs to the totals line", () => {
  const data: ReportData = {
    days: 3,
    from: "2026-09-08",
    to: "2026-09-10",
    series: [
      { date: "2026-09-08", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, plansAdded: 1, bugsFiled: 1 },
      { date: "2026-09-09", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, plansAdded: 1 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0, plansAdded: 2, bugsFiled: 1 },
    coversFullWindow: true,
  };
  const lines = renderReportMarkdown(data).split("\n");
  assert.equal(
    lines[4],
    "**Totals:** 0 output tokens · 0 runs · 0 commits · $0.00 · 0 features done · 0 bugs fixed · 2 plans added · 1 bugs filed",
  );
});

test("renderReportMarkdown prints a Rejections by role line ranked by count, only when rejections exist", () => {
  const md = renderReportMarkdown({
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", tokensOut: 0, runsByRole: {}, costByRole: {}, rejectionsByRole: { feature: 1 }, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 0, runsByRole: {}, costByRole: {}, rejectionsByRole: { feature: 2, qa: 1 }, postMergeRejectionsByRole: { feature: 2 }, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  });
  assert.match(md, /\*\*Rejections by role:\*\* feature — 3 · qa — 1/, "window rejections rank by count desc then name asc");
  assert.match(md, /\*\*Post-merge rejections by role:\*\* feature — 2/, "the post-merge line ranks its afterMerge subset like its sibling");
});

test("report folds revision events into Revisions by role, beside Rejections by role", async () => {
  const root = makeRepo();
  // One rejection yesterday; two revisions today, on distinct roles. The window's day report
  // must render rejections and revisions as two independent lines, and --json must carry the
  // new revisionsByRole field only on the day(s) that have one (zero-means-absent).
  writeEvents(root, [
    JSON.stringify({ ts: at(1), loop: "feature", type: "review_rejected" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "revision", action: "applied", round: 1, sha: "abc" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "clean", type: "revision", action: "conflict", round: 2, sha: "def" }), // retired-name-ok: legacy event field in a fixture
  ]);

  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Rejections by role:\*\* feature — 1/);
  assert.match(md.out, /\*\*Revisions by role:\*\* clean — 1 · feature — 1/, "revisions fold as their own line, ranked desc then name asc like rejections");

  const json = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  const today = json.series[1];
  const yesterday = json.series[0];
  assert.deepEqual(today.revisionsByRole, { feature: 1, clean: 1 }, "--json carries revisionsByRole on the day that has them");
  assert.ok(!("revisionsByRole" in yesterday), "a day with no revision carries no revisionsByRole key (zero means absent)");
  assert.equal(yesterday.rejectionsByRole?.feature, 1, "the rejection still lands on its own day");
});

test("report renders 'Revisions by role: -' when the window has no revision events", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 10 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--days", "1");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Revisions by role:\*\* -/, "no revisions render the line as '-', the zero-means-absent convention");
});

test("report --since narrows Revisions by role to the scoped base role", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "revision", action: "applied", round: 1, sha: "abc" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "clean", type: "revision", action: "conflict", round: 1, sha: "def" }), // retired-name-ok: legacy event field in a fixture
  ]);

  const team = await runCli(root, "report", "--since", "6h");
  assert.equal(team.code, 0);
  assert.match(team.out, /\*\*Revisions by role:\*\* clean — 1 · feature — 1/, "the team window sums both roles' revisions, ranked name asc on a tie");

  const scoped = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /\*\*Revisions by role:\*\* feature — 1/, "scoping --since narrows revisions to the base role");
  const scopedJson = JSON.parse((await runCli(root, "report", "--role", "feature", "--json", "--since", "6h")).out);
  assert.deepEqual(scopedJson.revisionsByRole, { feature: 1 }, "the scoped since JSON narrows revisionsByRole");

  const cleanNone = await runCli(root, "report", "--role", "bugfix", "--since", "6h");
  assert.equal(cleanNone.code, 0);
  assert.match(cleanNone.out, /\*\*Revisions by role:\*\* -/, "a scoped role with no revisions carries an empty map that renders '-'");
});

test("report folds error-class run_ends into Failed runs by role, beside Revisions by role", async () => {
  const root = makeRepo();
  // Two failed runs today on distinct roles (one hard error, one merge_conflict), a clean
  // run yesterday, and one revision. The day report must fold the failing run_ends into
  // their own line, --json must carry failedRunsByRole only on the day that has failures
  // (zero-means-absent), and the failed tally must never subtract from Runs by role.
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "error", tokens: 10 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "clean", type: "run_end", run: 2, result: "merge_conflict", tokens: 5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(1), loop: "feature", type: "run_end", run: 3, result: "changed", tokens: 20 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "revision", action: "applied", round: 1, sha: "abc" }), // retired-name-ok: legacy event field in a fixture
  ]);

  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Failed runs by role:\*\* clean — 1 · feature — 1/, "error-class run_ends fold as their own line, ranked desc then name asc");
  assert.match(md.out, /\*\*Revisions by role:\*\* feature — 1/, "revisions stay on their own line");
  assert.match(md.out, /\*\*Runs by role:\*\* feature — 2 · clean — 1/, "the failed runs still count in Runs by role (never subtracted)");

  const json = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  const today = json.series[1];
  const yesterday = json.series[0];
  assert.deepEqual(today.failedRunsByRole, { feature: 1, clean: 1 }, "--json carries failedRunsByRole on the day that has them");
  assert.ok(!("failedRunsByRole" in yesterday), "a day with no failure carries no failedRunsByRole key (zero means absent)");
});

test("report --since folds failed runs by role and narrows to the scoped base role", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "run_end", run: 1, result: "error", tokens: 10 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "clean", type: "run_end", run: 2, result: "no_change", tokens: 5 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const team = await runCli(root, "report", "--since", "6h");
  assert.equal(team.code, 0);
  assert.match(team.out, /\*\*Failed runs by role:\*\* feature — 1/, "the team window counts only the error-class role (no_change is not a failure)");

  const scoped = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /\*\*Failed runs by role:\*\* feature — 1/, "scoping --since narrows failed runs to the base role");
  const scopedJson = JSON.parse((await runCli(root, "report", "--role", "feature", "--json", "--since", "6h")).out);
  assert.deepEqual(scopedJson.failedRunsByRole, { feature: 1 }, "the scoped since JSON narrows failedRunsByRole");

  const cleanNone = await runCli(root, "report", "--role", "clean", "--since", "6h");
  assert.equal(cleanNone.code, 0);
  assert.match(cleanNone.out, /\*\*Failed runs by role:\*\* -/, "a scoped role with no failures renders '-'");
});

test("report folds refused run_ends into Refusals by role, beside Revisions by role", async () => {
  const root = makeRepo();
  // Two refusals today on distinct roles, plus one clean run_end today and one revision. A
  // refusal is a deliberate outcome (result "refused") — not error-class — so it gets its own
  // line and must never join Failed runs by role, while Runs by role still counts it.
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "refused", tokens: 10 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "clean", type: "run_end", run: 2, result: "refused", tokens: 5 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "run_end", run: 3, result: "changed", tokens: 20 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "revision", action: "applied", round: 1, sha: "abc" }), // retired-name-ok: legacy event field in a fixture
  ]);

  const md = await runCli(root, "report", "--days", "2");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Refusals by role:\*\* clean — 1 · feature — 1/, "refused run_ends fold as their own line, ranked desc then name asc");
  assert.match(md.out, /\*\*Revisions by role:\*\* feature — 1/, "revisions stay on their own line");
  assert.match(md.out, /\*\*Runs by role:\*\* bugfix — 1 · clean — 1 · feature — 1/, "the refused runs still count in Runs by role (never subtracted)");
  assert.match(md.out, /\*\*Failed runs by role:\*\* -/, "a refusal is not error-class, so Failed runs by role stays empty");

  const json = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  const today = json.series[1];
  assert.deepEqual(today.refusalsByRole, { feature: 1, clean: 1 }, "--json carries refusalsByRole on the day that has them");
  assert.ok(!("failedRunsByRole" in today), "a refused run is not error-class, so no failedRunsByRole key");
});

test("report --since folds refused runs by role and narrows to the scoped base role", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "run_end", run: 1, result: "refused", tokens: 10 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "clean", type: "run_end", run: 2, result: "refused", tokens: 5 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const team = await runCli(root, "report", "--since", "6h");
  assert.equal(team.code, 0);
  assert.match(team.out, /\*\*Refusals by role:\*\* clean — 1 · feature — 1/, "the team window sums both roles' refusals, ranked name asc on a tie");

  const scoped = await runCli(root, "report", "--role", "feature", "--since", "6h");
  assert.equal(scoped.code, 0);
  assert.match(scoped.out, /\*\*Refusals by role:\*\* feature — 1/, "scoping --since narrows refusals to the base role");
  const scopedJson = JSON.parse((await runCli(root, "report", "--role", "feature", "--json", "--since", "6h")).out);
  assert.deepEqual(scopedJson.refusalsByRole, { feature: 1 }, "the scoped since JSON narrows refusalsByRole");
});

test("renderReportMarkdown prints the fixed bugs' Validation gaps as a team-only line", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: base.series,
    totals: { ...base.totals, validationGapsByTag: { "no-repro": 2, "no-fake": 1 } },
  };
  const md = renderReportMarkdown(data);
  // Count desc then name asc, printed right after the Commits line.
  assert.match(md, /\*\*Validation gaps:\*\* no-repro — 2 · no-fake — 1/);
  const commitIdx = md.indexOf("**Commits:");
  const gapIdx = md.indexOf("**Validation gaps:");
  assert.ok(gapIdx > commitIdx, "the Validation gaps line follows the Commits line");

  // A role-scoped report or an empty tally prints no such line.
  const scoped: ReportData = { ...base, role: "bugfix", totals: { ...base.totals, validationGapsByTag: { "no-repro": 1 } } };
  assert.ok(!renderReportMarkdown(scoped).includes("**Validation gaps:"));
  const emptyTags: ReportData = { ...base, totals: { ...base.totals, validationGapsByTag: {} } };
  assert.ok(!renderReportMarkdown(emptyTags).includes("**Validation gaps:"));
  const noTags: ReportData = { ...base };
  assert.ok(!renderReportMarkdown(noTags).includes("**Validation gaps:"));
});

test("renderReportMarkdown prints the Backlog lag median line per day that carries one, team-only", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: [
      { ...base.series[0]!, backlogLagMedianDays: 3 },
      base.series[1]!,
    ],
  };
  const md = renderReportMarkdown(data);
  const lagIdx = md.indexOf("**Backlog lag median:");
  assert.ok(lagIdx >= 0, "a day carrying the field prints the line");
  const commitIdx = md.indexOf("**Commits:");
  assert.ok(lagIdx > commitIdx, "the Backlog lag median line follows the Commits line");
  assert.match(md, new RegExp("\\*\\*Backlog lag median:\\*\\* " + base.series[0]!.date.slice(5) + " 3d"));

  // No day carrying the field prints no line.
  const noLag: ReportData = { ...base };
  assert.ok(!renderReportMarkdown(noLag).includes("**Backlog lag median:"));
  // A role-scoped report never prints the line (a lag has no role).
  const scoped: ReportData = { ...base, role: "bugfix" };
  assert.ok(!renderReportMarkdown(scoped).includes("**Backlog lag median:"));
});

test("renderReportMarkdown prints commits by role and the work/maintenance split with commits per item", () => {
  const data: ReportData = {
    days: 1,
    from: "2026-09-10",
    to: "2026-09-10",
    series: [
      { date: "2026-09-10", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 5, commitsByRole: { clean: 3, feature: 2 }, workCommits: 2, maintenanceCommits: 3, costUsd: 0, featuresDone: 1, bugsFixed: 1 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 5, commitsByRole: { clean: 3, feature: 2 }, workCommits: 2, maintenanceCommits: 3, costUsd: 0, featuresDone: 1, bugsFixed: 1, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  const md = renderReportMarkdown(data);
  assert.match(md, /\*\*Commits by role:\*\* clean — 3 · feature — 2/);
  assert.match(md, /\*\*Commits:\*\* 2 work \/ 3 maintenance · 2\.5 commits per backlog item/);
});

test("renderReportMarkdown shows the merge line under Totals only when merge ran", () => {
  const base = collectReport(tmpdir(), 2);
  // Zero merge runs: the line is omitted entirely, so a team with no merge spend
  // renders byte-identically to the pre-merge-line shape.
  assert.ok(!renderReportMarkdown(base).includes("merge runs"));
  const data: ReportData = {
    ...base,
    totals: { ...base.totals, tokensOut: 45_500, costUsd: 0.95, mergeRuns: 12, mergeTokens: 45_200, mergeCostUsd: 0.84 },
  };
  assert.match(
    renderReportMarkdown(data),
    /of which merge runs: 12 runs · 45\.2k tokens · \$0\.84 \(reviewer \+ conflict resolution\)/,
  );
});

test("renderReportMarkdown shows (N failed) on the merge line only when some merge failed", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    totals: {
      ...base.totals,
      tokensOut: 45_500, costUsd: 0.95, mergeRuns: 12, mergeFailed: 3, mergeTokens: 45_200, mergeCostUsd: 0.84,
    },
  };
  assert.match(
    renderReportMarkdown(data),
    /of which merge runs: 12 runs \(3 failed\) · 45\.2k tokens · \$0\.84 \(reviewer \+ conflict resolution\)/,
  );
  // Zero failures: the annotation stays off — a merge-ful but failure-free line is untouched.
  const clean: ReportData = {
    ...base,
    totals: { ...base.totals, tokensOut: 45_500, costUsd: 0.95, mergeRuns: 12, mergeTokens: 45_200, mergeCostUsd: 0.84 },
  };
  assert.match(
    renderReportMarkdown(clean),
    /of which merge runs: 12 runs · 45\.2k tokens · \$0\.84 \(reviewer \+ conflict resolution\)/,
  );
  assert.ok(!renderReportMarkdown(clean).includes("0 failed"), "a failure-free line never prints (0 failed)");
});

test("renderReportMarkdown renders token counts through the shared compactTokens rule", () => {
  const data: ReportData = {
    days: 1,
    from: "2026-09-10",
    to: "2026-09-10",
    series: [
      { date: "2026-09-10", tokensOut: 1_500, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 1_500, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  const md = renderReportMarkdown(data);
  // compactTokens leaves values below 10k bare (the report's old private copy suffixed them at
  // 1k); pin the shared rule so the table and totals cannot drift from the status table again.
  assert.match(md, /\| 09-10 \| 1500 █{20} \| 0 \| 0 \| \$0\.00 \|/);
  assert.match(md, /\*\*Totals:\*\* 1500 output tokens/);
});

test("renderReportMarkdown shows a one-day window as one whole day, matching the failure digest", () => {
  const data: ReportData = {
    days: 1,
    from: "2026-09-10",
    to: "2026-09-10",
    series: [
      { date: "2026-09-10", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(data), /^Window: 2026-09-10 → 2026-09-10 \(1 day\) · source: events\.jsonl \(rotated at 16 MB, 5 kept\)$/m);
});

test("renderReportMarkdown shows no bars for an all-zero window and min width 1 above zero", () => {
  const data = collectReport(tmpdir(), 3); // every source missing → all zeros
  const md = renderReportMarkdown(data);
  assert.ok(!md.includes("█"), "no bars when every day is zero");
  for (const d of data.series) {
    assert.match(md, new RegExp(`\\| ${d.date.slice(5)} \\| 0 \\| 0 \\| 0 \\| \\$0\\.00 \\|`));
  }
  assert.match(md, /\*\*Runs by role:\*\* -/);

  // <1000 renders as-is; a nonzero day below the max still gets one block (min width).
  const tweaked: ReportData = {
    ...data,
    series: data.series.map((d) => ({
      ...d,
      tokensOut: d.date === data.to ? 999 : d.date === data.from ? 1 : 0,
    })),
    totals: { ...data.totals, tokensOut: 1000 },
  };
  const md2 = renderReportMarkdown(tweaked);
  assert.match(md2, new RegExp(`\\| ${data.to.slice(5)} \\| 999 ${"█".repeat(20)} \\|`));
  assert.match(md2, new RegExp(`\\| ${data.from.slice(5)} \\| 1 █ \\|`));
});

test("renderReportMarkdown orders the role line by count desc then name asc", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: [
      { date: base.from, tokensOut: 0, runsByRole: { zeta: 5, alpha: 5 }, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: base.to, tokensOut: 0, runsByRole: { beta: 2 }, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { ...base.totals, runs: 12 },
  };
  assert.match(renderReportMarkdown(data), /\*\*Runs by role:\*\* alpha — 5 · zeta — 5 · beta — 2/);
});

test("renderReportMarkdown prints a Cost by role line ranked by spend desc then name asc", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: [
      { date: base.from, tokensOut: 0, runsByRole: { feature: 3, zeta: 1 }, costByRole: { feature: 0.3 }, commits: 0, costUsd: 0.3, featuresDone: 0, bugsFixed: 0 },
      { date: base.to, tokensOut: 0, runsByRole: { bugfix: 1 }, costByRole: { alpha: 0.9, bugfix: 0.9, feature: 0 }, commits: 0, costUsd: 1.8, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { ...base.totals, runs: 5, costUsd: 2.1 },
  };
  const md = renderReportMarkdown(data);
  // Ranked by spend (the two $0.90 roles first), not by run count — feature leads the runs
  // line with 3 runs but sits last on the cost line; equal spend breaks by name asc (alpha
  // before bugfix). zeta has runs but no spend, and feature's $0 entry: both omitted.
  assert.match(md, /\*\*Cost by role:\*\* alpha — \$0\.90 · bugfix — \$0\.90 · feature — \$0\.30/);
  assert.match(md, /\*\*Runs by role:\*\* feature — 3 · bugfix — 1 · zeta — 1/);
  // The window's role split sums exactly to the Totals cost (both sourced from run_end alone).
  assert.match(md, /\*\*Totals:\*\* 0 output tokens · 5 runs · 0 commits · \$2\.10 ·/);
});

test("renderReportMarkdown folds providerCost into Cost by provider and Estimated by provider, team-only", () => {
  const root = makeRepo();
  // A multi-provider day: the default provider's real spend and a claude subscription seam's
  // notional spend ride two run_ends' providerCost, and a merge's reviewer spend keys to
  // the reviewer's provider.
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 10, costUsd: 1.5, providerCost: { deepinfra: { costUsd: 1.5, notionalCostUsd: 0 } } }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "clean", type: "run_end", run: 2, result: "changed", tokens: 20, notionalCostUsd: 2, providerCost: { claude: { costUsd: 0, notionalCostUsd: 2 } } }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "feature", type: "merge_done", commit: "abc1234", tokens: 5, costUsd: 0.4, providerCost: { claude: { costUsd: 0.4, notionalCostUsd: 0 } } }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = renderReportMarkdown(collectReport(root, 2));
  // The parallel provider line: real spend per provider, the merge's reviewer spend folding
  // under claude, ranked by spend desc then name asc.
  assert.match(md, /\*\*Cost by provider:\*\* deepinfra — \$1\.50 · claude — \$0\.40/);
  // A subscription seam's API-equivalent spend lands on its own notional provider line.
  assert.match(md, /\*\*Estimated by provider:\*\* claude — \$2\.00/);
  // The provider maps are a parallel tally, never subtracted: the per-role lines keep their
  // exact current values (Cost by role from run_end costByRole alone — clean's notional run
  // adds no real costByRole entry), and the totals still sum the merge share.
  assert.match(md, /\*\*Cost by role:\*\* feature — \$1\.50/);
  assert.match(md, /\*\*Totals:\*\* 35 output tokens · 2 runs · 0 commits · \$1\.90 ·/);
  // A role-scoped report prints no provider line — a provider is not a role, so the attribution
  // is team-only (ROLE_SCOPE_NOTE stays unchanged).
  const scoped = renderReportMarkdown(collectReport(root, 2, "feature"));
  assert.ok(!scoped.includes("Cost by provider"), "a role-scoped report omits the provider line");
});

test("report omits Cost by provider and the provider JSON maps when no event carries providerCost", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 10, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = renderReportMarkdown(collectReport(root, 2));
  assert.ok(!md.includes("Cost by provider"), "no providerCost renders no provider line");
  assert.ok(!md.includes("Estimated by provider"), "nor a notional provider line");
  const json = JSON.parse((await runCli(root, "report", "--json", "--days", "2")).out);
  const day = json.series.find((d: { date: string }) => d.date === dayKey(at(0)));
  assert.ok(!("costByProvider" in day), "report --json omits costByProvider when no provider spent");
  assert.ok(!("notionalByProvider" in day), "and notionalByProvider");
});

test("--since sums per-provider spend across the window into Cost by provider", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(5 * HOUR), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 10, costUsd: 0.5, providerCost: { deepinfra: { costUsd: 0.5, notionalCostUsd: 0 } } }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(2 * HOUR), loop: "bugfix", type: "run_end", run: 2, result: "changed", tokens: 8, costUsd: 0.5, providerCost: { deepinfra: { costUsd: 0.5, notionalCostUsd: 0 } } }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(HOUR), loop: "plan", type: "run_end", run: 3, result: "changed", tokens: 5, notionalCostUsd: 1, providerCost: { claude: { costUsd: 0, notionalCostUsd: 1 } } }), // retired-name-ok: legacy event field in a fixture
  ]);
  const json = JSON.parse((await runCli(root, "report", "--json", "--since", "6h")).out);
  // Summed across the window like costByRole: both deepinfra runs fold into one provider cell.
  assert.deepEqual(json.costByProvider, { deepinfra: 1 });
  assert.deepEqual(json.notionalByProvider, { claude: 1 });
  const md = await runCli(root, "report", "--since", "6h");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Cost by provider:\*\* deepinfra — \$1\.00/);
  assert.match(md.out, /\*\*Estimated by provider:\*\* claude — \$1\.00/);
});

test("renderReportMarkdown prints a Tokens by role line ranked by tokens desc, its own data", () => {
  const base = collectReport(tmpdir(), 2);
  const data: ReportData = {
    ...base,
    series: [
      // alpha carries 4000 tokens but spends $0 — it must lead the tokens line while the
      // cost line omits it, proving the tokens line renders its own data.
      { date: base.from, tokensOut: 0, runsByRole: { feature: 5, alpha: 1 }, tokensByRole: { alpha: 4000, feature: 5000 }, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: base.to, tokensOut: 0, runsByRole: { bugfix: 1 }, tokensByRole: { feature: 7000, beta: 800 }, costByRole: { beta: 0.5 }, commits: 0, costUsd: 0.5, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { ...base.totals, runs: 7, costUsd: 0.5 },
  };
  const md = renderReportMarkdown(data);
  // feature 5000+7000 = 12.0k, alpha 4000, beta 800 — ranked tokens desc then name asc.
  assert.match(md, /\*\*Tokens by role:\*\* feature — 12\.0k · alpha — 4000 · beta — 800/);
  // alpha holds 4000 tokens but spent $0, so it leads the tokens line while the cost line
  // omits it — the two lines render different data, not a re-render of Cost by role.
  assert.match(md, /\*\*Cost by role:\*\* beta — \$0\.50/);
});

// This file's assertions match combined stdout+stderr via the shared runCli bridge; a few
// assertions need the streams apart, so those call cli-harness's cli() directly.

test("tumwater report prints the Markdown report and validates --days", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(3), loop: "feature", type: "run_end", run: 1, result: "no_change", tokens: 313 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "run_end", run: 2, result: "changed", tokens: 42 }), // retired-name-ok: legacy event field in a fixture
  ]);
  writeBacklogFile(root, "PLANS.md", [
    { heading: "## Planned" },
    { heading: "## Done", body: `- Epitaph (planned 2026-09-01, done ${dayKey(at(0))}; commit abc)` },
  ]);

  const full = await runCli(root, "report");
  assert.equal(full.code, 0);
  assert.match(full.out, /^# tumwater usage report/m);
  assert.match(full.out, /\(14 days\)/); // default window
  assert.match(full.out, /355 output tokens/); // 313 + 42 in the totals line
  assert.match(full.out, /1 features done/);

  const one = await runCli(root, "report", "--days", "1");
  assert.equal(one.code, 0);
  assert.match(one.out, new RegExp(`\\| ${dayKey(at(0)).slice(5)} \\| 42`)); // today only…
  assert.ok(!one.out.includes("313"), "…and the older day is outside a 1-day window");

  for (const bad of ["0", "abc"]) {
    const r = await runCli(root, "report", "--days", bad);
    assert.notEqual(r.code, 0, `--days ${bad} fails`);
    assert.match(r.out, /--days needs a positive integer/);
  }
});

test("renderSinceReportMarkdown pins the header, totals voice, role ranking, and zero window", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    runsByRole: {},
    costByRole: {},
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: {},
    commitsByRole: {},
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    runsByModel: {},
    coversFullWindow: true,
  });
  assert.match(zero, /^# tumwater usage report/);
  assert.match(zero, /window: last 1h \(since /);
  assert.match(zero, /\*\*Totals:\*\* 0 output tokens · 0 runs · 0 commits · \$0\.00/);
  assert.match(zero, /\*\*Runs by role:\*\* -/);
  assert.match(zero, /\*\*Tokens by role:\*\* -/);
  assert.match(zero, /\*\*Cost by role:\*\* -/);
  assert.ok(!zero.includes("rotated"));

  const data = renderSinceReportMarkdown({
    sinceMs: 90 * 60_000,
    fromIso: new Date(ago(90 * 60_000)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 1500, runs: 5, commits: 1, costUsd: 0.75, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    // Equal totals rank by name asc; a zero-cost role is omitted from the cost line.
    runsByRole: { bugfix: 2, feature: 2, clean: 1 },
    costByRole: { feature: 0.75, bugfix: 0 },
    rejectionsByRole: { feature: 1, clean: 1 },
    postMergeRejectionsByRole: { feature: 1 },
    revisionsByRole: { feature: 1 },
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    // clean carries the most tokens but $0 spend — it must appear on the tokens line (its
    // own ranked data) while the cost line omits it, proving the lines differ.
    tokensByRole: { clean: 12000, feature: 5000, bugfix: 800 },
    commitsByRole: {},
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    runsByModel: {},
    coversFullWindow: true,
  });
  assert.match(data, /window: last 90m \(since /);
  assert.match(data, /\*\*Totals:\*\* 1500 output tokens · 5 runs · 1 commits · \$0\.75/);
  assert.match(data, /\*\*Runs by role:\*\* bugfix — 2 · feature — 2 · clean — 1/);
  assert.match(data, /\*\*Tokens by role:\*\* clean — 12\.0k · feature — 5000 · bugfix — 800/);
  assert.match(data, /\*\*Cost by role:\*\* feature — \$0\.75/);
  assert.match(data, /\*\*Rejections by role:\*\* clean — 1 · feature — 1/, "equal rejection counts rank by name asc");
  assert.match(data, /\*\*Post-merge rejections by role:\*\* feature — 1/, "the post-merge line ranks its afterMerge subset");
  assert.match(data, /\*\*Revisions by role:\*\* feature — 1/);
  assert.match(data, /backlog tallies \(features done \/ bugs fixed \/ plans added \/ bugs filed\) need the day report \(--days\)/);
});

test("renderSinceReportMarkdown shows the merge line under Totals only when merge ran", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    runsByRole: {},
    costByRole: {},
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: {},
    commitsByRole: {},
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    runsByModel: {},
    coversFullWindow: true,
  });
  assert.ok(!zero.includes("merge runs"), "zero merge runs omit the line entirely");

  const data = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 1000, runs: 2, commits: 0, costUsd: 0.5, mergeRuns: 1, mergeTokens: 900, mergeCostUsd: 0.4 },
    runsByRole: { feature: 2 },
    costByRole: { feature: 0.1 },
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: { feature: 900 },
    commitsByRole: {},
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    runsByModel: {},
    coversFullWindow: true,
  });
  assert.match(data, /of which merge runs: 1 runs · 900 tokens · \$0\.40 \(reviewer \+ conflict resolution\)/);
});

test("renderSinceReportMarkdown shows (N failed) on the merge line when a merge failed", () => {
  const data = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 1000, runs: 2, commits: 0, costUsd: 0.5, mergeRuns: 2, mergeFailed: 1, mergeTokens: 1200, mergeCostUsd: 0.5 },
    runsByRole: { feature: 2 },
    costByRole: { feature: 0.1 },
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: { feature: 900 },
    commitsByRole: {},
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    runsByModel: {},
    coversFullWindow: true,
  });
  assert.match(data, /of which merge runs: 2 runs \(1 failed\) · 1200 tokens · \$0\.50 \(reviewer \+ conflict resolution\)/);
});

test("renderSinceReportMarkdown prints Commits by role and Estimated by role matching the day render", () => {
  const data = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 1500, runs: 5, commits: 4, costUsd: 0.75, notionalCostUsd: 0.9, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    runsByRole: { feature: 5 },
    costByRole: { feature: 0.75 },
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: { feature: 3 },
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: { feature: 1500 },
    // The same ranking (count desc / spend desc, then name asc) and `usd` formatting the
    // day render applies to its Commits/Estimated by role lines — window and day speak one shape.
    commitsByRole: { feature: 3, clean: 1 },
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    notionalByRole: { feature: 0.4, plan: 0.5 },
    runsByModel: {},
    coversFullWindow: true,
  });
  assert.match(data, /\*\*Commits by role:\*\* feature — 3 · clean — 1/);
  assert.match(data, /\*\*Estimated by role:\*\* plan — \$0\.50 · feature — \$0\.40/);
});

test("renderSinceReportMarkdown prints Cost per commit and Estimated per commit matching the day render", () => {
  const data = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 1500, runs: 5, commits: 5, costUsd: 1.8, notionalCostUsd: 0.9, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    runsByRole: { feature: 5 },
    costByRole: { feature: 0.2, "feature-2": 0.1, clean: 0.9, plan: 0.9 },
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: {},
    // costByRole is keyed by role id, so feature-2 joins feature; commitsByRole already base-keyed.
    commitsByRole: { feature: 2, clean: 3 },
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    notionalByRole: { feature: 0.4, plan: 0.5 },
    runsByModel: {},
    coversFullWindow: true,
  });
  // The day render's exact wording and ranking: merged roles by cost per commit desc then name
  // asc, the spend-only `plan` idle last; the notional twin comes directly after Estimated by role.
  assert.match(data, /\*\*Cost per commit:\*\* clean — \$0\.30 \(3\) · feature — \$0\.15 \(2\) · plan — \$0\.90, no commits/);
  assert.match(data, /\*\*Estimated per commit:\*\* feature — \$0\.20 \(2\) · plan — \$0\.50, no commits/);
  // Order: Cost per commit precedes Estimated by role, and Estimated per commit follows it.
  assert.ok(data.indexOf("**Cost per commit:") < data.indexOf("**Estimated by role:"));
  assert.ok(data.indexOf("**Estimated by role:") < data.indexOf("**Estimated per commit:"));
});

test("renderSinceReportMarkdown renders an empty window's Commits by role and omits Estimated by role", () => {
  const zero = renderSinceReportMarkdown({
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    mainRedMs: 0,
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    runsByRole: {},
    costByRole: {},
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: {},
    commitsByRole: {},
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    runsByModel: {},
    coversFullWindow: true,
  });
  // The now-required commitsByRole renders "-" when empty; a window with no notional spend
  // carries no Estimated by role line at all — the same conditional omission the day render uses.
  assert.match(zero, /\*\*Commits by role:\*\* -/);
  assert.match(zero, /\*\*Cost per commit:\*\* -/);
  assert.ok(!zero.includes("**Estimated by role:"), "no notional spend omits the line entirely");
  assert.ok(!zero.includes("**Estimated per commit:"), "no notional spend omits Estimated per commit too");
});

test("renderSinceReportMarkdown prints Main red wall-clock for a positive window total and omits it at zero", () => {
  const shape = {
    sinceMs: HOUR,
    fromIso: new Date(ago(HOUR)).toISOString(),
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    runsByRole: {},
    costByRole: {},
    rejectionsByRole: {},
    postMergeRejectionsByRole: {},
    revisionsByRole: {},
    refusalsByRole: {},
    failedRunsByRole: {},
    fallbacksByRole: {},
    imageReroutesByRole: {},
    tokensByRole: {},
    commitsByRole: {},
    mergedByRole: {},
    mergeFailedByRole: {},
    mergeFailedByReason: {},
    costByProvider: {},
    notionalByProvider: {},
    runsByModel: {},
    coversFullWindow: true,
    mainRedMs: 0,
  };
  assert.ok(!renderSinceReportMarkdown({ ...shape, mainRedMs: 0 }).includes("**Main red:"), "zero omits the line");
  assert.match(renderSinceReportMarkdown({ ...shape, mainRedMs: 63 * 60_000 }), /^\*\*Main red:\*\* 63m$/m);
  // Main red by test rides the same window, team-only: a positive ranking prints, and an
  // all-zero map or a role-scoped window omits the line.
  assert.match(
    renderSinceReportMarkdown({ ...shape, mainRedByTest: { "test/a.test.ts": 2 } }),
    /^\*\*Main red by test:\*\* test\/a\.test\.ts — 2$/m,
  );
  assert.ok(
    !renderSinceReportMarkdown({ ...shape, mainRedByTest: { "test/a.test.ts": 0 } }).includes("**Main red by test:"),
    "an all-zero map omits the line",
  );
  assert.ok(
    !renderSinceReportMarkdown({ ...shape, role: "feature", mainRedByTest: { "test/a.test.ts": 2 } }).includes("**Main red by test:"),
    "role scope omits the line",
  );
  // Main red by merge rides the same window, team-only and zero-absent: a positive map
  // prints, an all-zero map and a role-scoped window omit the line.
  assert.match(
    renderSinceReportMarkdown({ ...shape, mainRedByCulprit: { "feature abc12345": 2 } }),
    /^\*\*Main red by merge:\*\* feature abc12345 — 2$/m,
  );
  assert.ok(
    !renderSinceReportMarkdown({ ...shape, mainRedByCulprit: { "feature abc12345": 0 } }).includes("**Main red by merge:"),
    "an all-zero map omits the line",
  );
  assert.ok(
    !renderSinceReportMarkdown({ ...shape, role: "feature", mainRedByCulprit: { "feature abc12345": 2 } }).includes("**Main red by merge:"),
    "role scope omits the line",
  );
});

test("tumwater report --since prints the window totals and validates its flags", async () => {
  const root = makeRepo();
  // The event log is append-only and chronological: seed oldest first, like every log the
  // harness itself writes (a reverse-ordered log is malformed input, not a coverage case).
  writeEvents(root, [
    JSON.stringify({ ts: ago(8 * HOUR), loop: "feature", type: "run_end", run: 2, result: "no_change", tokens: 999 }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(30 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", tokens: 777, costUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const ok = await runCli(root, "report", "--since", "6h");
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^# tumwater usage report/m);
  assert.match(ok.out, /window: last 6h \(since /);
  assert.match(ok.out, /777 output tokens/);
  assert.match(ok.out, /\*\*Runs by role:\*\* feature — 1/);
  assert.match(ok.out, /\*\*Cost per commit:\*\*/);
  assert.ok(!ok.out.includes("999"), "the 8h-old event is outside the 6h window");
  assert.match(ok.out, /backlog tallies \(features done \/ bugs fixed \/ plans added \/ bugs filed\) need the day report/);

  // --days is the one remaining rival shape; --failures --since dispatches the windowed
  // digest (covered in test/failure-render.test.ts), so it is no longer a failure.
  const rival = ["--days", "3"];
  const r = await runCli(root, "report", "--since", "6h", ...rival);
  assert.notEqual(r.code, 0, `--since with ${rival[0]} fails`);
  assert.match(r.out, new RegExp(`report --since cannot be combined with ${rival[0]}`), "the failure names the rival");
  assert.match(r.out, /--since/, "the failure names both flags");

  const over = await runCli(root, "report", "--since", "8d");
  assert.notEqual(over.code, 0);
  assert.match(over.out, /capped at 7d/);

  for (const bad of ["abc", ""]) {
    const r = await runCli(root, "report", "--since", bad);
    assert.notEqual(r.code, 0, `--since ${bad} fails`);
    assert.match(r.out, /report --since needs a duration like 45s, 90m, 1h30m, or 2d/);
  }
  const missing = await runCli(root, "report", "--since");
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /report --since needs a value/);

  const help = await runCli(root, "help", "report");
  assert.equal(help.code, 0);
  assert.match(help.out, /report --since <duration>/);
});

test("tumwater report --since prints Commits/Estimated by role and --json carries them", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "merged", commit: "abc1234" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(9 * 60_000), loop: "clean", type: "merged", commit: "def5678" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(8 * 60_000), loop: "plan", type: "run_end", run: 1, result: "changed", tokens: 10, notionalCostUsd: 0.5 }), // retired-name-ok: legacy event field in a fixture
  ]);

  const md = await runCli(root, "report", "--since", "6h");
  assert.equal(md.code, 0);
  assert.match(md.out, /\*\*Commits by role:\*\* clean — 1 · feature — 1/);
  assert.match(md.out, /\*\*Estimated by role:\*\* plan — \$0\.50/);

  const json = await runCli(root, "report", "--json", "--since", "6h");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.deepEqual(parsed.commitsByRole, { feature: 1, clean: 1 }, "the since JSON carries commitsByRole");
  assert.deepEqual(parsed.notionalByRole, { plan: 0.5 }, "the since JSON carries notionalByRole when nonzero");
  assert.ok(!("series" in parsed), "the since shape carries totals, not a day series");
});

test("report --since names each subscription backend on the notional line", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: ago(10 * 60_000), loop: "feature", type: "run_end", run: 1, result: "changed", notionalCostUsd: 3, agent: "claude", billing: "subscription" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: ago(9 * 60_000), loop: "plan", type: "run_end", run: 2, result: "changed", notionalCostUsd: 2, agent: "codex", billing: "subscription" }), // retired-name-ok: legacy event field in a fixture
  ]);

  const md = await runCli(root, "report", "--since", "6h");
  assert.equal(md.code, 0);
  assert.match(md.out, /Claude subscription, API-equivalent: \$3\.00 estimated/);
  assert.match(md.out, /Codex subscription, API-equivalent: \$2\.00 estimated/);

  const json = await runCli(root, "report", "--json", "--since", "6h");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.deepEqual(parsed.totals.notionalByBackend, { claude: 3, codex: 2 }, "the since totals carry notionalByBackend");
});

// --- report through the real CLI entry point: main()'s wiring that the in-process pins
// above cannot see — report runs WITHOUT a readiness gate (it degrades to zeros in any
// directory) and --days shares /api/report's window bound: above it the command fails fast
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

test("renderReportMarkdown prints each role's cost per merged commit, folding instances and days", () => {
  const day = (date: string, costByRole: Record<string, number>, commitsByRole: Record<string, number>) => ({
    date, tokensOut: 0, runsByRole: {}, costByRole, commits: 0, commitsByRole, workCommits: 0, maintenanceCommits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0,
  });
  const render = (series: ReportData["series"]) =>
    renderReportMarkdown({
      days: series.length, from: "2026-09-10", to: "2026-09-11", series,
      totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
      coversFullWindow: true,
    });
  const want = "**Cost per commit:** clean — $0.30 (3) · feature — $0.15 (2) · plan — $0.90, no commits";
  const one = render([day("2026-09-10", { feature: 0.2, "feature-2": 0.1, clean: 0.9, plan: 0.9 }, { feature: 2, clean: 3 })]);
  assert.ok(one.split("\n").includes(want), one);
  const two = render([
    day("2026-09-10", { feature: 0.2, clean: 0.4, plan: 0.5 }, { feature: 1, clean: 1 }),
    day("2026-09-11", { "feature-2": 0.1, clean: 0.5, plan: 0.4 }, { feature: 1, clean: 2 }),
  ]);
  assert.ok(two.split("\n").includes(want), two);
  const free = render([day("2026-09-10", {}, { docs: 4 })]);
  assert.ok(free.split("\n").includes("**Cost per commit:** -"), free);
});

test("renderReportMarkdown prints notional spend by role and per commit only when the window has any", () => {
  const day = (date: string, extra: object) => ({
    date, tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, commitsByRole: {}, workCommits: 0, maintenanceCommits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, ...extra,
  });
  const render = (series: ReportData["series"], notionalCostUsd?: number) =>
    renderReportMarkdown({
      days: series.length, from: "2026-09-10", to: "2026-09-11", series,
      totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0, ...(notionalCostUsd ? { notionalCostUsd } : {}) },
      coversFullWindow: true,
    });
  const out = render([
    day("2026-09-10", { notionalByRole: { feature: 0.4, plan: 0.5 }, commitsByRole: { feature: 2 } }),
    day("2026-09-11", { notionalByRole: { "feature-2": 0.2 }, commitsByRole: { feature: 1 } }),
  ], 1.1).split("\n");
  assert.ok(out.includes("**Estimated by role:** plan — $0.50 · feature — $0.40 · feature-2 — $0.20"), out.join("\n"));
  assert.ok(out.includes("**Estimated per commit:** feature — $0.20 (3) · plan — $0.50, no commits"), out.join("\n"));
  assert.ok(out.includes("**Cost per commit:** -"));
  const none = render([day("2026-09-10", {})]).split("\n");
  assert.ok(!none.some((l) => l.startsWith("**Estimated")));
});

test("report --json carries fallbacksByRole on the day and --since report that have fallback episodes", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "model_fallback_started" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "qa", type: "model_fallback_started" }), // retired-name-ok: legacy event field in a fixture
    JSON.stringify({ ts: todayTs(), loop: "feature", type: "model_fallback_started" }), // retired-name-ok: legacy event field in a fixture
  ]);
  const md = await runCli(root, "report", "--days", "1");
  assert.match(md.out, /\*\*Fallbacks by role:\*\* feature — 2 · qa — 1/);
  const day = JSON.parse((await runCli(root, "report", "--json", "--days", "1")).out);
  assert.deepEqual(day.series[day.series.length - 1].fallbacksByRole, { feature: 2, qa: 1 });
  const since = JSON.parse((await runCli(root, "report", "--json", "--since", "3h")).out);
  assert.deepEqual(since.fallbacksByRole, { feature: 2, qa: 1 });
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

test("renderReportMarkdown prints Merge check median for the days that carry one, team scope only", () => {
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, checkMedianMs: 95_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Merge check median:\*\* 09-10 95s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ checkMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Merge check median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Merge check median"));
});

test("renderReportMarkdown prints Red merge checks for the days that carry one, team scope only", () => {
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, checkFailures: 3 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Red merge checks:\*\* 09-10 ×3$/m);

  const none: ReportData = { ...base, series: base.series.map(({ checkFailures: _c, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Red merge checks"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Red merge checks"));
});

test("renderReportMarkdown prints Main red wall-clock for the days that carry one, team scope only", () => {
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mainRedMs: 63 * 60_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Main red:\*\* 09-10 63m$/m);

  const none: ReportData = { ...base, series: base.series.map(({ mainRedMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("**Main red:"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("**Main red:"));
});

test("renderReportMarkdown ranks each series day's main-red tests", () => {
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mainRedByTest: { "test/a.test.ts": 2 } },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Main red by test:\*\* test\/a\.test\.ts — 2$/m);
  const bare: ReportData = { ...base, series: base.series.map(({ mainRedByTest: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(bare).includes("**Main red by test:"), "a bare series omits the line");
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("**Main red by test:"), "role scope omits the line");
  // The same day-twin rule for the merges the watch blamed: a positive map prints, and a
  // bare series or role scope omits the line. Only the second series day carries the map, so
  // the ranked total is 2, not twice it.
  const culprit: ReportData = {
    ...base,
    series: base.series.map((d) => (d.date === "2026-09-10" ? { ...d, mainRedByCulprit: { "feature abc12345": 2 } } : d)),
  };
  assert.match(renderReportMarkdown(culprit), /^\*\*Main red by merge:\*\* feature abc12345 — 2$/m);
  const bareCulprit: ReportData = { ...culprit, series: culprit.series.map(({ mainRedByCulprit: _c, ...d }) => d) };
  assert.ok(!renderReportMarkdown(bareCulprit).includes("**Main red by merge:"), "a bare series omits the line");
  assert.ok(!renderReportMarkdown({ ...culprit, role: "feature" }).includes("**Main red by merge:"), "role scope omits the line");
});

test("renderReportMarkdown prints Merge wait median for the days that carry one, team scope only", () => {
  const day = { tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", ...day },
      { date: "2026-09-10", ...day, mergeWaitMedianMs: 95_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Merge wait median:\*\* 09-10 95s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ mergeWaitMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Merge wait median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Merge wait median"));
});

test("renderReportMarkdown prints Merge slot median for the days that carry one, team scope only", () => {
  const day = { tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  const slot = { mergeSlotMedianMs: 110_000 };
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", ...day },
      { date: "2026-09-10", ...day, ...slot },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Merge slot median:\*\* 09-10 110s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ mergeSlotMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Merge slot median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Merge slot median"));
});

test("renderReportMarkdown prints Run duration median for the days that carry one, team scope only", () => {
  const day = { tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", ...day },
      { date: "2026-09-10", ...day, runMedianMs: 95_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Run duration median:\*\* 09-10 95s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ runMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Run duration median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Run duration median"));
});

test("renderReportMarkdown prints Review duration median for the days that carry one, team scope only", () => {
  const day = { tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", ...day },
      { date: "2026-09-10", ...day, reviewMedianMs: 95_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Review duration median:\*\* 09-10 95s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ reviewMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Review duration median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Review duration median"));
});

test("renderReportMarkdown prints Provider wait median for the days that carry one, team scope only", () => {
  const day = { tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", ...day },
      { date: "2026-09-10", ...day, providerWaitMedianMs: 40_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Provider wait median:\*\* 09-10 40s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ providerWaitMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Provider wait median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Provider wait median"));
});

test("renderReportMarkdown prints Workspace wait median for the days that carry one, team scope only", () => {
  const day = { tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", ...day },
      { date: "2026-09-10", ...day, slotWaitMedianMs: 40_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Workspace wait median:\*\* 09-10 40s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ slotWaitMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Workspace wait median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Workspace wait median"));
});

test("renderReportMarkdown prints Check wait median for the days that carry one, team scope only", () => {
  const day = { tokensOut: 0, runsByRole: {}, costByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 };
  const base: ReportData = {
    days: 2,
    from: "2026-09-09",
    to: "2026-09-10",
    series: [
      { date: "2026-09-09", ...day },
      { date: "2026-09-10", ...day, checkWaitMedianMs: 40_000 },
    ],
    totals: { tokensOut: 0, runs: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0, mergeRuns: 0, mergeTokens: 0, mergeCostUsd: 0 },
    coversFullWindow: true,
  };
  assert.match(renderReportMarkdown(base), /^\*\*Check wait median:\*\* 09-10 40s$/m);

  const none: ReportData = { ...base, series: base.series.map(({ checkWaitMedianMs: _m, ...d }) => d) };
  assert.ok(!renderReportMarkdown(none).includes("Check wait median"));
  assert.ok(!renderReportMarkdown({ ...base, role: "feature" }).includes("Check wait median"));
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
