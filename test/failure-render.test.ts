import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderFailureMarkdown } from "../src/failure/failure-render.js";
import { collectFailureReport, collectFailureReportSince } from "../src/failure/failure-data.js";
import { atLocalTs as at, ago, dayKey, HOUR } from "./helpers/oracles.js";
import { writeEvents, writeLogLines } from "./fixtures/log-fixtures.js";
import { makeRepo, tmpdir } from "./fixtures/repo-fixtures.js";
import { runCli } from "./helpers/cli-harness.js";

// The digest buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings), matching the reader and collectReport (dayKey).

test("collectFailureReport memoizes an unchanged log and re-reads a changed one", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
  ]);
  const first = collectFailureReport(root, 1);
  const second = collectFailureReport(root, 1);
  assert.equal(second, first, "an unchanged log and window return the memoized digest");
  // A changed log — the append below grows the file, changing its identity — must re-derive
  // rather than serve the memo.
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0), loop: "bugfix", type: "run_end", result: "error", error: "boom" },
  ]);
  const third = collectFailureReport(root, 1);
  assert.notEqual(third, first, "a changed log re-derives the digest");
  assert.equal(third.runs, 2, "the re-derived digest sees the appended tick");
});

test("collectFailureReport tallies run_end results per role", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "boom" },
    { ts: at(0), loop: "bugfix", type: "run_end", result: "no_change" },
    { ts: at(0), loop: "", type: "run_end", result: "queued" }, // empty loop id → "?"
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.runs, 5);
  const feature = data.outcomes.find((o) => o.role === "feature");
  assert.deepEqual(feature?.counts, { changed: 2, error: 1 });
  const bugfix = data.outcomes.find((o) => o.role === "bugfix");
  assert.deepEqual(bugfix?.counts, { no_change: 1 });
  const unnamed = data.outcomes.find((o) => o.role === "?");
  assert.deepEqual(unnamed?.counts, { queued: 1 });
});

test("equal-total roles tie in ascending key order in the outcome and time-spend tables", () => {
  // The outcome table ranks by total tick count, the time-spend table by summed wall-clock
  // ms; both must break ties by ascending role name, matching the rank rule everywhere
  // else that ranks counters (the old sort-ascending-then-reverse idiom here flipped ties
  // into reverse-alphabetical order).
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "zed", type: "run_end", result: "changed" },
    { ts: at(0), loop: "alpha", type: "run_end", result: "no_change" },
  ]);
  const data = collectFailureReport(root, 1);
  assert.deepEqual(
    data.outcomes.map((o) => o.role),
    ["alpha", "zed"],
    "equal totals (1 tick each) read alphabetically",
  );
  assert.deepEqual(
    data.timeSpend.map((r) => r.role),
    ["alpha", "zed"],
    "zero-ms ties read alphabetically",
  );
});

test("a main_red tick's cause is clustered with the run errors, not left a bare count", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "organize", type: "run_end", result: "main_red",
      error: "main abc1234 is red (test: boom) — authoring skipped until main is green" },
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "boom" },
    // A cause-less main_red still itemizes, under a placeholder: the section's selection
    // predicate is the Outcome table's own (raw result), so a run_end counted above can never
    // vanish from the one section built to itemize it (BUGS.md 2026-09-30).
    { ts: at(0), loop: "improve", type: "run_end", result: "main_red" },
    { ts: at(0), loop: "qa", type: "run_end", result: "error", error: "" },
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.errors.total, 4, "the error column plus every main_red cell, caused or not");
  assert.equal(data.errors.clusters.length, 3);
  const red = data.errors.clusters.find((c) => c.key.includes("red"));
  assert.ok(red, `the red-main cause is itemized: ${JSON.stringify(data.errors.clusters)}`);
  assert.equal(red?.count, 1);
  assert.deepEqual(red?.roles, ["organize"]);
  const blank = data.errors.clusters.find((c) => c.example === "(no error text recorded)");
  assert.ok(blank, `the message-less error and main_red itemize under the placeholder: ${JSON.stringify(data.errors.clusters)}`);
  assert.equal(blank?.count, 2);
  assert.deepEqual(blank?.roles, ["improve", "qa"]);
  // The render restates the section's widened contract, so the cross-check against the
  // Outcome tables above stays honest (BUGS.md 2026-09-28).
  const md = renderFailureMarkdown(data);
  assert.match(md, /Top error clusters \(red-main causes included\)/);
  assert.match(md, /is red \(test: boom\)/);
  assert.match(md, /\(no error text recorded\)/);
  // The section's own cross-check: its total equals the Outcome tables' error column plus
  // main_red cells, so the render's remainder marker fires only on the real top-N cut.
  const outcomeCount = data.outcomes.reduce(
    (n, o) => n + (o.counts.error ?? 0) + (o.counts.main_red ?? 0),
    0,
  );
  assert.equal(data.errors.total, outcomeCount, "the section counts what the Outcome table counts");
  assert.equal(
    data.errors.clusters.reduce((n, c) => n + c.count, 0),
    data.errors.total,
    "every counted event is itemized when the top-N cut has not fired",
  );
});

test("error strings differing only in volatile parts cluster; exit codes stay distinct", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "ENOENT /Users/a/one.ts deadbeef0" },
    { ts: at(0), loop: "bugfix", type: "run_end", result: "error", error: "ENOENT /Users/b/two.ts cafebabe1" },
    { ts: at(0), loop: "clean", type: "run_end", result: "error", error: "ENOENT /Users/c/three.ts 1234567" },
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "pi exited 1" },
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "pi exited null" },
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.errors.clusters.length, 3);
  const merged = data.errors.clusters.find((c) => c.count === 3);
  assert.equal(merged?.key, "ENOENT <path> <sha>");
  assert.deepEqual(merged?.roles, ["bugfix", "clean", "feature"]);
  // Same-ts events arrive in write order, so the example is the last one seen — the newest
  // occurrence at lastSeen (BUGS.md 2026-09-30); any of the three is a faithful display.
  assert.equal(merged?.example, "ENOENT /Users/c/three.ts 1234567");
  assert.ok(data.errors.clusters.some((c) => c.key === "pi exited 1"));
  assert.ok(data.errors.clusters.some((c) => c.key === "pi exited null"));
});

test("review rejections cluster on (role, reasons[0]), not role alone", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "review_rejected", head: "a".repeat(40), reasons: ["too big"] },
    { ts: at(0), loop: "feature", type: "review_rejected", head: "b".repeat(40), reasons: ["half done"] },
    { ts: at(0), loop: "feature", type: "review_rejected", head: "c".repeat(40), reasons: ["too big"] },
    { ts: at(0), loop: "bugfix", type: "review_rejected", head: "d".repeat(40), reasons: [] },
  ]);
  const data = collectFailureReport(root, 1);
  const find = (role: string, example: string) =>
    data.rejections.clusters.find((c) => c.roles[0] === role && c.example === example);
  assert.equal(find("feature", "too big")?.count, 2);
  assert.equal(find("feature", "half done")?.count, 1);
  assert.equal(find("bugfix", "no reasons given")?.count, 1);
  assert.equal(data.rejections.clusters.length, 3);
});

