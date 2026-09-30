// One metric set, one definition, for every unit: each OSS baseline repo, tumwater as a whole,
// and tumwater's code split by line author (Tumwater / Claude, via blame.json).
//
// Usage: node compare.cjs <data-dir>
//   reads <data-dir>/metrics.json + blame.json (tumwater) and <data-dir>/oss/<name>.json for each
//   repo in oss-repos.tsv; writes <data-dir>/compare.json and prints the table plus a breakdown of
//   decision points by kind. Production = "src…" categories, tests = "test…".
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DATA = path.resolve(process.argv[2]);
const REPOS = fs.readFileSync(path.join(__dirname, "oss-repos.tsv"), "utf8").split("\n")
  .filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0]);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); if (!a.length) return NaN; const i = (a.length - 1) * p, lo = Math.floor(i); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo); };

function dupLineSets(sel, W = 50, minLines = 5) {
  const map = new Map();
  for (const f of sel) {
    const t = f.tokens;
    for (let i = 0; i + W <= t.length; i++) {
      const h = crypto.createHash("md5").update(t.slice(i, i + W).map((x) => x[1]).join("\u0001")).digest("base64");
      let arr = map.get(h);
      if (!arr) map.set(h, (arr = []));
      arr.push([f, i]);
    }
  }
  const out = new Map();
  for (const arr of map.values()) {
    if (arr.length < 2) continue;
    for (const [f, i] of arr) {
      if (f.tokens[i + W - 1][2] - f.tokens[i][2] + 1 < minLines) continue;
      let s = out.get(f.file);
      if (!s) out.set(f.file, (s = new Set()));
      for (let k = i; k < i + W; k++) s.add(f.tokens[k][2]);
    }
  }
  return out;
}

/** keep(file, line): whether a line belongs to the unit; fnKeep(fn): whether a function does
 * (by majority author). `whole` adds the metrics that only make sense for a whole repo. */
function metrics(M, keep, fnKeep, { whole = false, testRatio = true } = {}) {
  const prod = M.files.filter((f) => f.cat.startsWith("src") && f.cls);
  const test = M.files.filter((f) => f.cat.startsWith("test") && f.cls && f.lang !== "sh");
  const count = (files, ch) => sum(files.map((f) => { let n = 0; for (let i = 0; i < f.cls.length; i++) if (f.cls[i] === ch && keep(f.file, i)) n++; return n; }));
  const pc = count(prod, "c"), pm = count(prod, "m"), tc = count(test, "c"), tm = count(test, "m");
  const mk = (k) => sum(prod.map((f) => (f.markers?.[k] || []).filter((l) => keep(f.file, l)).length));
  const fns = M.functions.filter((f) => f.cat.startsWith("src") && fnKeep(f));
  const cc = fns.map((f) => f.cc), cog = fns.map((f) => f.cog), len = fns.map((f) => f.codeLines);
  const dupCount = (d) => { let n = 0; for (const [file, s] of d) for (const l of s) if (keep(file, l)) n++; return n; };
  const fileCode = prod.map((f) => f.code);
  return {
    prodSLOC: pc, testSLOC: tc, testRatio: testRatio ? tc / pc : NaN,
    cmtProd: pm / (pc + pm), cmtTest: tm / (tc + tm),
    decisionsPerK: (1000 * mk("decision")) / pc,
    fnN: fns.length, fnPerK: (1000 * fns.length) / pc,
    ccMean: sum(cc) / cc.length, ccMed: q(cc, 0.5), ccP90: q(cc, 0.9), cc10: cc.filter((x) => x > 10).length / cc.length,
    cc20PerK: (1000 * cc.filter((x) => x > 20).length) / pc, ccMax: Math.max(...cc),
    cogMean: sum(cog) / cog.length, cog15: cog.filter((x) => x > 15).length / cog.length,
    lenMean: sum(len) / len.length, lenMed: q(len, 0.5), lenP90: q(len, 0.9), len50: len.filter((x) => x > 50).length / len.length,
    params: sum(fns.map((f) => f.params)) / fns.length, depth: sum(fns.map((f) => f.depth)) / fns.length, mi: sum(fns.map((f) => f.mi)) / fns.length,
    asPerK: (1000 * mk("as")) / pc, nonNullPerK: (1000 * mk("nonNull")) / pc, anyPerK: (1000 * mk("any")) / pc, todoPerK: (1000 * mk("todo")) / pc,
    suppressPerK: whole ? (1000 * sum(prod.map((f) => (f.tsIgnore || 0) + (f.eslintDisable || 0)))) / pc : NaN,
    dupProd: dupCount(dupLineSets(prod.filter((f) => f.tokens))) / pc, dupTest: dupCount(dupLineSets(test.filter((f) => f.tokens))) / tc,
    fileMed: whole ? q(fileCode, 0.5) : NaN, fileP90: whole ? q(fileCode, 0.9) : NaN, fileMax: whole ? Math.max(...fileCode) : NaN,
    files500: whole ? fileCode.filter((x) => x > 500).length / fileCode.length : NaN,
    proseWordsPerK: whole ? (1000 * sum(M.files.filter((f) => f.cat === "docs:prose").map((f) => f.words || 0))) / pc : NaN,
  };
}

