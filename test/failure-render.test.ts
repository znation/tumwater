import test from "node:test";
import assert from "node:assert/strict";
import { renderFailureMarkdown } from "../src/failure/failure-render.js";
import { collectFailureReport } from "../src/failure/failure-data.js";
import { atLocalTs as at, dayKey } from "./helpers/oracles.js";
import { writeEvents } from "./log-fixtures.js";
import { makeRepo, tmpdir } from "./repo-fixtures.js";
import { runCli } from "./helpers/cli-harness.js";

// The digest buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings), matching the reader and collectReport (dayKey).

test("collectFailureReport tallies tick_end results per role", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "boom" },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "no_change" },
    { ts: at(0), loop: "", type: "tick_end", result: "queued" }, // empty loop id → "?"
  ]);
  const data = collectFailureReport(root, 1);
  assert.equal(data.ticks, 5);
  const feature = data.outcomes.find((o) => o.role === "feature");
  assert.deepEqual(feature?.counts, { changed: 2, error: 1 });
  const bugfix = data.outcomes.find((o) => o.role === "bugfix");
  assert.deepEqual(bugfix?.counts, { no_change: 1 });
  const unnamed = data.outcomes.find((o) => o.role === "?");
  assert.deepEqual(unnamed?.counts, { queued: 1 });
});

test("equal-total roles tie in ascending key order in the outcome and time-spend tables", () => {
  // The outcome table ranks by total tick count, the time-spend table by summed wall-clock
  // ms; both must break ties by ascending role name, matching the rank.ts rule everywhere
  // else that ranks counters (the old sort-ascending-then-reverse idiom here flipped ties
  // into reverse-alphabetical order).
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "zed", type: "tick_end", result: "changed" },
    { ts: at(0), loop: "alpha", type: "tick_end", result: "no_change" },
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

test("a main_red tick's cause is clustered with the tick errors, not left a bare count", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "organize", type: "tick_end", result: "main_red",
      error: "main abc1234 is red (test: boom) — authoring skipped until main is green" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "boom" },
    // A cause-less main_red still itemizes, under a placeholder: the section's selection
    // predicate is the Outcome table's own (raw result), so a tick_end counted above can never
    // vanish from the one section built to itemize it (BUGS.md 2026-09-30).
    { ts: at(0), loop: "improve", type: "tick_end", result: "main_red" },
    { ts: at(0), loop: "qa", type: "tick_end", result: "error", error: "" },
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
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "ENOENT /Users/a/one.ts deadbeef0" },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "error", error: "ENOENT /Users/b/two.ts cafebabe1" },
    { ts: at(0), loop: "clean", type: "tick_end", result: "error", error: "ENOENT /Users/c/three.ts 1234567" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited 1" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited null" },
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

test("tick errors cluster only on error-result ticks; landing review failures get their own section", () => {
  const root = tmpdir();
  writeEvents(root, [
    // A tick that did NOT end as an error but carries a stale `lastError` — the lander wrote the
    // shared slot during leftover recovery. It must not be counted as a tick error (BUGS.md
    // 2026-09-21).
    { ts: at(0), loop: "clean", type: "tick_end", result: "no_change", error: 'review failed: 429 "Rate limit exceeded"' },
    { ts: at(0), loop: "dry", type: "tick_end", result: "queued", error: 'review failed: 429 "Rate limit exceeded"' },
    // The landing failure itself is surfaced from its own event.
    { ts: at(0), loop: "clean", type: "review_failed", head: "a".repeat(40), message: "no parseable VERDICT line in the reviewer's reply" },
    { ts: at(0), loop: "dry", type: "review_failed", head: "b".repeat(40), message: "no parseable VERDICT line in the reviewer's reply" },
    // A real tick error still clusters.
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "boom" },
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
  assert.deepEqual(data.reviewFailures.clusters[0]?.roles, ["clean", "dry"]);
  const md = renderFailureMarkdown(data);
  assert.match(md, /## Top review failure clusters/);
  assert.match(md, /no parseable VERDICT/);
});

test("a window longer than the retained log is reported as partial", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(2), loop: "feature", type: "tick_end", result: "error", error: "boom" }]);
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
    { ts: at(5), loop: "feature", type: "tick_end", result: "error", error: "boom" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "boom" },
  ]);
  const data = collectFailureReport(root, 5);
  assert.equal(data.partial, true, "the oldest retained event does not predate the read window's start");
  assert.equal(data.oldestEventDate, dayKey(at(5)));
  assert.match(renderFailureMarkdown(data), /^partial: retained log starts \d{4}-\d{2}-\d{2}$/m);
});