test("run errors cluster only on error-result ticks; merge review failures get their own section", () => {
  const root = tmpdir();
  writeEvents(root, [
    // A tick that did NOT end as an error but carries a stale `lastError` — the merge slot
    // wrote the shared slot during leftover recovery. It must not be counted as a tick error
    // (BUGS.md 2026-09-21).
    { ts: at(0), loop: "clean", type: "run_end", result: "no_change", error: 'review failed: 429 "Rate limit exceeded"' },
    { ts: at(0), loop: "dedupe", type: "run_end", result: "queued", error: 'review failed: 429 "Rate limit exceeded"' },
    // The merge failure itself is surfaced from its own event.
    { ts: at(0), loop: "clean", type: "review_failed", head: "a".repeat(40), message: "no parseable VERDICT line in the reviewer's reply" },
    { ts: at(0), loop: "dedupe", type: "review_failed", head: "b".repeat(40), message: "no parseable VERDICT line in the reviewer's reply" },
    // A real tick error still clusters.
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "boom" },
  ]);
  const data = collectFailureReport(root, 1);
  const errorTotal = data.outcomes.reduce((n, o) => n + (o.counts.error ?? 0), 0);
  assert.equal(errorTotal, 1, "only the error-result tick counts as an error");
  assert.equal(
    data.errors.clusters.reduce((n, c) => n + c.count, 0),
    errorTotal,
    "the error-cluster total equals the Outcome table's error column",
  );
  assert.ok(
    data.errors.clusters.every((c) => !c.key.includes("review failed")),
    "a successful tick's stale lastError is not a tick error",
  );
  assert.equal(data.reviewFailures.clusters.length, 1);
  assert.equal(data.reviewFailures.clusters[0]?.count, 2);
  assert.deepEqual(data.reviewFailures.clusters[0]?.roles, ["clean", "dedupe"]);
  const md = renderFailureMarkdown(data);
  assert.match(md, /## Top review failure clusters/);
  assert.match(md, /no parseable VERDICT/);
});

test("a window longer than the retained log is reported as partial", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(2), loop: "feature", type: "run_end", result: "error", error: "boom" }]);
  const data = collectFailureReport(root, 5);
  assert.equal(data.partial, true);
  assert.equal(data.emptyLog, false);
  assert.equal(data.oldestEventDate, dayKey(at(2)));
  assert.match(renderFailureMarkdown(data), /^partial: retained log starts \d{4}-\d{2}-\d{2}$/m);
});

test("a prior window the retained log cannot prove is reported as partial too — the deltas read it", () => {
  // The digest reads 2× `days` so its delta table has a baseline: the oldest retained event here
  // sits inside the PRIOR window (day 5 of a 5+5-day read), so the current window is provably
  // covered — but the delta baseline's start is not, and the note must say so instead of
  // silently presenting skewed deltas as a real trend.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(5), loop: "feature", type: "run_end", result: "error", error: "boom" },
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "boom" },
  ]);
  const data = collectFailureReport(root, 5);
  assert.equal(data.partial, true, "the oldest retained event does not predate the read window's start");
  assert.equal(data.oldestEventDate, dayKey(at(5)));
  assert.match(renderFailureMarkdown(data), /^partial: retained log starts \d{4}-\d{2}-\d{2}$/m);
});

test("a log retaining only events outside the read span says so, not 'no events retained'", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(30), loop: "feature", type: "run_end", result: "changed" }]);
  const data = collectFailureReport(root, 5);
  assert.equal(data.hasEvents, false);
  assert.equal(data.emptyLog, false);
  assert.equal(data.partial, false);
  const md = renderFailureMarkdown(data);
  assert.match(md, /^no events in the last 5 days$/m);
  assert.ok(!md.includes("no events retained"));
});

test("an empty log reads 'no events retained'", () => {
  const data = collectFailureReport(tmpdir(), 5);
  assert.equal(data.emptyLog, true);
  assert.equal(data.logState, "empty");
  assert.match(renderFailureMarkdown(data), /^no events retained$/m);
});

test("a present-but-unreadable feed is named unreadable, not 'no events retained'", () => {
  // The bug: a corrupt feed and a never-written one rendered the same empty-window line, so
  // the observer role could not tell "the team was idle" from "I could not read the log".
  const root = tmpdir();
  writeEvents(root, ["{not json"]); // bytes exist, no line parses
  const data = collectFailureReport(root, 5);
  assert.equal(data.logState, "unreadable");
  const md = renderFailureMarkdown(data);
  assert.match(md, /^log unreadable — evidence missing$/m);
  assert.ok(!md.includes("no events retained"));
});

test("a log whose only lines are torn in flight still reads as empty, not unreadable", () => {
  // A newline-less trailing fragment is a write in flight, not corruption: a lone partial
  // line must not raise the alarm until its newline lands and it can be judged.
  const root = tmpdir();
  writeEvents(root, ["{not json"]);
  const file = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").trimEnd());
  assert.equal(collectFailureReport(root, 5).logState, "empty");
});

test("a readable archive does not mask an unreadable live log", () => {
  // The bug: combineLogState let the archive's "ok" win, so once the log had rotated at 16 MB
  // a damaged live feed rendered as a quiet window — exactly the self-hiding failure this
  // change exists to name.
  const root = tmpdir();
  writeEvents(root, []); // creates .tumwater/log/
  const live = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.rmSync(live, { recursive: true, force: true });
  fs.mkdirSync(live, { recursive: true }); // a directory at the live log path
  writeLogLines(path.join(root, ".tumwater", "log", "events.jsonl.1"), [
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
  ]);
  const data = collectFailureReport(root, 5);
  assert.equal(data.logState, "unreadable");
  const md = renderFailureMarkdown(data);
  assert.match(md, /^log unreadable — evidence missing$/m);
  assert.ok(!md.includes("no events retained"));
});

/** Every Markdown table in a rendered digest, as the cells of its header, separator, and body
 * rows. A table is a `|` line directly followed by a separator-shaped line; cells are counted by
 * splitting on `|` and dropping the empty strings outside the outer pipes — the count a renderer
 * uses. A dash total over the whole row would miss the defect: `| --- | ---: ---: |` carries
 * every delimiter's dashes but only two cells. */
function markdownTables(md: string): { header: string[]; separator: string[]; body: string[][] }[] {
  const rows = md.split("\n");
  const cells = (row: string) => row.split("|").slice(1, -1).map((c) => c.trim());
  const isRow = (row: string | undefined): row is string => row?.startsWith("|") ?? false;
  const tables = [];
  for (let i = 0; i < rows.length; i++) {
    const header = rows[i];
    const separator = rows[i + 1];
    if (!isRow(header) || !isRow(separator) || !/^\|[\s:|-]+\|$/.test(separator)) continue;
    const body: string[][] = [];
    for (i += 2; isRow(rows[i]); i++) body.push(cells(rows[i]!));
    tables.push({ header: cells(header), separator: cells(separator), body });
  }
  return tables;
}