/** Decision points by kind per 1000 production code lines, from tokens (`?:` ternaries excluded). */
function decisionKinds(M, keep) {
  const c = { "??": 0, "&&": 0, "||": 0, if: 0, loops: 0, case: 0, catch: 0, "?.": 0 };
  let code = 0;
  for (const f of M.files) {
    if (!f.cat.startsWith("src") || !f.tokens) continue;
    for (let i = 0; i < f.cls.length; i++) if (f.cls[i] === "c" && keep(f.file, i)) code++;
    for (const [, t, l] of f.tokens) {
      if (!keep(f.file, l)) continue;
      if (t === "??" || t === "??=") c["??"]++;
      else if (t === "&&" || t === "&&=") c["&&"]++;
      else if (t === "||" || t === "||=") c["||"]++;
      else if (t === "if") c.if++;
      else if (t === "for" || t === "while") c.loops++;
      else if (t === "case") c.case++;
      else if (t === "catch") c.catch++;
      else if (t === "?.") c["?."]++;
    }
  }
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, (1000 * v) / code]));
}

const out = {}, kinds = {};
const all = () => true;
for (const r of REPOS) {
  const M = JSON.parse(fs.readFileSync(path.join(DATA, "oss", r + ".json"), "utf8"));
  out[r] = metrics(M, all, all, { whole: true });
  kinds[r] = decisionKinds(M, all);
}
{
  const M = JSON.parse(fs.readFileSync(path.join(DATA, "metrics.json"), "utf8"));
  const BL = JSON.parse(fs.readFileSync(path.join(DATA, "blame.json"), "utf8")).files;
  const who = (c) => (c === "tumwater" ? "tumwater" : c && c.startsWith("claude") ? "claude" : "human");
  const lineAuthor = (file, l) => who(BL[file]?.cls[l]);
  const fileIdx = new Map(M.files.map((f) => [f.file, f]));
  for (const fn of M.functions) {
    const f = fileIdx.get(fn.file);
    let tw = 0, cl = 0;
    for (let l = fn.line - 1; l < fn.line - 1 + fn.span; l++) if (f.cls[l] === "c") { const a = lineAuthor(fn.file, l); if (a === "tumwater") tw++; else if (a === "claude") cl++; }
    fn._au = tw >= cl ? "tumwater" : "claude";
  }
  const by = (a) => [(f, l) => lineAuthor(f, l) === a, (fn) => fn._au === a];
  out["tumwater repo"] = metrics(M, all, all, { whole: true });
  out["Tumwater"] = metrics(M, ...by("tumwater"));
  out["Claude"] = metrics(M, ...by("claude"));
  // like-for-like: core src only (src/ui/ dropped: much of Claude's share there is CSS)
  const core = { ...M, files: M.files.map((f) => (f.cat === "src/ui" ? { ...f, cat: "x-ui" } : f)), functions: M.functions.filter((fn) => fn.cat !== "src/ui") };
  out["Tumwater core"] = metrics(core, ...by("tumwater"), { testRatio: false });
  out["Claude core"] = metrics(core, ...by("claude"), { testRatio: false });
  kinds["Tumwater"] = decisionKinds(M, by("tumwater")[0]);
  kinds["Claude"] = decisionKinds(M, by("claude")[0]);
  kinds["Tumwater core"] = decisionKinds(core, by("tumwater")[0]);
  kinds["Claude core"] = decisionKinds(core, by("claude")[0]);
}
for (const k of Object.keys(out[REPOS[0]])) {
  const vals = REPOS.map((r) => out[r][k]).filter(Number.isFinite);
  (out["OSS median"] ||= {})[k] = q(vals, 0.5);
  (out["OSS min"] ||= {})[k] = Math.min(...vals);
  (out["OSS max"] ||= {})[k] = Math.max(...vals);
}
fs.writeFileSync(path.join(DATA, "compare.json"), JSON.stringify({ metrics: out, decisionKinds: kinds }, null, 1));

const pct = new Set(["cmtProd", "cmtTest", "cc10", "cog15", "len50", "dupProd", "dupTest", "files500"]);
const fmt = (k, v) => (!Number.isFinite(v) ? "-" : pct.has(k) ? (100 * v).toFixed(1) + "%" : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
const cols = [...REPOS, "OSS median", "tumwater repo", "Tumwater", "Claude", "Tumwater core", "Claude core"];
const short = (c) => ({ "npm-check-updates": "ncu", "graphql-js": "graphql", "socket.io": "sock.io", "OSS median": "OSS med", "tumwater repo": "repo", "Tumwater core": "Tw-core", "Claude core": "Cl-core" })[c] || c;
console.log("metric".padEnd(16) + cols.map((c) => short(c).padStart(9)).join(""));
for (const k of Object.keys(out[REPOS[0]])) console.log(k.padEnd(16) + cols.map((c) => fmt(k, out[c][k]).padStart(9)).join(""));
console.log("\ndecision points by kind, per 1000 production code lines:");
for (const [u, c] of Object.entries(kinds)) console.log("  " + u.padEnd(18) + Object.entries(c).map(([k, v]) => `${k}:${v.toFixed(1)}`).join("  "));
