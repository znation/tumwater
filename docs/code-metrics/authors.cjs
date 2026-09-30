// tumwater's metrics split by who wrote each line: Tumwater (its own role loops) or Claude
// (human-directed Claude Code sessions), per blame.py.
//
// Usage: SRC_SCOPE=all|core|ui node authors.cjs <data-dir>
//   reads <data-dir>/metrics.json (analyze.cjs), blame.json (blame.py), and — if present —
//   coverage-ts.json (coverage.cjs). SRC_SCOPE picks the production code compared: all of src/,
//   core (src/ without src/ui/), or ui (src/ui/ only, where much of Claude's share is CSS).
//
// Lines and per-line markers go to the line's author. A function goes to the author of the
// majority of the code lines in its span; "pure" functions are >= 90% one author.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DATA = path.resolve(process.argv[2]);
const M = JSON.parse(fs.readFileSync(path.join(DATA, "metrics.json"), "utf8"));
const BL = JSON.parse(fs.readFileSync(path.join(DATA, "blame.json"), "utf8")).files;
const covPath = path.join(DATA, "coverage-ts.json");
const COV = fs.existsSync(covPath) ? JSON.parse(fs.readFileSync(covPath, "utf8")) : null;
const who = (c) => (c === "tumwater" ? "tumwater" : c.startsWith("claude") ? "claude" : "human");
const A = ["tumwater", "claude"];
const authorOf = (file, line) => { const b = BL[file]; return b && b.cls[line] ? who(b.cls[line]) : "unknown"; };
const sum = (a) => a.reduce((s, x) => s + x, 0);
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); if (!a.length) return NaN; const i = (a.length - 1) * p, lo = Math.floor(i); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo); };
const f1 = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const pc = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
const row = (label, vals) => console.log("  " + label.padEnd(40) + vals.map((v) => String(v).padStart(16)).join(""));
const hdr = (t) => { console.log("\n== " + t + " =="); row("", A); };

const SCOPE = process.env.SRC_SCOPE || "all";
const inScope = (cat) => (SCOPE === "core" ? cat === "src" : SCOPE === "ui" ? cat === "src/ui" : cat.startsWith("src"));
console.log(`SRC_SCOPE=${SCOPE}`);

// ---------- lines ----------
const groups = { src: (f) => inScope(f.cat), test: (f) => f.cat.startsWith("test"), scripts: (f) => f.cat === "scripts" };
const L = {}; // L[group][author] = { c, m, b }
for (const [g, pred] of Object.entries(groups)) {
  L[g] = {};
  for (const f of M.files.filter(pred)) {
    if (!f.cls) continue;
    for (let i = 0; i < f.cls.length; i++) ((L[g][authorOf(f.file, i)] ||= { c: 0, m: 0, b: 0 }))[f.cls[i]]++;
  }
}
hdr("Surviving lines (blame -w -M -C)");
for (const g of Object.keys(groups)) {
  const tot = sum(Object.values(L[g]).map((o) => o.c));
  row(`${g} code lines`, A.map((a) => `${L[g][a]?.c ?? 0} (${pc(L[g][a]?.c ?? 0, tot)})`));
  row(`${g} comment lines`, A.map((a) => L[g][a]?.m ?? 0));
  row(`${g} comment density`, A.map((a) => pc(L[g][a]?.m ?? 0, (L[g][a]?.c ?? 0) + (L[g][a]?.m ?? 0))));
}
console.log("  other authors:", JSON.stringify(Object.fromEntries(Object.entries(L).map(([g, o]) => [g, Object.fromEntries(Object.entries(o).filter(([a]) => !A.includes(a)))]))));
row("own test lines per own src line", A.map((a) => f1((L.test[a]?.c ?? 0) / (L.src[a]?.c ?? 1), 2)));
const md = M.files.filter((f) => f.lang === "md");
const W = { backlog: {}, prose: {} };
for (const f of md) {
  const k = f.cat === "docs:backlog" ? "backlog" : "prose";
  f.lineWords.forEach((w, i) => { const a = authorOf(f.file, i); W[k][a] = (W[k][a] || 0) + w; });
}
for (const k of ["backlog", "prose"]) { const t = sum(Object.values(W[k])); row(`markdown words: ${k}`, A.map((a) => `${W[k][a] || 0} (${pc(W[k][a] || 0, t)})`)); }
console.log("  Claude's share of each markdown file's words:", md.map((f) => {
  const c = {}; f.lineWords.forEach((w, i) => { const a = authorOf(f.file, i); c[a] = (c[a] || 0) + w; });
  return `${f.file}:${pc(c.claude || 0, sum(Object.values(c)))}`;
}).join(" "));