test("every digest table's separator has one delimiter cell per header cell", () => {
  // One result column (the join has nothing to separate, so the defect cannot show), one role
  // across several results, and several roles across several results — the shape the
  // 2026-09-21 digest broke on.
  const fixtures: Record<string, { loop: string; result: string }[]> = {
    "one role, one result": [{ loop: "feature", result: "changed" }],
    "one role, several results": [
      { loop: "feature", result: "changed" },
      { loop: "feature", result: "no_change" },
      { loop: "feature", result: "error" },
    ],
    "several roles, several results": [
      { loop: "feature", result: "changed" },
      { loop: "bugfix", result: "no_change" },
      { loop: "bugfix", result: "rejected" },
      { loop: "clean", result: "quiet_killed" },
      { loop: "qa", result: "error" },
    ],
  };
  for (const [name, ticks] of Object.entries(fixtures)) {
    const root = tmpdir();
    writeEvents(root, ticks.map((t) => ({ ts: at(0), type: "run_end", ...t })));
    const md = renderFailureMarkdown(collectFailureReport(root, 1));
    const tables = markdownTables(md);
    // Outcome by role, Time and spend by outcome, and Deltas: a scan that finds no table
    // would pass vacuously.
    assert.equal(tables.length, 3, `${name}:\n${md}`);
    for (const t of tables) {
      assert.equal(t.separator.length, t.header.length, `${name}: ${t.header.join(" | ")}`);
      for (const c of t.separator) assert.match(c, /^:?-{3,}:?$/, `${name}: separator cell "${c}"`);
      for (const row of t.body) assert.equal(row.length, t.header.length, `${name}: ${row.join(" | ")}`);
    }
    // The outcome table keeps its alignment: role left, one right-aligned `---:` per result.
    const outcome = tables[0]!;
    assert.equal(outcome.header[0], "role");
    assert.equal(outcome.header.length - 1, new Set(ticks.map((t) => t.result)).size, name);
    assert.deepEqual(outcome.separator, ["---", ...outcome.header.slice(1).map(() => "---:")], name);
  }
});

test("deltas report new roles as absent, not an infinite increase", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "error" },
    { ts: at(1), loop: "bugfix", type: "run_end", result: "no_change" },
    { ts: at(1), loop: "bugfix", type: "run_end", result: "no_change" },
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.deltas.find((d) => d.role === "feature");
  assert.equal(feature?.prevRuns, 0);
  assert.equal(feature?.runs, 1);
  assert.equal(feature?.errors, 1);
  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| — → 1 \| — → 100% \|/);
  assert.match(md, /\| bugfix \| 2 → — \| 0% → — \|/);
});

test("deltas count quiet kills and rejections per role, both windows", () => {
  // The delta table has dedicated quiet-kills and rejections columns. A rejection is recorded
  // by the merge slot AFTER its authoring tick has ended `queued` (plans/merge-queue.md 3/5),
  // so the fixture pairs a `queued` run_end with a `review_rejected` event — the shape the
  // live team emits. A fixture that fabricates a `rejected` run_end would pass even while the
  // counter reads 0 on every real rejection, the regression an operator could not notice.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    // Preceding window (yesterday): feature had a quiet kill, a rejection, an error, a pass.
    { ts: at(1), loop: "feature", type: "run_end", result: "quiet_killed" },
    { ts: at(1), loop: "feature", type: "run_end", result: "queued" },
    { ts: at(1), loop: "feature", type: "review_rejected", head: head("a"), reasons: ["too big"] },
    { ts: at(1), loop: "feature", type: "run_end", result: "error" },
    { ts: at(1), loop: "feature", type: "run_end", result: "changed" },
    // Current window (today): feature again, and bugfix appears for the first time.
    { ts: at(0), loop: "feature", type: "run_end", result: "quiet_killed" },
    { ts: at(0), loop: "feature", type: "run_end", result: "queued" },
    { ts: at(0), loop: "feature", type: "review_rejected", head: head("b"), reasons: ["too big"] },
    { ts: at(0), loop: "bugfix", type: "run_end", result: "quiet_killed" },
    { ts: at(0), loop: "bugfix", type: "run_end", result: "queued" },
    { ts: at(0), loop: "bugfix", type: "review_rejected", head: head("c"), reasons: ["too big"] },
  ]);
  const data = collectFailureReport(root, 1);

  const feature = data.deltas.find((d) => d.role === "feature")!;
  assert.equal(feature.prevRuns, 4);
  assert.equal(feature.runs, 2);
  assert.equal(feature.prevQuietKills, 1);
  assert.equal(feature.quietKills, 1);
  assert.equal(feature.prevRejections, 1);
  assert.equal(feature.rejections, 1);

  // A role absent from the preceding window carries its current counts, with "—" on the
  // previous side of every column rather than an infinite increase.
  const bugfix = data.deltas.find((d) => d.role === "bugfix")!;
  assert.equal(bugfix.prevRuns, 0);
  assert.equal(bugfix.quietKills, 1);
  assert.equal(bugfix.rejections, 1);

  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| 4 → 2 \| 25% → 0% \| 1 → 1 \| 1 → 1 \|/);
  assert.match(md, /\| bugfix \| — → 2 \| — → 0% \| — → 1 \| — → 1 \|/);

  // The delta and the rejection cluster read the same source: a window with a rejection shows
  // both, so the delta can never claim "no rejections" while the cluster section lists one.
  assert.equal(data.rejections.clusters.reduce((n, c) => n + c.count, 0), 2);
});

test("a nonzero error rate never rounds to 0%, and a partial rate never to 100%", () => {
  // Whole-percent rounding would erase a real difference in both windows: one error in 400
  // ticks is 0.25%, which rounds to "0%" (a role that had an error read as error-free), and
  // 399 errors in 400 ticks is 99.75%, which rounds to "100%". Those two keep one decimal.
  const root = tmpdir();
  const events: object[] = [];
  for (let i = 0; i < 399; i++) events.push({ ts: at(0), loop: "feature", type: "run_end", result: "changed" });
  events.push({ ts: at(0), loop: "feature", type: "run_end", result: "error", error: "boom" });
  for (let i = 0; i < 399; i++) events.push({ ts: at(0), loop: "bugfix", type: "run_end", result: "error", error: "boom" });
  events.push({ ts: at(0), loop: "bugfix", type: "run_end", result: "changed" });
  writeEvents(root, events);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  assert.match(md, /\| feature \| — → 400 \| — → 0\.3% \|/);
  assert.match(md, /\| bugfix \| — → 400 \| — → 99\.8% \|/);
});

