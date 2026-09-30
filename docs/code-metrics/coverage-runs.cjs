// tumwater's src/ coverage split by line author (Tumwater / Claude, per blame.py), for each of one
// or more suite runs, then averaged: which paths a run exercises depends on timing, so one run's
// numbers wobble by tenths of a point and single files by far more.
//
// Usage: node coverage-runs.cjs <data-dir>
//   reads <data-dir>/metrics.json, blame.json, and every coverage-ts-<k>.json (coverage.cjs, one
//   per run) plus the matching coverage-run-<k>.txt (the run's own output, for node's table and
//   the test tally); writes <data-dir>/coverage-runs.json and prints the summary.
//
// Only runs whose suite passed (fail 0, node's table printed) enter the averages: a run that fails
// mid-way — on a loaded host a timing-sensitive test can, and a failed `tumwater run` e2e test can
// leak its orchestrator and hang the file until the runner's 30-minute timeout — exercises a
// different set of paths. Excluded runs are listed with their own numbers.
//
// Attribution matches authors.cjs: an executable code line, a branch, or a function goes to the
// author of the TS line it starts on. Per run, per scope (all of src/, core = src/ without
// src/ui/, ui): covered / total for lines, branches, functions. Across runs: mean, sample standard
// deviation, min, max. Lines — whose identity (file, line) is fixed by the source maps — also get
// an envelope: covered in every run (the stable floor) vs covered in at least one run (the ceiling);
// the gap between them is coverage that depends on timing.
const fs = require("fs");
const path = require("path");
const DATA = path.resolve(process.argv[2]);
const M = JSON.parse(fs.readFileSync(path.join(DATA, "metrics.json"), "utf8"));
const BL = JSON.parse(fs.readFileSync(path.join(DATA, "blame.json"), "utf8")).files;
const runs = fs.readdirSync(DATA).map((f) => /^coverage-ts-(\d+)\.json$/.exec(f)).filter(Boolean)
  .map((m) => Number(m[1])).sort((a, b) => a - b);
