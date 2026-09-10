import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReport, renderReportMarkdown, type ReportData } from "../src/report.js";
import { makeRepo, tmpdir } from "./util.js";

// The report buckets by LOCAL calendar day, so fixtures build timestamps from local date parts
// (never UTC strings) and compute expected keys the same way.
function at(daysAgo: number, hour = 12): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function keyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Write events.jsonl under the fixture root's .tumwater/log/ (strings pass through verbatim —
 * for malformed lines; objects are JSON-encoded like logEvent writes them). */
function writeEvents(root: string, lines: unknown[]): void {
  const file = path.join(root, ".tumwater", "log", "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
}

test("collectReport buckets tick_end/merged events by local day and totals them", () => {
  const root = tmpdir();
  writeEvents(root, [
    // Out of the 5-day window (7 days ago) — must not count.
    JSON.stringify({ ts: at(6), loop: "feature", type: "tick_end", tick: 1, result: "no_change", tokens: 999 }),
    JSON.stringify({ ts: at(4), loop: "feature", type: "tick_end", tick: 2, result: "changed", tokens: 500, costUsd: 0.5 }),
    // No tokens/costUsd fields — counts as a tick with zero spend (omitted when zero in the log).
    JSON.stringify({ ts: at(4), loop: "bugfix", type: "tick_end", tick: 3, result: "no_change" }),
    "this line is not json", // malformed lines are ignored
    JSON.stringify({ ts: at(3), loop: "feature", type: "merged", commit: "abc1234", summary: "x" }),
    // Gap day (at 2) stays zero-filled.
    JSON.stringify({ ts: at(1), loop: "feature", type: "tick_end", tick: 5, result: "changed", tokens: 1500, costUsd: 1.25 }),
    JSON.stringify({ ts: at(0), loop: "steward", type: "merged", commit: "def5678", summary: "y" }),
    JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 6, result: "no_change", tokens: 10 }),
  ]);
  const data = collectReport(root, 5);

  assert.equal(data.days, 5);
  assert.equal(data.from, keyOf(at(4)));
  assert.equal(data.to, keyOf(at(0)));
  assert.equal(data.series.length, 5);
  for (let i = 1; i < data.series.length; i++) {
    const prev = data.series[i - 1]?.date ?? "";
    const cur = data.series[i]?.date ?? "";
    assert.ok(cur > prev, "series is oldest→newest");
  }

  const d0 = data.series[0]; // at(4)
  assert.equal(d0?.tokensOut, 500);
  assert.deepEqual(d0?.ticksByRole, { feature: 1, bugfix: 1 });
  assert.ok(Math.abs((d0?.costUsd ?? -1) - 0.5) < 1e-9);
  const d1 = data.series[1]; // at(3): a commit day with no ticks
  assert.equal(d1?.commits, 1);
  assert.equal(d1?.tokensOut, 0);
  const d2 = data.series[2]; // at(2): zero-filled gap
  assert.deepEqual(d2, { date: keyOf(at(2)), tokensOut: 0, ticksByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 });
  const d3 = data.series[3]; // at(1)
  assert.equal(d3?.tokensOut, 1500);
  assert.ok(Math.abs((d3?.costUsd ?? -1) - 1.25) < 1e-9);
  const d4 = data.series[4]; // today
  assert.equal(d4?.commits, 1);
  assert.deepEqual(d4?.ticksByRole, { feature: 1 });

  assert.equal(data.totals.tokensOut, 2010);
  assert.equal(data.totals.ticks, 4);
  assert.equal(data.totals.commits, 2);
  assert.ok(Math.abs(data.totals.costUsd - 1.75) < 1e-9);
  assert.equal(data.totals.featuresDone, 0);
  assert.equal(data.totals.bugsFixed, 0);
});

test("collectReport reads a grown event log with bounded backwards I/O", () => {
  const root = tmpdir();
  // ~250 KB of out-of-window history (well past the 8 KB whole-read threshold) plus three
  // in-window events: the tail scan must stop at the window, not rescan the file.
  const lines: unknown[] = [];
  for (let i = 0; i < 2500; i++) {
    lines.push(JSON.stringify({ ts: at(40), loop: "feature", type: "tick_end", tick: i, result: "no_change", tokens: 1 }));
  }
  lines.push(JSON.stringify({ ts: at(3), loop: "bugfix", type: "merged", commit: "aaa", summary: "old" }));
  lines.push(JSON.stringify({ ts: at(0), loop: "feature", type: "tick_end", tick: 9, result: "changed", tokens: 777 }));
  writeEvents(root, lines);

  const data = collectReport(root, 7);
  assert.equal(data.totals.tokensOut, 777); // the 2500 old ticks are out of window
  assert.equal(data.totals.ticks, 1);
  assert.equal(data.totals.commits, 1);
  const today = data.series[data.series.length - 1];
  assert.deepEqual(today?.ticksByRole, { feature: 1 });
});