test("the top-N cluster sections mark their cut: remainder line, no silent truncation", () => {
  // The 2026-09-22 digest bug: 13 review_rejected events in the window, but `## Review
  // rejections` itemized only the 5 alphabetically-first clusters with no marker — the
  // section read as a full itemization while half the window's rejections were invisible.
  const root = tmpdir();
  const events: object[] = [];
  const roles = ["bugfix", "coverage", "dedupe", "feature", "perf", "qa", "selfcheck"];
  roles.forEach((role, i) => {
    events.push({ ts: at(0), loop: role, type: "review_rejected", head: String(i).padStart(40, String(i)), reasons: [`reject ${role}`] });
    events.push({ ts: at(0), loop: role, type: "run_end", result: "queued" });
  });
  writeEvents(root, events);
  const data = collectFailureReport(root, 1);

  // The Deltas table counts every rejection in the window (7 roles × 1).
  const deltaTotal = data.deltas.reduce((n, d) => n + d.rejections, 0);
  assert.equal(deltaTotal, 7);
  // The section itemizes only the top 5 clusters…
  assert.equal(data.rejections.clusters.length, 5);
  assert.equal(data.rejections.clusters.reduce((n, c) => n + c.count, 0), 5);
  assert.equal(data.rejections.total, 7);
  assert.equal(data.rejections.hiddenClusters, 2);
  // …and says so, instead of reading as the whole window.
  const md = renderFailureMarkdown(data);
  assert.match(md, /## Top rejection clusters/);
  assert.match(md, /_\+2 more clusters holding 2 rejections_/);
  // The review-failure section shares the mechanism.
  for (const role of roles.slice(0, 7)) {
    events.push({ ts: at(0), loop: role, type: "review_failed", head: "f".repeat(40), message: `verdict garbled ${role}` });
  }
  writeEvents(root, events);
  const data2 = collectFailureReport(root, 1);
  assert.equal(data2.reviewFailures.clusters.length, 5);
  assert.equal(data2.reviewFailures.hiddenClusters, 2);
  const md2 = renderFailureMarkdown(data2);
  assert.match(md2, /_\+2 more clusters holding 2 review failures_/);
});

test("the rejection remainder cross-checks the Deltas column even for reasons-less events", () => {
  // A secondary divergence path in the same bug: the section clustered only events carrying
  // a reasons array, while the Deltas column counted every review_rejected — a reasons-less
  // event was counted above and could never be itemized below. The remainder line closes
  // that gap: K = the Deltas total minus what is itemized.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "review_rejected", head: "a".repeat(40), reasons: ["too big"] },
    { ts: at(0), loop: "qa", type: "review_rejected", head: "b".repeat(40) }, // no reasons field at all
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.rejections.total, 2, "the section's total matches the Deltas column");
  assert.equal(data.rejections.clusters.reduce((n, c) => n + c.count, 0), 1);
  const md = renderFailureMarkdown(data);
  assert.match(md, /_\+0 more clusters holding 1 rejection_/);
});

test("the digest renders under 8 KB however bad the window was", () => {
  const root = tmpdir();
  const lines: unknown[] = [];
  const roles = Array.from({ length: 13 }, (_, i) => `role${i}`);
  for (const role of roles) {
    for (let i = 0; i < 40; i++) {
      lines.push({
        ts: at(0),
        loop: role,
        type: "run_end",
        result: i % 3 === 0 ? "error" : "changed",
        error: i % 3 === 0 ? `boom ${i} at /Users/a/very/deep/path/file${i}.ts sha${i.toString(16).padStart(8, "0")}` : undefined,
      });
    }
    for (let i = 0; i < 10; i++) {
      lines.push({ ts: at(0), loop: role, type: "warning", message: `warning ${i} on ${role} at /Users/a/b/c${i}.ts` });
      lines.push({ ts: at(0), loop: role, type: "review_rejected", reasons: [`reason ${i} for ${role}`] });
    }
    for (let i = 0; i < 3; i++) {
      lines.push({ ts: at(0), loop: role, type: "merge_failed", result: i % 2 ? "merge_conflict" : "merge_blocked" });
    }
    for (let i = 0; i < 5; i++) {
      lines.push({ ts: at(0), loop: role, type: "merged", commit: i.toString(16).padStart(40, "0"), summary: `land ${i} `.repeat(20) });
    }
  }
  // Transition events must not grow the digest with the window either. These include the shapes
  // that broke the section when it capped only line count: a 40-char loop id and a
  // config_changed whose keys array and key strings are effectively unbounded.
  for (let i = 0; i < 20; i++) {
    lines.push({ ts: at(0), loop: `role${i}`, type: "run_deferred" });
  }
  lines.push({ ts: at(0), loop: "harness", type: "budget_fallback", spentUsd: 10, capUsd: 10, provider: "omlx", model: "Qwen3.8-27B-MLX-oQ4e-mtp" });
  lines.push({ ts: at(0), loop: "harness", type: "build_stale", build: "b".repeat(40), head: "c".repeat(40), aheadCommits: 12 });
  lines.push({ ts: at(0), loop: "h".repeat(40), type: "config_changed", keys: Array.from({ length: 200 }, (_, i) => `a.very.deeply.nested.configuration.key.number.${i}`) });
  writeEvents(root, lines);
  const md = renderFailureMarkdown(collectFailureReport(root, 14));
  // 8 KB: the 6 KB the digest bounded at before, plus the time-and-spend section's worst
  // case — one 3-cell row per configured role and the LOSS_TOP loss-cause lines — and the
  // merge-failure section's MERGE_FAILURE_TOP clusters, all fixed by config and the top-N
  // cuts, never by how bad the window was.
  assert.ok(Buffer.byteLength(md) < 8 * 1024, `rendered ${Buffer.byteLength(md)} bytes`);
});

test("the digest replays harness decisions so a wrong response is visible", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0, 12), loop: "feature", type: "run_end", result: "error", error: "oMLX prefill memory guard rejected this prompt" },
    { ts: at(0, 13), loop: "harness", type: "team_paused" },
    { ts: at(0, 23), loop: "harness", type: "budget_fallback", spentUsd: 10, capUsd: 10, provider: "omlx", model: "Qwen3-32B" },
  ]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  assert.match(md, /## Team state changes/);
  // Past the 72-char cap the line is cut on a word boundary with a remainder marker
  // (BUGS.md 2026-10-01), so the cut model name can never read as complete.
  assert.match(md, /over-cap model — \$10\.00 of \$10\.00 daily cost reached; roles continue on … \(\+26 chars\)/);
  assert.match(md, /team paused/);
  assert.ok(
    md.indexOf("## Team state changes") < md.indexOf("## Outcome by role"),
    "the causal frame precedes the counts",
  );
});

test("the digest replays a failure-caused role pause and a model fallback", () => {
  // The gate transitions added after the digest's section was written (the error-streak
  // breaker, the role's own cap, and the model-fallback episode) are the reason a loop
  // stopped ticking or moved off-model: without them the digest shows the failed ticks but
  // never the harness's response to them.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0, 12), loop: "docs", type: "run_end", result: "error", error: "boom" },
    { ts: at(0, 13), loop: "harness", type: "role_streak_paused", role: "docs", streak: 10 },
    { ts: at(0, 14), loop: "feature", type: "model_fallback_started", provider: "groq", model: "llama-3-free", reason: "rate limit" },
  ]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  const section = md.slice(md.indexOf("## Team state changes"), md.indexOf("## Outcome by role"));
  assert.match(section, /role docs paused — 10 runs failed in a row/);
  assert.match(section, /model fallback — groq\/llama-3-free engaged \(rate limit\)/);
  assert.ok(
    section.indexOf("role docs paused") < section.indexOf("model fallback —"),
    "the two transitions read oldest first",
  );
});