test("a log retaining only events outside the read span says so, not 'no events retained'", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(30), loop: "feature", type: "tick_end", result: "changed" }]);
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
  assert.match(renderFailureMarkdown(data), /^no events retained$/m);
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
    writeEvents(root, ticks.map((t) => ({ ts: at(0), type: "tick_end", ...t })));
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
    { ts: at(0), loop: "feature", type: "tick_end", result: "error" },
    { ts: at(1), loop: "bugfix", type: "tick_end", result: "no_change" },
    { ts: at(1), loop: "bugfix", type: "tick_end", result: "no_change" },
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.deltas.find((d) => d.role === "feature");
  assert.equal(feature?.prevTicks, 0);
  assert.equal(feature?.ticks, 1);
  assert.equal(feature?.errors, 1);
  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| — → 1 \| — → 100% \|/);
  assert.match(md, /\| bugfix \| 2 → — \| 0% → — \|/);
});

test("deltas count quiet kills and rejections per role, both windows", () => {
  // The delta table has dedicated quiet-kills and rejections columns. A rejection is recorded
  // by the landing slot AFTER its authoring tick has ended `queued` (plans/merge-queue.md 3/5),
  // so the fixture pairs a `queued` tick_end with a `review_rejected` event — the shape the
  // live fleet emits. A fixture that fabricates a `rejected` tick_end would pass even while the
  // counter reads 0 on every real rejection, the regression an operator could not notice.
  const root = tmpdir();
  const head = (c: string) => c.repeat(40);
  writeEvents(root, [
    // Preceding window (yesterday): feature had a quiet kill, a rejection, an error, a pass.
    { ts: at(1), loop: "feature", type: "tick_end", result: "quiet_killed" },
    { ts: at(1), loop: "feature", type: "tick_end", result: "queued" },
    { ts: at(1), loop: "feature", type: "review_rejected", head: head("a"), reasons: ["too big"] },
    { ts: at(1), loop: "feature", type: "tick_end", result: "error" },
    { ts: at(1), loop: "feature", type: "tick_end", result: "changed" },
    // Current window (today): feature again, and bugfix appears for the first time.
    { ts: at(0), loop: "feature", type: "tick_end", result: "quiet_killed" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "queued" },
    { ts: at(0), loop: "feature", type: "review_rejected", head: head("b"), reasons: ["too big"] },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "quiet_killed" },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "queued" },
    { ts: at(0), loop: "bugfix", type: "review_rejected", head: head("c"), reasons: ["too big"] },
  ]);
  const data = collectFailureReport(root, 1);

  const feature = data.deltas.find((d) => d.role === "feature")!;
  assert.equal(feature.prevTicks, 4);
  assert.equal(feature.ticks, 2);
  assert.equal(feature.prevQuietKills, 1);
  assert.equal(feature.quietKills, 1);
  assert.equal(feature.prevRejections, 1);
  assert.equal(feature.rejections, 1);

  // A role absent from the preceding window carries its current counts, with "—" on the
  // previous side of every column rather than an infinite increase.
  const bugfix = data.deltas.find((d) => d.role === "bugfix")!;
  assert.equal(bugfix.prevTicks, 0);
  assert.equal(bugfix.quietKills, 1);
  assert.equal(bugfix.rejections, 1);

  const md = renderFailureMarkdown(data);
  assert.match(md, /\| feature \| 4 → 2 \| 25% → 0% \| 1 → 1 \| 1 → 1 \|/);
  assert.match(md, /\| bugfix \| — → 2 \| — → 0% \| — → 1 \| — → 1 \|/);

  // The delta and the rejection cluster read the same source: a window with a rejection shows
  // both, so the delta can never claim "no rejections" while the cluster section lists one.
  assert.equal(data.rejections.clusters.reduce((n, c) => n + c.count, 0), 2);
});