// ---------- line-level density ----------
hdr("Line-level density in src (per 1000 code lines)");
const srcFiles = M.files.filter(groups.src);
for (const mk of ["decision", "as", "nonNull", "any", "todo"]) {
  const cnt = { tumwater: 0, claude: 0 };
  for (const f of srcFiles) for (const ln of f.markers[mk]) { const a = authorOf(f.file, ln); if (a in cnt) cnt[a]++; }
  row(mk === "decision" ? "decision points (McCabe) /kLOC" : `${mk} /kLOC`, A.map((a) => `${f1((1000 * cnt[a]) / L.src[a].c, 1)} (${cnt[a]})`));
}

// ---------- functions ----------
const fileIdx = new Map(M.files.map((f) => [f.file, f]));
function fnAuthor(fn) {
  const f = fileIdx.get(fn.file);
  const c = { tumwater: 0, claude: 0, other: 0 };
  for (let l = fn.line - 1; l < fn.line - 1 + fn.span; l++) if (f.cls[l] === "c") { const a = authorOf(fn.file, l); c[a in c ? a : "other"]++; }
  const maj = c.tumwater >= c.claude ? "tumwater" : "claude";
  return { maj, share: c[maj] / (c.tumwater + c.claude + c.other || 1), c };
}
const srcFns = M.functions.filter((f) => inScope(f.cat)).map((fn) => ({ ...fn, au: fnAuthor(fn) }));
function fnStats(fns) {
  const cc = fns.map((f) => f.cc), cog = fns.map((f) => f.cog), len = fns.map((f) => f.codeLines);
  return {
    n: fns.length, ccMean: f1(sum(cc) / cc.length, 2), ccMed: q(cc, 0.5), ccP90: f1(q(cc, 0.9), 0), cc10: pc(cc.filter((x) => x > 10).length, cc.length),
    cc20: cc.filter((x) => x > 20).length, ccMax: Math.max(...cc), cogMean: f1(sum(cog) / cog.length, 2), cog15: pc(cog.filter((x) => x > 15).length, cog.length),
    lenMean: f1(sum(len) / len.length, 1), lenMed: q(len, 0.5), lenP90: f1(q(len, 0.9), 0), len50: pc(len.filter((x) => x > 50).length, len.length), len100: len.filter((x) => x > 100).length,
    params: f1(sum(fns.map((f) => f.params)) / fns.length, 2), depth: f1(sum(fns.map((f) => f.depth)) / fns.length, 2),
    mi: f1(sum(fns.map((f) => f.mi)) / fns.length, 1), miLow: fns.filter((f) => f.mi < 20).length,
  };
}
for (const [label, sel] of [["all src functions, by majority author", () => true], ["'pure' functions (>=90% one author)", (f) => f.au.share >= 0.9], ["top-level src functions only", (f) => f.nestedIn === 0]]) {
  hdr(label);
  const st = Object.fromEntries(A.map((a) => [a, fnStats(srcFns.filter((f) => f.au.maj === a && sel(f)))]));
  for (const k of Object.keys(st.tumwater)) row(k, A.map((a) => st[a][k]));
}
console.log(`  mixed-authorship functions (<90% one author): ${srcFns.filter((f) => f.au.share < 0.9).length}/${srcFns.length}; of the CC>20 functions: ${srcFns.filter((f) => f.cc > 20 && f.au.share < 0.9).length}/${srcFns.filter((f) => f.cc > 20).length} are mixed`);
for (const a of A) {
  console.log(`  top CC, majority ${a}:`);
  for (const f of srcFns.filter((x) => x.au.maj === a).sort((x, y) => y.cc - x.cc).slice(0, 7))
    console.log(`     CC ${String(f.cc).padStart(2)} cog ${String(f.cog).padStart(3)} ${String(f.codeLines).padStart(3)}L  ${a}=${pc(f.au.c[a], f.au.c.tumwater + f.au.c.claude + f.au.c.other)}  ${f.file}:${f.line} ${f.name}`);
}
const own = { tumwater: 0, claude: 0, mixed: 0 }, fileOwn = [];
for (const f of srcFiles) {
  let tw = 0, cl = 0;
  for (let i = 0; i < f.cls.length; i++) if (f.cls[i] === "c") { const a = authorOf(f.file, i); if (a === "tumwater") tw++; else if (a === "claude") cl++; }
  const s = tw / (tw + cl || 1);
  own[s >= 0.8 ? "tumwater" : s <= 0.2 ? "claude" : "mixed"]++;
  fileOwn.push([f.file, cl / (tw + cl || 1), tw + cl]);
}
console.log(`  src files ≥80% tumwater ${own.tumwater}, ≥80% claude ${own.claude}, mixed ${own.mixed}`);
console.log("  most-Claude src files:", fileOwn.filter((x) => x[2] > 100).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, s, n]) => `${f}(${pc(s * n, n)} of ${n})`).join(" "));