test("the digest omits the state changes section when the window held none", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(0), loop: "feature", type: "run_end", result: "changed" }]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  assert.doesNotMatch(md, /## Team state changes/);
});

test("a state changes section over the newest-6 cap names its remainder instead of truncating silently", () => {
  const root = tmpdir();
  // 9 transition events with distinct times, oldest first — the pre-6:03 events must be
  // declared hidden, not silently amputated.
  const events = Array.from({ length: 9 }, (_, i) => ({
    ts: at(0, 10 + i),
    loop: "harness",
    type: "run_deferred",
  }));
  writeEvents(root, [{ ts: at(0, 9), loop: "feature", type: "run_end", result: "changed" }, ...events]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  const section = md.slice(md.indexOf("## Team state changes"), md.indexOf("## Outcome by role"));
  assert.match(section, /\+3 older transitions hidden/);
  assert.match(section, /13:00/, "newest transitions kept");
  assert.match(section, /18:00/, "newest transitions kept");
  for (const hour of ["10:00", "11:00", "12:00"]) {
    assert.ok(!section.includes(hour), `oldest transition ${hour} dropped without a marker`);
  }
  // Under the cap the section stays a plain itemization — no false truncation marker.
  const quiet = tmpdir();
  writeEvents(quiet, [events[0]!]);
  assert.doesNotMatch(renderFailureMarkdown(collectFailureReport(quiet, 1)), /older transitions hidden/);
});

test("a merged list over the newest-10 cap names its remainder instead of reading as the whole window", () => {
  const root = tmpdir();
  // 12 merges an hour apart, oldest first: the digest lists the newest 10 and must say that 2
  // older ones were cut — a busy window must not read as a 10-merge day (BUGS.md 2026-09-23).
  const merges = Array.from({ length: 12 }, (_, i) => ({
    ts: at(0, 8 + i),
    loop: "feature",
    type: "merged",
    commit: `${String(i).padStart(2, "0")}${"a".repeat(38)}`,
    summary: `change ${i}`,
  }));
  writeEvents(root, merges);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  const section = md.slice(md.indexOf("## Merged in the window"));
  assert.equal(section.split("\n").filter((l) => l.startsWith("- ")).length, 10, "the newest ten are itemized");
  assert.match(section, /change 11/, "the newest merge is kept");
  assert.doesNotMatch(section, /change 0\b|change 1\b/, "the two oldest are the ones cut");
  assert.match(section, /^\+2 older merges not listed$/m);
  // At or under the cap the list stays a plain itemization — no false truncation marker.
  const quiet = tmpdir();
  writeEvents(quiet, merges.slice(0, 10));
  assert.doesNotMatch(renderFailureMarkdown(collectFailureReport(quiet, 1)), /older merges not listed/);
});

test("each harness state transition renders its own bounded line", () => {
  // describeStateChange owns the whole transition vocabulary, but the digest tests above reach
  // only budget_fallback, team_paused, build_stale, config_changed and run_deferred. Each
  // case gets its own log so the section's newest-STATE_CHANGE_TOP cap never hides one.
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { type: "budget_paused", spentUsd: 10, capUsd: 10 },
      "budget paused — $10.00 of $10.00 daily cost reached",
    ],
    [
      { type: "budget_paused", spentUsd: 10, capUsd: 10, fallbackRejected: "x" },
      "budget paused — $10.00 of $10.00 daily cost reached (fallback x refused)",
    ],
    [
      { type: "budget_paused", spentUsd: 10, capUsd: 10, fallbackDemoted: "omlx/qwen", failures: 3 },
      "budget paused — 3 runs failed on over-cap model omlx/qwen",
    ],
    [
      // The real incident's pair: the whole cause survives the digest's line cap.
      { type: "budget_paused", spentUsd: 10, capUsd: 10, fallbackDemoted: "omlx/Qwen3.8-27B-MLX-oQ4e-mtp", failures: 3 },
      "budget paused — 3 runs failed on over-cap model omlx/Qwen3.8-27B-MLX-oQ4",
    ],
    [{ type: "budget_resumed", spentUsd: 4, capUsd: 10 }, "budget resumed ($4.00 of $10.00 today)"],
    [{ type: "team_resumed" }, "team resumed — roles run again"],
    [
      { type: "role_paused", role: "docs" },
      "role docs paused — it starts no new runs",
    ],
    [{ type: "role_resumed", role: "docs" }, "role docs resumed — it runs again"],
    // The team-wide 429 hold (BUGS.md 2026-09-21 "A 429 storm still has no fleet-wide hold"):
    // who tripped it and for how long, a relapse named, and the automatic re-open.
    [
      { type: "rate_limit_hold", roles: ["bugfix", "coverage"], holdMs: 60_000, escalation: 0 },
      "429 hold for 60s — bugfix, coverage",
    ],
    [
      { type: "rate_limit_hold", roles: ["dedupe", "feature"], holdMs: 240_000, escalation: 2 },
      "429 hold for 4m (relapse 2) — dedupe, feature",
    ],
    [{ type: "rate_limit_resumed" }, "429 hold lifted — roles run again"],
    [{ type: "max_concurrent_changed", from: 3, to: 5 }, "maxConcurrent 3 → 5"],
    [{ type: "retention_changed", from: 7, to: 14 }, "sessionRetentionDays 7 → 14"],
    [{ type: "config_changed", keys: "not-an-array" }, "config changed"],
    [{ type: "config_changed" }, "config changed"],
    [
      { type: "restart_pending", head: "a".repeat(40) },
      "restart pending — main aaaaaaaa green",
    ],
    [{ type: "restart", to: "b".repeat(40) }, "restarting onto update bbbbbbbb"],
    [
      { type: "restart_refused", to: "b".repeat(40), reason: "not initialized" },
      "restart onto bbbbbbbb refused: not initialized",
    ],
    [
      { type: "restart_blocked", from: "a".repeat(40), to: "b".repeat(40), reason: "rebuild of bbbbbbbb failed" },
      "restart blocked — rebuild of bbbbbbbb fail; staying on build aaaaaa",
    ],
    [{ type: "supervisor_exit", generation: 2, code: 1, reason: "not initialized" }, "tumwater down — restart 2 exited 1: not initialized"],
    [{ type: "supervisor_exit", generation: 1, code: null, signal: "SIGKILL" }, "tumwater down — restart 1 killed by SIGKILL"],
    [
      { type: "orchestrator_start", pid: 4321, build: "c".repeat(40) },
      "tumwater started (pid 4321, build cccccccc)",
    ],
    [{ type: "orchestrator_start", pid: 4321 }, "tumwater started (pid 4321)"],
    [{ type: "orchestrator_stop" }, "tumwater stopped"],
  ];
  for (const [ev, expected] of cases) {
    const root = tmpdir();
    writeEvents(root, [{ ts: at(0), loop: "harness", ...ev }]);
    const md = renderFailureMarkdown(collectFailureReport(root, 1));
    assert.ok(md.includes(expected), `${String(ev.type)}: expected ${JSON.stringify(expected)} in:\n${md}`);
  }
});