test("the top-N cluster sections mark their cut: remainder line, no silent truncation", () => {
  // The 2026-09-22 digest bug: 13 review_rejected events in the window, but `## Review
  // rejections` itemized only the 5 alphabetically-first clusters with no marker — the
  // section read as a full itemization while half the window's rejections were invisible.
  const root = tmpdir();
  const events: object[] = [];
  const roles = ["bugfix", "coverage", "dry", "feature", "perf", "qa", "telemetry"];
  roles.forEach((role, i) => {
    events.push({ ts: at(0), loop: role, type: "review_rejected", head: String(i).padStart(40, String(i)), reasons: [`reject ${role}`] });
    events.push({ ts: at(0), loop: role, type: "tick_end", result: "queued" });
  });
  writeEvents(root, events);
  const data = collectFailureReport(root, 1);

  // The Deltas table counts every rejection in the window (7 roles × 1).
  const deltaTotal = data.deltas.reduce((n, d) => n + d.rejections, 0);
  assert.equal(deltaTotal, 7);
  // The section itemizes only the top 5 clusters...
  assert.equal(data.rejections.clusters.length, 5);
  assert.equal(data.rejections.clusters.reduce((n, c) => n + c.count, 0), 5);
  assert.equal(data.rejections.total, 7);
  assert.equal(data.rejections.hiddenClusters, 2);
  // ...and says so, instead of reading as the whole window.
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

test("the digest renders under 6 KB however bad the window was", () => {
  const root = tmpdir();
  const lines: unknown[] = [];
  const roles = Array.from({ length: 13 }, (_, i) => `role${i}`);
  for (const role of roles) {
    for (let i = 0; i < 40; i++) {
      lines.push({
        ts: at(0),
        loop: role,
        type: "tick_end",
        result: i % 3 === 0 ? "error" : "changed",
        error: i % 3 === 0 ? `boom ${i} at /Users/a/very/deep/path/file${i}.ts sha${i.toString(16).padStart(8, "0")}` : undefined,
      });
    }
    for (let i = 0; i < 10; i++) {
      lines.push({ ts: at(0), loop: role, type: "warning", message: `warning ${i} on ${role} at /Users/a/b/c${i}.ts` });
      lines.push({ ts: at(0), loop: role, type: "review_rejected", reasons: [`reason ${i} for ${role}`] });
    }
    for (let i = 0; i < 5; i++) {
      lines.push({ ts: at(0), loop: role, type: "merged", commit: i.toString(16).padStart(40, "0"), summary: `land ${i} `.repeat(20) });
    }
  }
  // Transition events must not grow the digest with the window either. These include the shapes
  // that broke the section when it capped only line count: a 40-char loop id and a
  // config_changed whose keys array and key strings are effectively unbounded.
  for (let i = 0; i < 20; i++) {
    lines.push({ ts: at(0), loop: `role${i}`, type: "tick_deferred" });
  }
  lines.push({ ts: at(0), loop: "harness", type: "budget_fallback", spentUsd: 10, capUsd: 10, provider: "omlx", model: "Qwen3.8-27B-MLX-oQ4e-mtp" });
  lines.push({ ts: at(0), loop: "harness", type: "build_stale", build: "b".repeat(40), head: "c".repeat(40), aheadCommits: 12 });
  lines.push({ ts: at(0), loop: "h".repeat(40), type: "config_changed", keys: Array.from({ length: 200 }, (_, i) => `a.very.deeply.nested.configuration.key.number.${i}`) });
  writeEvents(root, lines);
  const md = renderFailureMarkdown(collectFailureReport(root, 14));
  // 7 KB: the 6 KB the digest bounded at before, plus the time-and-spend section's worst
  // case — one 3-cell row per configured role and the LOSS_TOP loss-cause lines, both fixed
  // by config and the top-N cut, never by how bad the window was.
  assert.ok(Buffer.byteLength(md) < 7 * 1024, `rendered ${Buffer.byteLength(md)} bytes`);
});

test("the digest replays harness decisions so a wrong response is visible", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0, 12), loop: "feature", type: "tick_end", result: "error", error: "oMLX prefill memory guard rejected this prompt" },
    { ts: at(0, 13), loop: "harness", type: "fleet_paused" },
    { ts: at(0, 23), loop: "harness", type: "budget_fallback", spentUsd: 10, capUsd: 10, provider: "omlx", model: "Qwen3-32B" },
  ]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  assert.match(md, /## Fleet state changes/);
  // Past the 72-char cap the line is cut on a word boundary with a remainder marker
  // (BUGS.md 2026-10-01), so the cut model name can never read as complete.
  assert.match(md, /budget fallback — \$10\.00 of \$10\.00 daily cost reached; on … \(\+26 chars\)/);
  assert.match(md, /fleet paused/);
  assert.ok(
    md.indexOf("## Fleet state changes") < md.indexOf("## Outcome by role"),
    "the causal frame precedes the counts",
  );
});

