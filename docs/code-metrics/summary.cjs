// Repo-wide summary of one analyze.cjs output: lines by category, markdown words, function
// complexity distributions, largest functions and files, type-escape markers, the src import
// graph (fan-in/out, cycles), exact-token duplication, and the test-to-code ratio.
//
// Usage: node summary.cjs <metrics.json>
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const M = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), "utf8"));
const sum = (a, k) => a.reduce((s, x) => s + (k ? x[k] || 0 : x), 0);
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); if (!a.length) return NaN; const i = (a.length - 1) * p; const lo = Math.floor(i); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo); };
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const pct = (a, b) => fmt((100 * a) / b) + "%";

console.log("== Lines by category ==");
const cats = {};
for (const f of M.files) (cats[f.cat] ||= []).push(f);
console.log("cat".padEnd(14), "files", "lines".padStart(7), "code".padStart(7), "comment".padStart(8), "blank".padStart(7), " cmt-density", " words");
for (const [c, fs_] of Object.entries(cats).sort()) {
  const L = sum(fs_, "lines"), C = sum(fs_, "code"), Cm = sum(fs_, "comment"), B = sum(fs_, "blank"), W = sum(fs_, "words");
  console.log(c.padEnd(14), String(fs_.length).padStart(5), String(L).padStart(7), String(C).padStart(7), String(Cm).padStart(8), String(B).padStart(7), "  ", C ? pct(Cm, C + Cm) : "     ", W || "");
}
const md = M.files.filter((f) => f.lang === "md");
console.log("markdown files:", md.map((f) => `${f.file}:${f.lines}L/${f.words}w`).join("  "));

const byGroup = (pred) => M.functions.filter(pred);
const groups = {
  "src (all)": (f) => f.cat.startsWith("src"),
  "src core": (f) => f.cat === "src",
  "src/ui": (f) => f.cat === "src/ui",
  "test (all)": (f) => f.cat.startsWith("test"),
  scripts: (f) => f.cat === "scripts",
};
console.log("\n== Functions ==");
for (const [g, pred] of Object.entries(groups)) {
  const fns = byGroup(pred);
  const cc = fns.map((f) => f.cc), cog = fns.map((f) => f.cog), span = fns.map((f) => f.codeLines), prm = fns.map((f) => f.params), dep = fns.map((f) => f.depth), mi = fns.map((f) => f.mi);
  console.log(`${g}: n=${fns.length}  arrows=${pct(fns.filter((f) => f.kind === "ArrowFunction").length, fns.length)} nested=${pct(fns.filter((f) => f.nestedIn > 0).length, fns.length)} async=${pct(fns.filter((f) => f.async).length, fns.length)}`);
  console.log(`  CC   mean ${fmt(sum(cc) / cc.length, 2)} med ${q(cc, 0.5)} p90 ${q(cc, 0.9)} p99 ${fmt(q(cc, 0.99), 0)} max ${Math.max(...cc)} | CC=1 ${pct(cc.filter((x) => x === 1).length, cc.length)} >10 ${pct(cc.filter((x) => x > 10).length, cc.length)} (${cc.filter((x) => x > 10).length}) >20 ${pct(cc.filter((x) => x > 20).length, cc.length)} (${cc.filter((x) => x > 20).length}) >50 ${cc.filter((x) => x > 50).length}`);
  console.log(`  cog  mean ${fmt(sum(cog) / cog.length, 2)} med ${q(cog, 0.5)} p90 ${q(cog, 0.9)} max ${Math.max(...cog)} | >15 ${pct(cog.filter((x) => x > 15).length, cog.length)} (${cog.filter((x) => x > 15).length})`);
  console.log(`  len  mean ${fmt(sum(span) / span.length, 1)} med ${q(span, 0.5)} p90 ${q(span, 0.9)} p99 ${fmt(q(span, 0.99), 0)} max ${Math.max(...span)} | >50 ${pct(span.filter((x) => x > 50).length, span.length)} >100 ${span.filter((x) => x > 100).length}`);
  console.log(`  params mean ${fmt(sum(prm) / prm.length, 2)} >4 ${pct(prm.filter((x) => x > 4).length, prm.length)}  depth mean ${fmt(sum(dep) / dep.length, 2)} max ${Math.max(...dep)} >=5 ${dep.filter((x) => x >= 5).length}`);
  console.log(`  MI(0-100) mean ${fmt(sum(mi) / mi.length)} med ${fmt(q(mi, 0.5))} p10 ${fmt(q(mi, 0.1))} <20 ${mi.filter((x) => x < 20).length} <10 ${mi.filter((x) => x < 10).length}`);
}
// Top-level (non-nested) src functions only, to avoid the "many tiny lambdas" dilution
const top = byGroup((f) => f.cat.startsWith("src") && f.nestedIn === 0);
const tcc = top.map((f) => f.cc);
console.log(`src top-level fns only: n=${top.length} CC mean ${fmt(sum(tcc) / tcc.length, 2)} med ${q(tcc, 0.5)} p90 ${q(tcc, 0.9)} >10 ${pct(tcc.filter((x) => x > 10).length, tcc.length)}`);
// LOC-weighted CC density: decision points per 100 code lines
const srcFiles = M.files.filter((f) => f.cat.startsWith("src"));
const srcCode = sum(srcFiles, "code");
const srcDecisions = sum(byGroup((f) => f.cat.startsWith("src")).map((f) => f.cc - 1));
console.log(`src decision points per 100 code lines: ${fmt((100 * srcDecisions) / srcCode, 1)}`);