test("tumwater report --failures prints the digest and shares the --days bound", async () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "pi exited null" },
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "merged", commit: "abc1234", summary: "land a thing" },
  ]);
  const ok = await runCli(root, "report", "--failures");
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^# tumwater failure digest/m);
  assert.match(ok.out, /\(14 days\)/);

  const one = await runCli(root, "report", "--failures", "--days", "1");
  assert.equal(one.code, 0);
  assert.match(one.out, /pi exited null/);

  const tooLong = await runCli(root, "report", "--failures", "--days", "91");
  assert.notEqual(tooLong.code, 0);
  assert.match(tooLong.out, /--days must be between 1 and 90/);

  const unknown = await runCli(root, "report", "--failure");
  assert.notEqual(unknown.code, 0);
});

test("report --failures --json prints the digest's collected data", async () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", run: 1, result: "error", error: "pi exited null", durationMs: 5_000, costUsd: 0.02 },
  ]);
  const ok = await runCli(root, "report", "--failures", "--json");
  assert.equal(ok.code, 0);
  const parsed = JSON.parse(ok.out) as { runs: number; timeSpend: unknown[]; lossCauses: unknown[] };
  assert.equal(parsed.runs, 1);
  assert.ok(Array.isArray(parsed.timeSpend) && parsed.timeSpend.length === 1, "the time-and-spend table rides the JSON");
  assert.ok(Array.isArray(parsed.lossCauses) && parsed.lossCauses.length === 1, "the loss ranking rides the JSON");
});

test("the digest's JSON carries no retired key at any depth", async () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", run: 1, result: "changed", durationMs: 5_000, costUsd: 0.02 },
  ]);
  const parsed = JSON.parse((await runCli(root, "report", "--failures", "--json")).out) as unknown;
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        walk(child);
      }
    }
  };
  walk(parsed);
  for (const retired of ["ticks", "prevTicks", "landed", "landedTotal"]) assert.ok(!keys.has(retired), retired);
  for (const key of ["runs", "merged", "mergedTotal", "prevRuns"]) assert.ok(keys.has(key), key);
  const row = (parsed as { timeSpend: { classes: Record<string, unknown> }[] }).timeSpend[0]!;
  assert.deepEqual(Object.keys(row.classes).sort(), ["error", "merged", "no_change"]);
});