test("the digest omits the state changes section when the window held none", () => {
  const root = tmpdir();
  writeEvents(root, [{ ts: at(0), loop: "feature", type: "tick_end", result: "changed" }]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  assert.doesNotMatch(md, /## Fleet state changes/);
});

test("a state changes section over the newest-6 cap names its remainder instead of truncating silently", () => {
  const root = tmpdir();
  // 9 transition events with distinct times, oldest first — the pre-6:03 events must be
  // declared hidden, not silently amputated.
  const events = Array.from({ length: 9 }, (_, i) => ({
    ts: at(0, 10 + i),
    loop: "harness",
    type: "tick_deferred",
  }));
  writeEvents(root, [{ ts: at(0, 9), loop: "feature", type: "tick_end", result: "changed" }, ...events]);
  const md = renderFailureMarkdown(collectFailureReport(root, 1));
  const section = md.slice(md.indexOf("## Fleet state changes"), md.indexOf("## Outcome by role"));
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

test("a landed list over the newest-10 cap names its remainder instead of reading as the whole window", () => {
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
  const section = md.slice(md.indexOf("## Landed in the window"));
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
  // only budget_fallback, fleet_paused, build_stale, config_changed and tick_deferred. Each
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
      "budget paused — 3 ticks failed on fallback omlx/qwen",
    ],
    [
      // The real incident's pair: the whole cause survives the digest's line cap.
      { type: "budget_paused", spentUsd: 10, capUsd: 10, fallbackDemoted: "omlx/Qwen3.8-27B-MLX-oQ4e-mtp", failures: 3 },
      "budget paused — 3 ticks failed on fallback omlx/Qwen3.8-27B-MLX-oQ4",
    ],
    [{ type: "budget_resumed", spentUsd: 4, capUsd: 10 }, "budget resumed ($4.00 of $10.00 today)"],
    [{ type: "fleet_resumed" }, "fleet resumed — role loops tick again"],
    [
      { type: "role_paused", role: "docs" },
      "role docs paused — it stops starting new ticks",
    ],
    [{ type: "role_resumed", role: "docs" }, "role docs resumed — it ticks again"],
    // The fleet-wide 429 hold (BUGS.md 2026-09-21 "A 429 storm still has no fleet-wide hold"):
    // who tripped it and for how long, a relapse named, and the automatic re-open.
    [
      { type: "rate_limit_hold", roles: ["bugfix", "coverage"], holdMs: 60_000, escalation: 0 },
      "429 hold for 60s — bugfix, coverage",
    ],
    [
      { type: "rate_limit_hold", roles: ["dry", "feature"], holdMs: 240_000, escalation: 2 },
      "429 hold for 4m (relapse 2) — dry, feature",
    ],
    [{ type: "rate_limit_resumed" }, "429 hold lifted — role loops tick again"],
    [{ type: "max_concurrent_changed", from: 3, to: 5 }, "maxConcurrent 3 → 5"],
    [{ type: "retention_changed", from: 7, to: 14 }, "sessionRetentionDays 7 → 14"],
    [{ type: "config_changed", keys: "not-an-array" }, "config changed"],
    [{ type: "config_changed" }, "config changed"],
    [
      { type: "restart_pending", head: "a".repeat(40) },
      "restart pending — main aaaaaaaa green; compiling",
    ],
    [{ type: "restart", to: "b".repeat(40) }, "restarting onto build bbbbbbbb"],
    [
      { type: "restart_refused", to: "b".repeat(40), reason: "not initialized" },
      "restart onto bbbbbbbb refused: not initialized",
    ],
    [
      { type: "restart_blocked", from: "a".repeat(40), to: "b".repeat(40), reason: "rebuild of bbbbbbbb failed" },
      "restart blocked — rebuild of bbbbbbbb fail; staying on build aaaaaa",
    ],
    [{ type: "supervisor_exit", generation: 2, code: 1, reason: "not initialized" }, "fleet down — generation 2 exited 1: not initialized"],
    [{ type: "supervisor_exit", generation: 1, code: null, signal: "SIGKILL" }, "fleet down — generation 1 killed by SIGKILL"],
    [
      { type: "orchestrator_start", pid: 4321, build: "c".repeat(40) },
      "orchestrator started (pid 4321, build cccccccc)",
    ],
    [{ type: "orchestrator_start", pid: 4321 }, "orchestrator started (pid 4321)"],
    [{ type: "orchestrator_stop" }, "orchestrator stopped"],
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
    { ts: at(0), loop: "feature", type: "tick_end", result: "error", error: "pi exited null" },
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed" },
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
    { ts: at(0), loop: "feature", type: "tick_end", tick: 1, result: "error", error: "pi exited null", durationMs: 5_000, costUsd: 0.02 },
  ]);
  const ok = await runCli(root, "report", "--failures", "--json");
  assert.equal(ok.code, 0);
  const parsed = JSON.parse(ok.out) as { ticks: number; timeSpend: unknown[]; lossCauses: unknown[] };
  assert.equal(parsed.ticks, 1);
  assert.ok(Array.isArray(parsed.timeSpend) && parsed.timeSpend.length === 1, "the time-and-spend table rides the JSON");
  assert.ok(Array.isArray(parsed.lossCauses) && parsed.lossCauses.length === 1, "the loss ranking rides the JSON");
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
      type: "tick_end",
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
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed", promptTokens: 100, preEditPromptTokens: 40 },
    { ts: at(0), loop: "feature", type: "tick_end", result: "no_change", promptTokens: 300, preEditPromptTokens: 20 },
    // A tick without the prompt-token fields contributes nothing and does not zero the median.
    { ts: at(0), loop: "feature", type: "tick_end", result: "queued" },
    { ts: at(0), loop: "bugfix", type: "tick_end", result: "changed", promptTokens: 50, cacheReadTokens: 40, preEditPromptTokens: 50 },
  ]);
  const data = collectFailureReport(root, 1);
  const feature = data.promptStats.find((r) => r.role === "feature");
  assert.deepEqual(feature, { role: "feature", ticks: 2, medianPromptTokens: 200, preEditShare: 0.15 });
  const bugfix = data.promptStats.find((r) => r.role === "bugfix");
  assert.deepEqual(bugfix, { role: "bugfix", ticks: 1, medianPromptTokens: 50, preEditShare: 1 });

  const md = renderFailureMarkdown(data);
  assert.match(md, /^## Prompt tokens by role$/m);
  assert.match(md, /feature: median 200 prompt tokens\/tick · 15% before first edit/);
  assert.match(md, /bugfix: median 50 prompt tokens\/tick · 100% before first edit/);
});

test("a log without prompt-token fields renders no prompt section", () => {
  const root = tmpdir();
  writeEvents(root, [
    { ts: at(0), loop: "feature", type: "tick_end", result: "changed", tokens: 500 },
  ]);
  const data = collectFailureReport(root, 1);
  assert.deepEqual(data.promptStats, []);
  assert.doesNotMatch(renderFailureMarkdown(data), /Prompt tokens by role/);
});