console.log("\n== Top 20 src functions by CC ==");
for (const f of byGroup((f) => f.cat.startsWith("src")).sort((a, b) => b.cc - a.cc).slice(0, 20))
  console.log(`  CC ${String(f.cc).padStart(3)} cog ${String(f.cog).padStart(3)} ${String(f.codeLines).padStart(4)}L d${f.depth} MI ${fmt(f.mi, 0).padStart(3)}  ${f.file}:${f.line} ${f.name}`);
console.log("== Top 8 src functions by length ==");
for (const f of byGroup((f) => f.cat.startsWith("src")).sort((a, b) => b.codeLines - a.codeLines).slice(0, 8))
  console.log(`  ${String(f.codeLines).padStart(4)}L CC ${f.cc}  ${f.file}:${f.line} ${f.name}`);

console.log("\n== File sizes (code lines) ==");
for (const [g, pred] of [["src", (f) => f.cat.startsWith("src")], ["test", (f) => f.cat.startsWith("test") && f.lang === "ts"]]) {
  const fs_ = M.files.filter(pred), c = fs_.map((f) => f.code);
  console.log(`${g}: n=${fs_.length} mean ${fmt(sum(c) / c.length, 0)} med ${q(c, 0.5)} p90 ${fmt(q(c, 0.9), 0)} max ${Math.max(...c)} >500 ${c.filter((x) => x > 500).length} >1000 ${c.filter((x) => x > 1000).length}  fns/file ${fmt(M.functions.filter((x) => pred({ cat: x.cat, lang: "ts" })).length / fs_.length, 1)}`);
  console.log("  largest:", fs_.sort((a, b) => b.code - a.code).slice(0, 8).map((f) => `${f.file}(${f.code})`).join(" "));
}

console.log("\n== Type hygiene / markers (src | test) ==");
for (const k of ["anyCount", "asCount", "nonNull", "tsIgnore", "eslintDisable", "todo", "classes", "interfaces", "typeAliases", "exportsN", "jsdoc", "lineComments"]) {
  const s = sum(srcFiles, k), t = sum(M.files.filter((f) => f.cat.startsWith("test")), k);
  console.log(`  ${k.padEnd(14)} ${String(s).padStart(6)} (${fmt((1000 * s) / srcCode, 2)}/kLOC) | ${t}`);
}