if (!runs.length) { console.error(`no coverage-ts-<k>.json in ${DATA}`); process.exit(1); }
const who = (c) => (c === "tumwater" ? "tumwater" : c && c.startsWith("claude") ? "claude" : "human");
const authorOf = (file, line) => who(BL[file]?.cls[line]);
const fileIdx = new Map(M.files.map((f) => [f.file, f]));
const A = ["tumwater", "claude"];
const SCOPES = { all: (cat) => cat.startsWith("src"), core: (cat) => cat === "src", ui: (cat) => cat === "src/ui" };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const stats = (xs) => {
  const mean = sum(xs) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(sum(xs.map((x) => (x - mean) ** 2)) / (xs.length - 1)) : 0;
  return { mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
};

const perRun = []; // [{ run, ok, node, tests, split: { scope: { author: { l, lc, b, bc, fn, fc } } } }]
const lineCov = new Map(); // run → Map("file:line" → covered 0/1), aggregated over passing runs below
for (const k of runs) {
  const cov = JSON.parse(fs.readFileSync(path.join(DATA, `coverage-ts-${k}.json`), "utf8"));
  const split = Object.fromEntries(Object.keys(SCOPES).map((s) => [s, Object.fromEntries(A.map((a) => [a, { l: 0, lc: 0, b: 0, bc: 0, fn: 0, fc: 0 }]))]));
  const runLines = new Map();
  lineCov.set(k, runLines);
  for (const [file, c] of Object.entries(cov)) {
    const f = fileIdx.get(file);
    if (!f) continue;
    const scopes = Object.keys(SCOPES).filter((s) => SCOPES[s](f.cat));
    for (const [ln, covd] of c.lines) {
      if (f.cls[ln] !== "c") continue;
      runLines.set(`${file}:${ln}`, covd ? 1 : 0);
      const a = authorOf(file, ln);
      if (!A.includes(a)) continue;
      for (const s of scopes) { split[s][a].l++; if (covd) split[s][a].lc++; }
    }
    for (const [ln, covd] of c.branches) {
      const a = ln == null ? null : authorOf(file, ln);
      if (!A.includes(a)) continue;
      for (const s of scopes) { split[s][a].b++; if (covd) split[s][a].bc++; }
    }
    for (const [ln, covd] of c.funcs) {
      const a = ln == null ? null : authorOf(file, ln);
      if (!A.includes(a)) continue;
      for (const s of scopes) { split[s][a].fn++; if (covd) split[s][a].fc++; }
    }
  }
  const txtPath = path.join(DATA, `coverage-run-${k}.txt`);
  const txt = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf8") : "";
  const table = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(txt);
  const tally = (name) => Number((new RegExp(`^ℹ ${name} (\\d+)`, "m").exec(txt) || [])[1]);
  perRun.push({
    run: k,
    ok: !!table && tally("fail") === 0,
    node: table ? { lines: +table[1], branches: +table[2], functions: +table[3] } : null,
    tests: { total: tally("tests"), pass: tally("pass"), fail: tally("fail"), skipped: tally("skipped") },
    split,
  });
}

const pct = (a, b) => (100 * a) / b;
const ok = perRun.filter((r) => r.ok);
if (!ok.length) { console.error("no passing run to average"); process.exit(1); }
const okRuns = new Set(ok.map((r) => r.run));
const summary = { runs: ok.length, excluded: perRun.filter((r) => !r.ok).map((r) => r.run), perRun, node: {}, split: {}, envelope: {}, variableFiles: [] };
for (const m of ["lines", "branches", "functions"]) {
  const xs = ok.map((r) => r.node[m]);
  if (xs.length) summary.node[m] = stats(xs);
}
for (const s of Object.keys(SCOPES)) {
  summary.split[s] = {};
  for (const a of A) {
    const get = (num, den) => stats(ok.map((r) => pct(r.split[s][a][num], r.split[s][a][den])));
    summary.split[s][a] = { lines: get("lc", "l"), branches: get("bc", "b"), functions: get("fc", "fn") };
  }
}
// line envelope per author and scope over the passing runs: covered in all of them / in at least one
const lineRuns = new Map(); // "file:line" → number of passing runs that covered it
const fileLines = new Map(); // file → covered-line count per passing run
for (const k of okRuns) {
  const perFile = new Map();
  for (const [key, covd] of lineCov.get(k)) {
    lineRuns.set(key, (lineRuns.get(key) || 0) + covd);
    const file = key.slice(0, key.lastIndexOf(":"));
    perFile.set(file, (perFile.get(file) || 0) + covd);
  }
  for (const [file, n] of perFile) (fileLines.get(file) || fileLines.set(file, []).get(file)).push(n);
}
for (const s of Object.keys(SCOPES)) {
  summary.envelope[s] = {};
  for (const a of A) {
    let n = 0, all = 0, any = 0;
    for (const [key, cnt] of lineRuns) {
      const i = key.lastIndexOf(":");
      const file = key.slice(0, i), ln = Number(key.slice(i + 1));
      const f = fileIdx.get(file);
      if (!SCOPES[s](f.cat) || authorOf(file, ln) !== a) continue;
      n++;
      if (cnt === okRuns.size) all++;
      if (cnt > 0) any++;
    }
    summary.envelope[s][a] = { lines: n, everyRun: pct(all, n), anyRun: pct(any, n), sometimes: any - all, never: n - any };
  }
}
for (const [file, xs] of fileLines) {
  const st = stats(xs);
  if (st.max > st.min) {
    let tw = 0, cl = 0; // authors of the lines that flip between runs
    for (const [key, cnt] of lineRuns) {
      if (!key.startsWith(file + ":") || cnt === 0 || cnt === okRuns.size) continue;
      if (authorOf(file, Number(key.slice(file.length + 1))) === "tumwater") tw++; else cl++;
    }
    summary.variableFiles.push({ file, minCovered: st.min, maxCovered: st.max, flippingLines: { tumwater: tw, claude: cl } });
  }
}
summary.variableFiles.sort((x, y) => (y.maxCovered - y.minCovered) - (x.maxCovered - x.minCovered));
fs.writeFileSync(path.join(DATA, "coverage-runs.json"), JSON.stringify(summary, null, 1));

const f2 = (x) => x.toFixed(2);
const show = (st) => `${f2(st.mean)} ±${f2(st.sd)} [${f2(st.min)}–${f2(st.max)}]`;
console.log(`${perRun.length} run(s): ${perRun.map((r) => `#${r.run} ${r.tests.pass}/${r.tests.total} pass, ${r.tests.fail} fail`).join("; ")}`);
console.log(`averaging the ${ok.length} passing run(s)${summary.excluded.length ? `; excluded (suite failed): ${summary.excluded.map((k) => "#" + k).join(" ")}` : ""}`);
if (summary.node.lines) console.log(`node's table, all files: lines ${show(summary.node.lines)}  branches ${show(summary.node.branches)}  functions ${show(summary.node.functions)}`);
for (const s of Object.keys(SCOPES)) {
  console.log(`\n== ${s} — mean ±sd [min–max] over ${ok.length} passing run(s)`);
  for (const a of A) {
    const x = summary.split[s][a], e = summary.envelope[s][a];
    console.log(`  ${a.padEnd(9)} lines ${show(x.lines)}  branches ${show(x.branches)}  functions ${show(x.functions)}`);
    console.log(`  ${"".padEnd(9)} line envelope: ${f2(e.everyRun)}% in every run, ${f2(e.anyRun)}% in at least one (${e.sometimes} lines flip, ${e.never} never covered, of ${e.lines})`);
  }
}
console.log("\nfiles whose covered-line count varies between runs (min–max covered, flipping lines by author):");
for (const v of summary.variableFiles.slice(0, 12))
  console.log(`  ${v.file.padEnd(36)} ${v.minCovered}–${v.maxCovered}  tumwater ${v.flippingLines.tumwater}, claude ${v.flippingLines.claude}`);