test("collectFailureReportSince counts only the trailing window and compares the equal prior window", () => {
  const root = tmpdir();
  // Append-only, chronological: seed oldest first, like every log the harness writes.
  writeEvents(root, [
    { ts: ago(8 * HOUR), loop: "feature", type: "run_end", result: "error", error: "prior failure" },
    { ts: ago(1 * HOUR), loop: "feature", type: "run_end", result: "error", error: "recent failure" },
  ]);
  const data = collectFailureReportSince(root, 6 * HOUR);
  assert.equal(data.sinceMs, 6 * HOUR);
  assert.equal(data.runs, 1, "only the 1h-old tick is inside the window");
  assert.equal(data.errors.total, 1, "the current window clusters only its own errors");
  // The 8h-old event falls in the prior window [12h, 6h), so it is the prior side of the deltas.
  const feature = data.deltas.find((d) => d.role === "feature");
  assert.deepEqual(
    { prevRuns: feature?.prevRuns, runs: feature?.runs, prevErrors: feature?.prevErrors, errors: feature?.errors },
    { prevRuns: 1, runs: 1, prevErrors: 1, errors: 1 },
    "the 8h-old event is the preceding equal window's side",
  );

  const md = renderFailureMarkdown(data);
  assert.match(md, /^# tumwater failure digest$/m);
  assert.match(md, /window: last 6h \(since /);
  assert.match(md, /## Deltas vs the preceding 6h/);
  assert.match(md, /recent failure/);

  // The guard throws for callers that bypass the CLI's parseSinceFlag, as collectReportSince does.
  assert.throws(() => collectFailureReportSince(root, 8 * 24 * HOUR), /sinceMs must be between/);
});

test("an empty since window renders no events in the last <duration>", () => {
  const root = tmpdir();
  const md = renderFailureMarkdown(collectFailureReportSince(root, 6 * HOUR));
  assert.match(md, /window: last 6h \(since /);
  assert.match(md, /no events in the last 6h/);
});

test("an empty since window ignores earlier same-day events outside both windows", () => {
  const root = tmpdir();
  // Just before the prior half's start, but on that start's own local day, so the day-keyed
  // read (readWindowEvents) reaches it while it lies in neither the current window nor the equal
  // prior window. It must not count as "the window held events" and suppress the empty line.
  writeEvents(root, [
    { ts: ago(12 * HOUR + 60_000), loop: "feature", type: "run_end", result: "changed" },
  ]);
  const data = collectFailureReportSince(root, 6 * HOUR);
  assert.equal(data.runs, 0);
  assert.equal(data.hasEvents, false, "the out-of-window event is not a window event");
  assert.equal(data.partial, false);
  const md = renderFailureMarkdown(data);
  assert.match(md, /^window: last 6h \(since /m);
  assert.match(md, /^no events in the last 6h$/m);
  assert.ok(!md.includes("no events retained"));
});

test("tumwater report --failures --since prints the windowed digest and validates its flags", async () => {
  const root = makeRepo();
  writeEvents(root, [
    { ts: ago(1 * HOUR), loop: "feature", type: "run_end", result: "error", error: "recent failure" },
  ]);
  const ok = await runCli(root, "report", "--failures", "--since", "6h");
  assert.equal(ok.code, 0);
  assert.match(ok.out, /^# tumwater failure digest$/m);
  assert.match(ok.out, /window: last 6h \(since /);
  assert.match(ok.out, /recent failure/);

  const json = await runCli(root, "report", "--failures", "--since", "6h", "--json");
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out) as {
    sinceMs: number;
    fromIso: string;
    outcomes: unknown[];
    deltas: unknown[];
    lossCauses: unknown[];
    errors: { clusters: unknown[] };
  };
  assert.equal(parsed.sinceMs, 6 * HOUR);
  assert.notEqual(Date.parse(parsed.fromIso), NaN, "fromIso is an ISO instant");
  assert.ok(Array.isArray(parsed.outcomes) && Array.isArray(parsed.deltas), "the outcome and delta sections ride the JSON");
  assert.ok(Array.isArray(parsed.lossCauses) && Array.isArray(parsed.errors.clusters), "the loss and error sections ride the JSON");

  // --days stays a rival shape; --failures is dispatchable (covered above).
  const rival = await runCli(root, "report", "--since", "6h", "--days", "3");
  assert.notEqual(rival.code, 0);
  assert.match(rival.out, /report --since cannot be combined with --days/);

  const over = await runCli(root, "report", "--failures", "--since", "8d");
  assert.notEqual(over.code, 0);
  assert.match(over.out, /capped at 7d/);

  for (const bad of ["abc", ""]) {
    const r = await runCli(root, "report", "--failures", "--since", bad);
    assert.notEqual(r.code, 0, `--since ${bad} fails`);
    assert.match(r.out, /report --since needs a duration like 45s, 90m, 1h30m, or 2d/);
  }
});

test("the loss-cause ranking's top-5 cut discloses its remainder, like every other capped section", () => {
  // Seven distinct error clusters in the window: only the five most expensive by time may
  // render, so the section must say how many it dropped — a silent cut reads as a complete
  // itemization, the exact bug class the digest's other capped sections already fix.
  const root = tmpdir();
  writeEvents(root, [
    ...["a", "b", "c", "d", "e", "f", "g"].map((m, i) => ({
      ts: at(0),
      loop: `role${i}`,
      type: "run_end",
      result: "error",
      error: `failure ${m}`,
      durationMs: 1000,
    })),
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.lossCauses.length, 5, "the ranking shows at most LOSS_TOP causes");
  assert.equal(data.lossCausesHidden, 2, "the dropped remainder is counted, not lost");
  const md = renderFailureMarkdown(data);
  assert.match(md, /_\+2 more loss causes by time not listed_/, "the render marks the cut");
});

test("the digest reports per-role prompt-token medians and the pre-edit share", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "changed", promptTokens: 100, preEditPromptTokens: 40 },
    { ts: at(0), loop: "feature", type: "run_end", result: "no_change", promptTokens: 300, preEditPromptTokens: 20 },
    // A tick without the prompt-token fields contributes nothing and does not zero the median.
    { ts: at(0), loop: "feature", type: "run_end", result: "queued" },
    { ts: at(0), loop: "bugfix", type: "run_end", result: "changed", promptTokens: 50, cacheReadTokens: 40, preEditPromptTokens: 50 },
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.promptStats.find((r) => r.role === "feature");
  assert.deepEqual(feature, { role: "feature", runs: 2, medianPromptTokens: 200, preEditShare: 0.15 });
  const bugfix = data.promptStats.find((r) => r.role === "bugfix");
  assert.deepEqual(bugfix, { role: "bugfix", runs: 1, medianPromptTokens: 50, preEditShare: 1 });

  const md = renderFailureMarkdown(data);
  assert.match(md, /^## Prompt tokens by role$/m);
  assert.match(md, /feature: median 200 prompt tokens\/run · 15% before first edit/);
  assert.match(md, /bugfix: median 50 prompt tokens\/run · 100% before first edit/);
});

test("a non-finite prompt-token reading contributes nothing, not Infinity", () => {
  // JSON has no Infinity literal, but `1e999` parses to Infinity — the shape a torn or
  // hand-edited log line can carry. The reader must fold it as absent, like every other
  // event-log number (finiteNumber/nonNegativeNumber), so it cannot reach the median or the
  // pre-edit ratio. Without the guard the first tick's median read Infinity and the second's
  // preEditShare read NaN (Infinity/Infinity).
  const root = tmpdir();
  writeEvents(root, [
    `{"ts":${at(0)},"loop":"feature","type":"run_end","result":"changed","promptTokens":1e999}`,
    `{"ts":${at(0)},"loop":"feature","type":"run_end","result":"changed","promptTokens":100,"preEditPromptTokens":1e999}`,
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.promptStats.find((r) => r.role === "feature");
  assert.deepEqual(feature, { role: "feature", runs: 1, medianPromptTokens: 100, preEditShare: 0 });
});

test("a log without prompt-token fields renders no prompt section", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "changed", tokens: 500 },
  ]);
  const data = collectFailureReport(root, 1);
  assert.deepEqual(data.promptStats, []);
  assert.doesNotMatch(renderFailureMarkdown(data), /Prompt tokens by role/);
});

test("collectFailureReport scopes every section to one base role", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0, 9), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0, 9), loop: "qa", type: "run_end", result: "error", error: "qa boom" },
    { ts: at(0, 10), loop: "feature", type: "warning", message: "feature warn" },
    { ts: at(0, 10), loop: "qa", type: "warning", message: "qa warn" },
    { ts: at(0, 11), loop: "feature", type: "review_rejected", reasons: ["feature rejection"] },
    { ts: at(0, 11), loop: "qa", type: "review_rejected", reasons: ["qa rejection"] },
    { ts: at(0, 12), loop: "feature", type: "merged", commit: "aaaaaaa", summary: "land feature" },
    { ts: at(0, 12), loop: "qa", type: "merged", commit: "bbbbbbb", summary: "land qa" },
    // The role-scoped harness transitions log with loop "harness" and name the affected role:
    // a scoped digest keeps the named role's and drops the other's.
    { ts: at(0, 13), loop: "harness", type: "role_streak_paused", role: "qa", streak: 3 },
    { ts: at(0, 13), loop: "harness", type: "role_cap_paused", role: "feature", spentUsd: 1.5, capUsd: 1.5 },
  ]);

  const team = collectFailureReport(root, 1);
  assert.equal(team.role, undefined);
  assert.deepEqual(team.outcomes.map((o) => o.role).sort(), ["feature", "qa"]);
  assert.match(renderFailureMarkdown(team), /## Team state changes/);

  const scoped = collectFailureReport(root, 1, "qa");
  assert.equal(scoped.role, "qa");
  assert.deepEqual(scoped.outcomes.map((o) => o.role), ["qa"]);
  assert.deepEqual(scoped.deltas.map((d) => d.role), ["qa"]);
  assert.deepEqual(scoped.timeSpend.map((r) => r.role), ["qa"]);
  assert.deepEqual(scoped.warnings.clusters.map((c) => c.roles), [["qa"]]);
  assert.deepEqual(scoped.errors.clusters.map((c) => c.roles), [["qa"]]);
  assert.deepEqual(scoped.rejections.clusters.map((c) => c.roles), [["qa"]]);
  assert.deepEqual(scoped.merged.map((c) => c.commit), ["bbbbbbb"]);
  assert.deepEqual(scoped.stateChanges.map((s) => s.description), [
    "role qa paused — 3 runs failed in a row",
  ]);

  const md = renderFailureMarkdown(scoped);
  assert.match(md, /^role: qa$/m);
  assert.match(md, /^## State changes$/m);
  assert.ok(!md.includes("## Team state changes"), "the scoped heading does not claim team scope");
  assert.match(md, /qa boom/);
  assert.match(md, /qa warn/);
  assert.match(md, /role qa paused/);
  assert.ok(!md.includes("feature warn"), "the other role's clusters are excluded");
  assert.ok(!md.includes("role feature paused"), "the other role's transitions are excluded");
  assert.ok(!md.includes("land feature"), "the other role's landings are excluded");
});