test("collectReport counts features done and bugs fixed from backlog history", () => {
  const root = tmpdir();
  const d1 = keyOf(at(4));
  const d2 = keyOf(at(3));
  const d3 = keyOf(at(2));
  const dOld = keyOf(at(30)); // out of the 5-day window

  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    [
      "# Plans",
      "",
      "## Planned",
      "",
      `### Still planned (planned ${keyOf(at(1))})`,
      "",
      `Body prose that mentions done ${d2} — the Planned section is never scanned.`,
      "",
      "## Done",
      "",
      `### Full heading entry (planned 2026-09-01, done ${d1})`,
      "",
      `**Goal.** Body prose that says done ${d3} — only the heading's metadata counts.`,
      "",
      "- acceptance bullet without a date",
      "",
      // The real-world false positive: a body bullet whose following prose paragraph carries a
      // lowercase cross-reference to another entry must not count as that other entry.
      `**Relationship to other plans.** Sibling of the done daily-cost-budget plan (done ${d2}) — never counted.`,
      "",
      "### Wrapped heading entry (planned 2026-09-02, done", // date lands on the second line
      `${d2})`,
      "",
      "Body.",
      "",
      `- Compressed epitaph (planned 2026-08-25, done ${d3}; commit abc1234)`,
      "- No date epitaph (planned 2026-08-20; commit def5678)",
      `- Out-of-window epitaph (planned 2026-07-01, done ${dOld}; commit 9999999)`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "BUGS.md"),
    [
      "# Bugs",
      "",
      "## Open",
      "",
      `### Still open (found by qa loop ${keyOf(at(1))})`,
      "",
      "Body.",
      "",
      "## Fixed",
      "",
      `### Full fixed entry (found by bugfix loop 2026-09-05, fixed ${d2})`,
      "",
      "**Symptom:** Body with a repro bullet that carries no date.",
      "",
      "- repro step one",
      "",
      `- Closed variant (reported 2026-08-30, closed ${d1}; commit abc)`,
      `- Resolved variant (found by human log analysis 2026-09-04, resolved ${d3}; commit def)`,
      `- Old epitaph (reported 2026-07-01, fixed ${dOld}; commit 8888888)`,
      "",
    ].join("\n"),
  );

  const data = collectReport(root, 5);
  const byDate = new Map(data.series.map((d) => [d.date, d]));

  assert.equal(byDate.get(d1)?.featuresDone, 1); // full heading
  assert.equal(byDate.get(d2)?.featuresDone, 1); // wrapped heading — the body's "done" prose did not add one
  assert.equal(byDate.get(d3)?.featuresDone, 1); // compressed epitaph only (the body mention of d3 did not count)
  assert.equal(byDate.get(dOld)?.featuresDone ?? 0, 0);

  assert.equal(byDate.get(d1)?.bugsFixed, 1); // closed variant
  assert.equal(byDate.get(d2)?.bugsFixed, 1); // full heading (fixed)
  assert.equal(byDate.get(d3)?.bugsFixed, 1); // resolved variant
  assert.equal(data.totals.featuresDone, 3);
  assert.equal(data.totals.bugsFixed, 3);
});

test("collectReport degrades to zeros when every source is missing", () => {
  const root = tmpdir(); // no .tumwater/, no PLANS.md, no BUGS.md
  const data = collectReport(root, 3);
  assert.equal(data.days, 3);
  assert.equal(data.from, keyOf(at(2)));
  assert.equal(data.to, keyOf(at(0)));
  for (const d of data.series) {
    assert.deepEqual(d.ticksByRole, {});
    assert.equal(d.tokensOut + d.commits + d.costUsd + d.featuresDone + d.bugsFixed, 0);
  }
  assert.deepEqual(data.totals, { tokensOut: 0, ticks: 0, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 });
});