// ---- import graph (src only, internal) ----
console.log("\n== Import graph (src internal) ==");
const resolve = (from, spec) => {
  if (!spec.startsWith(".")) return null;
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.js$/, ".ts");
  return p;
};
const srcSet = new Set(srcFiles.map((f) => f.file));
const edges = new Map(), rtEdges = new Map();
for (const f of srcSet) { edges.set(f, new Set()); rtEdges.set(f, new Set()); }
const external = new Map();
for (const im of M.imports) {
  if (!srcSet.has(im.from)) continue;
  const t = resolve(im.from, im.spec);
  if (t === null) { external.set(im.spec, (external.get(im.spec) || 0) + 1); continue; }
  if (!srcSet.has(t)) continue;
  edges.get(im.from).add(t);
  if (!im.typeOnly) rtEdges.get(im.from).add(t);
}
console.log("external specifiers:", [...external.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "));
const fanOut = [...edges.values()].map((s) => s.size);
const fanIn = new Map([...srcSet].map((f) => [f, 0]));
for (const s of edges.values()) for (const t of s) fanIn.set(t, fanIn.get(t) + 1);
console.log(`modules ${srcSet.size} edges ${sum(fanOut)} fan-out mean ${fmt(sum(fanOut) / fanOut.length, 1)} max ${Math.max(...fanOut)}; fan-in max ${Math.max(...fanIn.values())}`);
console.log("  highest fan-in:", [...fanIn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(" "));
console.log("  highest fan-out:", [...edges.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 6).map(([k, v]) => `${k}(${v.size})`).join(" "));
function sccs(g) {
  let idx = 0; const st = [], on = new Set(), ix = new Map(), low = new Map(), out = [];
  function sc(v) {
    ix.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of g.get(v)) { if (!ix.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w))); }
    if (low.get(v) === ix.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) out.push(c); }
  }
  for (const v of g.keys()) if (!ix.has(v)) sc(v);
  return out;
}
const cyc = sccs(edges), rtCyc = sccs(rtEdges);
console.log(`  cycles (SCC>1) all-imports: ${cyc.length} [sizes ${cyc.map((c) => c.length).join(",")}]  runtime-only: ${rtCyc.length} [sizes ${rtCyc.map((c) => c.length).join(",")}]`);
if (rtCyc.length) console.log("   runtime cycles:", rtCyc.map((c) => c.join(" <-> ")).join(" | "));
// ---- duplication ----
console.log("\n== Duplication (exact token windows, jscpd-like) ==");
function dup(filesSel, W, minLines) {
  const map = new Map();
  for (const f of filesSel) {
    const toks = f.tokens;
    for (let i = 0; i + W <= toks.length; i++) {
      const h = crypto.createHash("md5").update(toks.slice(i, i + W).map((t) => t[1]).join("\u0001")).digest("base64");
      let arr = map.get(h); if (!arr) map.set(h, (arr = [])); arr.push([f, i]);
    }
  }
  const dupLines = new Map();
  for (const arr of map.values()) {
    if (arr.length < 2) continue;
    for (const [f, i] of arr) {
      const first = f.tokens[i][2], last = f.tokens[i + W - 1][2];
      if (last - first + 1 < minLines) continue;
      let s = dupLines.get(f.file); if (!s) dupLines.set(f.file, (s = new Set()));
      for (let k = i; k < i + W; k++) s.add(f.tokens[k][2]);
    }
  }
  const total = sum(filesSel, "code");
  const d = sum([...dupLines.values()].map((s) => s.size));
  return { total, d, top: [...dupLines.entries()].map(([k, s]) => [k, s.size]).sort((a, b) => b[1] - a[1]).slice(0, 6) };
}
for (const [g, pred] of [["src", (f) => f.cat.startsWith("src")], ["test", (f) => f.cat.startsWith("test") && f.lang === "ts"]]) {
  const sel = M.files.filter((f) => pred(f) && f.tokens);
  for (const [W, ml] of [[50, 5], [100, 10]]) {
    const r = dup(sel, W, ml);
    console.log(`${g} W=${W} minLines=${ml}: ${r.d}/${r.total} code lines = ${pct(r.d, r.total)}   top: ${r.top.map(([k, v]) => `${k}(${v})`).join(" ")}`);
  }
}
// ---- tests ----
console.log("\n== Tests ==");
const testFns = M.functions.filter((f) => f.cat === "test:spec" && /^test\(/.test(f.name));
console.log(`test() cases (as arrow callbacks): ${testFns.length}; median test-body lines ${q(testFns.map((f) => f.codeLines), 0.5)} mean ${fmt(sum(testFns, "codeLines") / testFns.length, 1)}`);
const testCode = sum(M.files.filter((f) => f.cat.startsWith("test")), "code");
console.log(`test:src code ratio ${fmt(testCode / srcCode, 2)} (test ${testCode} / src ${srcCode}); spec-only ${fmt(sum(cats["test:spec"] ?? [], "code") / srcCode, 2)}`);