test("a scoped digest folds an instance id into its base role group", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0, 9), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0, 9), loop: "feature-2", type: "run_end", result: "error", error: "sibling boom" },
    { ts: at(0, 9), loop: "qa", type: "run_end", result: "changed" },
  ]);
  const data = collectFailureReport(root, 1, "feature-2");
  assert.equal(data.role, "feature");
  assert.deepEqual(data.outcomes.map((o) => o.role).sort(), ["feature", "feature-2"]);
  assert.deepEqual(data.errors.clusters.map((c) => c.roles), [["feature-2"]]);
  assert.ok(!renderFailureMarkdown(data).includes("qa"), "the unrelated role is excluded");
});

test("a scoped digest for a role with no events reports the empty window", () => {
  const root = tmpdir();
  // A pre-window event proves the log's coverage so the empty line is "no events in the last
  // …" rather than the empty-log wording.
  writeEvents(root, [
    { ts: at(10), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
  ]);
  const data = collectFailureReport(root, 1, "qa");
  assert.equal(data.role, "qa");
  assert.deepEqual(data.outcomes, []);
  assert.equal(data.hasEvents, false);
  const md = renderFailureMarkdown(data);
  assert.match(md, /^role: qa$/m);
  assert.match(md, /^no events in the last /m);
  assert.ok(!md.includes("## State changes"), "no transitions renders no section");
});

test("a scoped partial window names the log's retention date, not the role's own first event", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(5), loop: "feature", type: "run_end", result: "error", error: "feature boom" },
    { ts: at(0), loop: "qa", type: "run_end", result: "error", error: "qa boom" },
  ]);
  const data = collectFailureReport(root, 5, "qa");
  assert.equal(data.partial, true);
  assert.equal(data.oldestEventDate, dayKey(at(5)), "the retention date is the whole log's oldest event");
  assert.ok(data.oldestEventDate !== dayKey(at(0)), "not the scoped role's own first event");
});

test("the loss-ranking renders a refused cause with its summary, and bare without one", () => {
  // PLANS.md 2026-10-14: a refusal is a deliberate objection that blocks its entry, so the
  // digest must name it — `refused on <role> — <summary>` — rather than fold it into no_change.
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "refused",
      summary: "blocks entry X: it violates a principle", durationMs: 3_600_000, costUsd: 0.5 },
    { ts: at(0, 1), loop: "bugfix", type: "run_end", result: "refused", durationMs: 1_800_000, costUsd: 0.2 },
  ]);
  const data = collectFailureReport(root, 1);
  const md = renderFailureMarkdown(data);
  assert.match(
    md,
    /1\.0 h · \$0\.50 — 1 run: refused on feature — blocks entry X: it violates a principle/,
    `the refused cause names its summary: ${md}`,
  );
  assert.match(md, /0\.5 h · \$0\.20 — 1 run: refused on bugfix/, "a summary-less refusal renders the bare form");
  assert.ok(!md.includes("no_change on feature"), "the refused tick is not rendered as no_change");
});

test("the digest's table headers and section titles use plain terms, not raw result codes", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "run_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "run_end", result: "no_change" },
    { ts: at(0), loop: "feature", type: "run_end", result: "error", error: "boom" },
  ]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  const section = (title: string): string => {
    const start = md.indexOf(`## ${title}`);
    assert.notEqual(start, -1, `missing section ${title}`);
    const rest = md.slice(start + 3);
    const next = rest.indexOf("\n## ");
    return next === -1 ? rest : rest.slice(0, next);
  };
  const outcome = section("Outcome by role");
  assert.doesNotMatch(outcome, /no_change|\bchanged\b/);
  assert.match(outcome, /no change/);
  const spend = section("Time and spend by outcome");
  assert.match(spend, /\| role \| merged \| no change \| error or blocked \|/);
  assert.doesNotMatch(spend, /landed|no_change|error-class/);
  const deltas = section("Deltas vs the preceding 1 day");
  assert.match(deltas, /\| role \| runs \| error rate \| stalls \| rejections \|/);
  assert.match(md, /## Merged in the window/);
});

test("collectFailureReport keeps singleton merge-check and stall warnings past seven recurring housekeeping clusters", () => {
  const root = tmpdir();
  const events: Array<Record<string, unknown>> = [];
  for (let k = 0; k < 7; k++) {
    for (let i = 0; i < 2; i++) {
      events.push({ ts: at(0), loop: "feature", type: "warning", message: `housekeeping kind${"abcdefg"[k]} repeated` });
    }
  }
  events.push({ ts: at(0), loop: "feature", type: "warning", message: "landing check red (kept for one re-land): test a" });
  events.push({ ts: at(0), loop: "feature", type: "warning", message: "merge check failed (kept for one retry): test b" });
  events.push({ ts: at(0), loop: "feature", type: "warning", message: "tool call stalled: bash — no exit for 9m" });
  writeEvents(root, events);
  const keys = collectFailureReport(root, 1).warnings.clusters.map((c) => c.example);
  assert.equal(keys.filter((e) => e.startsWith("merge check failed")).length, 2, "both tests' merge warnings survive, old wording pooled to the new");
  assert.ok(keys.some((e) => e.startsWith("tool call stalled")), "stall warning survives");
});

test("the digest lists merge failures by result and role, with the role's preceding warning as the reason", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0, 1), loop: "dedupe", type: "warning", message: "merge check failed (kept for one retry)" },
    { ts: at(0, 2), loop: "dedupe", type: "merge_failed", result: "merge_blocked" },
    { ts: at(0, 3), loop: "feature", type: "merge_failed", result: "merge_blocked" },
    { ts: at(0, 4), loop: "plan", type: "merge_failed", result: "merge_conflict" },
    // Rejections and review errors have their own sections and must not fill this one.
    ...Array.from({ length: 8 }, (_, i) => ({
      ts: at(0, 10 + i), loop: `role${i}`, type: "merge_failed", result: i % 2 ? "rejected" : "review_error",
    })),
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.mergeFailures.total, 3);
  assert.equal(data.mergeFailures.clusters.length, 3);
  const md = renderFailureMarkdown(data);
  assert.match(md, /## Merge failures\n- \*\*1×\*\* dedupe · .* — merge_blocked — merge check failed/);
  assert.match(md, /feature · .* — merge_blocked — no reason recorded/);
  assert.match(md, /plan · .* — merge_conflict — no reason recorded/);
});

test("the merge-failure section caps at 10 clusters and counts the rest as hidden", () => {
  const root = tmpdir();
  writeEvents(root, [
    ...Array.from({ length: 12 }, (_, i) => ({
      ts: at(0, 1 + i), loop: `role${i}`, type: "merge_failed", result: "merge_blocked",
    })),
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.mergeFailures.total, 12);
  assert.equal(data.mergeFailures.clusters.length, 10);
  assert.equal(data.mergeFailures.hiddenClusters, 2);
});