test("renderReportMarkdown pins the header, totals, table shape, and role line", () => {
  const from = "2026-09-08";
  const to = "2026-09-10";
  const data: ReportData = {
    days: 3,
    from,
    to,
    series: [
      { date: "2026-09-08", tokensOut: 0, ticksByRole: {}, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: "2026-09-09", tokensOut: 600_000, ticksByRole: { feature: 3, bugfix: 1 }, commits: 2, costUsd: 0.86, featuresDone: 1, bugsFixed: 0 },
      { date: "2026-09-10", tokensOut: 1_234_567, ticksByRole: { feature: 2 }, commits: 1, costUsd: 1.48, featuresDone: 0, bugsFixed: 1 },
    ],
    totals: { tokensOut: 1_834_567, ticks: 6, commits: 3, costUsd: 2.34, featuresDone: 1, bugsFixed: 1 },
  };
  const lines = renderReportMarkdown(data).split("\n");

  assert.equal(lines[0], "# tumwater usage report");
  assert.equal(lines[1], "");
  assert.equal(lines[2], `Window: ${from} → ${to} (3 days) · source: events.jsonl (rotated at 16 MB)`);
  assert.equal(lines[3], "");
  assert.equal(
    lines[4],
    "**Totals:** 1.8M output tokens · 6 ticks · 3 commits · $2.34 · 1 features done · 1 bugs fixed",
  );
  assert.equal(lines[5], "");
  assert.equal(lines[6], "| day | tokens out | ticks | commits | cost |");
  assert.equal(lines[7], "| --- | ---: | ---: | ---: | ---: |");
  // Zero day: no bar, token count as-is.
  assert.equal(lines[8], `| 09-08 | 0 | 0 | 0 | $0.00 |`);
  // Middle day: one decimal + k suffix; bar = round(20·600000/1234567) = 10 blocks.
  assert.equal(lines[9], `| 09-09 | 600.0k ${"█".repeat(10)} | 4 | 2 | $0.86 |`);
  // Max day: exactly 20 blocks; M suffix above a million.
  assert.equal(lines[10], `| 09-10 | 1.2M ${"█".repeat(20)} | 2 | 1 | $1.48 |`);
  assert.equal(lines[11], "");
  // Window totals per role: feature 3+2=5 before bugfix 1 (count desc).
  assert.equal(lines[12], "**Ticks by role:** feature — 5 · bugfix — 1");
});

test("renderReportMarkdown shows no bars for an all-zero window and min width 1 above zero", () => {
  const data = collectReport(tmpdir(), 3); // every source missing → all zeros
  const md = renderReportMarkdown(data);
  assert.ok(!md.includes("█"), "no bars when every day is zero");
  for (const d of data.series) {
    assert.match(md, new RegExp(`\\| ${d.date.slice(5)} \\| 0 \\| 0 \\| 0 \\| \\$0\\.00 \\|`));
  }
  assert.match(md, /\*\*Ticks by role:\*\* -/);

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
      { date: base.from, tokensOut: 0, ticksByRole: { zeta: 5, alpha: 5 }, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
      { date: base.to, tokensOut: 0, ticksByRole: { beta: 2 }, commits: 0, costUsd: 0, featuresDone: 0, bugsFixed: 0 },
    ],
    totals: { ...base.totals, ticks: 12 },
  };
  assert.match(renderReportMarkdown(data), /\*\*Ticks by role:\*\* alpha — 5 · zeta — 5 · beta — 2/);
});

// The CLI runs main() on import and reports failures via process.exit, so it is tested as a
// child process: the built dist/src/cli.js with cwd set to a temp repo (same pattern as cli.test.ts).
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

test("tumwater report prints the Markdown report and validates --days", async () => {
  const root = makeRepo();
  writeEvents(root, [
    JSON.stringify({ ts: at(3), loop: "feature", type: "tick_end", tick: 1, result: "no_change", tokens: 313 }),
    JSON.stringify({ ts: at(0), loop: "bugfix", type: "tick_end", tick: 2, result: "changed", tokens: 42 }),
  ]);
  fs.writeFileSync(
    path.join(root, "PLANS.md"),
    `# Plans\n\n## Planned\n\n## Done\n\n- Epitaph (planned 2026-09-01, done ${keyOf(at(0))}; commit abc)\n`,
  );

  const full = await runCli(root, "report");
  assert.equal(full.code, 0);
  assert.match(full.out, /^# tumwater usage report/m);
  assert.match(full.out, /\(14 days\)/); // default window
  assert.match(full.out, /355 output tokens/); // 313 + 42 in the totals line
  assert.match(full.out, /1 features done/);

  const one = await runCli(root, "report", "--days", "1");
  assert.equal(one.code, 0);
  assert.match(one.out, new RegExp(`\\| ${keyOf(at(0)).slice(5)} \\| 42`)); // today only…
  assert.ok(!one.out.includes("313"), "…and the older day is outside a 1-day window");

  for (const bad of ["0", "abc"]) {
    const r = await runCli(root, "report", "--days", bad);
    assert.notEqual(r.code, 0, `--days ${bad} fails`);
    assert.match(r.out, /--days needs a positive integer/);
  }
});