// ---------- coverage ----------
if (COV) {
  hdr("Coverage of src, by author of the line (merged V8, source-mapped)");
  const cv = Object.fromEntries(A.map((a) => [a, { l: 0, lc: 0, b: 0, bc: 0, fn: 0, fc: 0 }]));
  const missL = { tumwater: {}, claude: {} }, missB = { tumwater: {}, claude: {} };
  for (const [file, c] of Object.entries(COV)) {
    const f = fileIdx.get(file);
    if (!f || !inScope(f.cat)) continue;
    for (const [ln, covd] of c.lines) { if (f.cls[ln] !== "c") continue; const a = authorOf(file, ln); if (!cv[a]) continue; cv[a].l++; if (covd) cv[a].lc++; else missL[a][file] = (missL[a][file] || 0) + 1; }
    for (const [ln, covd] of c.branches) { if (ln == null) continue; const a = authorOf(file, ln); if (!cv[a]) continue; cv[a].b++; if (covd) cv[a].bc++; else missB[a][file] = (missB[a][file] || 0) + 1; }
    for (const [ln, covd] of c.funcs) { if (ln == null) continue; const a = authorOf(file, ln); if (!cv[a]) continue; cv[a].fn++; if (covd) cv[a].fc++; }
  }
  row("executable TS code lines covered", A.map((a) => `${pc(cv[a].lc, cv[a].l)} (${cv[a].l - cv[a].lc} miss)`));
  row("branches covered", A.map((a) => `${pc(cv[a].bc, cv[a].b)} (${cv[a].b - cv[a].bc} miss)`));
  row("functions covered", A.map((a) => `${pc(cv[a].fc, cv[a].fn)} (${cv[a].fn - cv[a].fc} miss)`));
  const top = (m) => Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k}(${v})`).join(" ");
  for (const a of A) console.log(`  uncovered ${a} lines: ${top(missL[a])}\n  uncovered ${a} branches: ${top(missB[a])}`);
}

// ---------- duplication ----------
hdr("Duplicated code lines (exact 50-token windows spanning ≥5 lines)");
function dupLines(sel, W, minLines) {
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
for (const [g, pred] of [["src", groups.src], ["test", (f) => groups.test(f) && f.lang === "ts"]]) {
  const d = dupLines(M.files.filter((f) => pred(f) && f.tokens), 50, 5);
  const cnt = { tumwater: 0, claude: 0 };
  for (const [file, s] of d) for (const ln of s) { const a = authorOf(file, ln); if (a in cnt) cnt[a]++; }
  row(`${g} duplicated lines`, A.map((a) => `${pc(cnt[a], L[g][a].c)} (${cnt[a]})`));
}

// ---------- tests ----------
hdr("Tests");
const tfns = M.functions.filter((f) => f.cat === "test:spec" && /^test\(/.test(f.name)).map((fn) => ({ ...fn, au: fnAuthor(fn) }));
const tst = Object.fromEntries(A.map((a) => [a, tfns.filter((f) => f.au.maj === a)]));
row("test() cases (majority author)", A.map((a) => tst[a].length));
row("median test body lines", A.map((a) => q(tst[a].map((f) => f.codeLines), 0.5)));
row("mean test body lines", A.map((a) => f1(sum(tst[a].map((f) => f.codeLines)) / tst[a].length, 1)));
for (const mk of ["as", "nonNull"]) {
  const cnt = { tumwater: 0, claude: 0 };
  for (const f of M.files.filter(groups.test).filter((f) => f.markers)) for (const ln of f.markers[mk]) { const a = authorOf(f.file, ln); if (a in cnt) cnt[a]++; }
  row(`test ${mk} /kLOC`, A.map((a) => f1((1000 * cnt[a]) / L.test[a].c, 1)));
}

// ---------- age ----------
hdr("Age of surviving src code lines");
const now = Math.max(...Object.values(BL).flatMap((b) => b.t));
for (const a of A) {
  const ages = [];
  for (const f of srcFiles) { const b = BL[f.file]; for (let i = 0; i < f.cls.length; i++) if (f.cls[i] === "c" && who(b.cls[i]) === a) ages.push((now - b.t[i]) / 86400); }
  console.log(`  ${a}: median ${f1(q(ages, 0.5))} d, p90 ${f1(q(ages, 0.9))} d, <1d ${pc(ages.filter((x) => x < 1).length, ages.length)}`);
}
const cut = Date.parse("2026-09-18T00:00:00-07:00") / 1000; // Tumwater's switch from local to hosted models
let pre = 0, post = 0;
const models = {};
for (const f of srcFiles) {
  const b = BL[f.file];
  for (let i = 0; i < f.cls.length; i++) {
    if (f.cls[i] !== "c") continue;
    if (b.cls[i] === "tumwater") (b.t[i] < cut ? pre++ : post++);
    else if (b.cls[i].startsWith("claude")) models[b.cls[i]] = (models[b.cls[i]] || 0) + 1;
  }
}
console.log(`  Tumwater src code lines from the local-model era (<2026-09-18) ${pc(pre, pre + post)}, hosted era ${pc(post, pre + post)}`);
console.log("  Claude src code lines by model:", JSON.stringify(models));
