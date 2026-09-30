// Line, branch, and function coverage of tumwater's src/, per TypeScript line, from the raw V8
// coverage every process of one suite run leaves behind.
//
// Usage: node coverage.cjs <checkout> <v8-dir> <mapdist-dir> <out.json>
//   <v8-dir>      NODE_V8_COVERAGE=<v8-dir> npm run test:coverage   (suiteEnv passes the variable
//                 through, and node copies its per-process dumps there when the run ends)
//   <mapdist-dir> tsc -p tsconfig.json --sourceMap --outDir <mapdist-dir>   (same compiler options
//                 as dist/ plus source maps: the JS is byte-identical to dist/ bar the trailing
//                 sourceMappingURL comment, so its maps apply to dist/ unchanged)
//
// Merging across processes: every process that loaded a script reports its own block ranges, and V8
// drops a nested range whose count equals its parent's. So a range counts as covered when, in ANY
// process, the innermost range containing it has a count > 0.
//   lines     — v8-to-istanbul / c8 semantics: a JS line takes the count of the innermost range that
//               fully contains its trimmed extent; a TS line is covered if any JS line mapped to it is.
//   branches  — node's --experimental-test-coverage semantics: every range of a block-coverage
//               function (function bodies included) is a branch.
//   functions — every function range except the module's own.
const fs = require("fs");
const path = require("path");
const [CHECKOUT, V8DIR, MAPDIST, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const PREFIX = "file://" + fs.realpathSync(CHECKOUT) + "/dist/src/";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Source-map "mappings" → per generated line, [generatedColumn, originalLine] segments. */
function decodeMappings(str) {
  const lines = [];
  let origLine = 0;
  for (const lineStr of str.split(";")) {
    const segs = [];
    let genCol = 0;
    if (lineStr)
      for (const segStr of lineStr.split(",")) {
        const vals = [];
        let v = 0, shift = 0;
        for (const ch of segStr) {
          let d = B64.indexOf(ch);
          const cont = d & 32;
          d &= 31;
          v += d << shift;
          if (cont) shift += 5;
          else { vals.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0; }
        }
        genCol += vals[0];
        if (vals.length >= 4) { origLine += vals[2]; segs.push([genCol, origLine]); }
      }
    lines.push(segs);
  }
  return lines;
}

// Unique range sets per script across all processes (most processes load a module identically).
const scripts = new Map();
let procs = 0;
for (const f of fs.readdirSync(V8DIR).filter((f) => f.endsWith(".json"))) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(V8DIR, f), "utf8")); } catch { continue; }
  procs++;
  for (const s of j.result) {
    if (!s.url.startsWith(PREFIX)) continue;
    const rel = "src/" + s.url.slice(PREFIX.length);
    let rec = scripts.get(rel);
    if (!rec) scripts.set(rel, (rec = { sigs: new Set(), sets: [] }));
    const ranges = [];
    for (const fn of s.functions)
      fn.ranges.forEach((r, i) => ranges.push([r.startOffset, r.endOffset, r.count, fn.isBlockCoverage ? 1 : 0, i === 0 ? 1 : 0]));
    const sig = JSON.stringify(ranges);
    if (!rec.sigs.has(sig)) { rec.sigs.add(sig); rec.sets.push(ranges); }
  }
}
console.log("processes", procs, "src scripts seen", scripts.size);

/** For one process's ranges (a laminar family), the count of the innermost range fully containing
 * each query [a, b]. Queries must be sorted by a ascending, b descending. */
function makeLookup(ranges) {
  const rs = [...ranges].sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  return (queries) => {
    const out = new Array(queries.length).fill(0);
    const stack = [];
    let i = 0;
    for (const [a, b, idx] of queries) {
      while (i < rs.length && rs[i][0] <= a) {
        while (stack.length && stack[stack.length - 1][1] <= rs[i][0]) stack.pop();
        stack.push(rs[i]);
        i++;
      }
      while (stack.length && stack[stack.length - 1][1] <= a) stack.pop();
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k][1] >= b) { out[idx] = stack[k][2]; break; }
    }
    return out;
  };
}
const byStart = (x, y) => x[0] - y[0] || y[1] - x[1];

const jsFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(path.join(MAPDIST, d), { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) jsFiles.push(p);
  }
})("src");

const result = {};
const tot = { lines: 0, linesCov: 0, br: 0, brCov: 0, fn: 0, fnCov: 0 };
for (const relJs of jsFiles) {
  const js = fs.readFileSync(path.join(CHECKOUT, "dist", relJs), "utf8");
  const segLines = decodeMappings(JSON.parse(fs.readFileSync(path.join(MAPDIST, relJs + ".map"), "utf8")).mappings);
  const starts = [], jsLines = [];
  { let off = 0; for (const l of js.split("\n")) {
    starts.push(off);
    jsLines.push([off + l.length - l.trimStart().length, off + l.trimEnd().length]);
    off += l.length + 1;
  } }
  const lineOfOff = (o) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= o) lo = m; else hi = m - 1; } return lo; };
  const tsLineAt = (jl, col) => { const segs = segLines[jl] || []; if (!segs.length) return null; let best = segs[0]; for (const sg of segs) if (sg[0] <= col) best = sg; return best[1]; };
  const toTs = (o) => { const jl = lineOfOff(o); return tsLineAt(jl, o - starts[jl]) ?? tsLineAt(jl + 1, 0); };

  const rec = scripts.get(relJs);
  const lineCovered = new Uint8Array(jsLines.length);
  const branchKeys = new Map(), funcKeys = new Map();
  let brCov = new Uint8Array(0), fnCov = new Uint8Array(0);
  if (rec) {
    for (const set of rec.sets) for (const r of set) {
      if (r[3]) branchKeys.set(r[0] + ":" + r[1], [r[0], r[1]]);
      if (r[4] && r[0] !== 0) funcKeys.set(r[0] + ":" + r[1], [r[0], r[1]]);
    }
    const lq = jsLines.map(([a, b], i) => [a, b, i]).filter(([a, b]) => b > a).sort(byStart);
    const bq = [...branchKeys.values()].map(([a, b], i) => [a, b, i]).sort(byStart);
    const fq = [...funcKeys.values()].map(([a, b], i) => [a, b, i]).sort(byStart);
    brCov = new Uint8Array(bq.length);
    fnCov = new Uint8Array(fq.length);
    for (const set of rec.sets) {
      const look = makeLookup(set);
      look(lq).forEach((c, i) => { if (c > 0) lineCovered[i] = 1; });
      look(bq).forEach((c, i) => { if (c > 0) brCov[i] = 1; });
      look(fq).forEach((c, i) => { if (c > 0) fnCov[i] = 1; });
    }
  }
  const tsLines = new Map(); // TS line (0-based) → covered 0/1, for every TS line some JS maps to
  segLines.forEach((segs, jl) => {
    if (!segs.length || jl >= jsLines.length || jsLines[jl][1] <= jsLines[jl][0]) return;
    for (const tl of new Set(segs.map((s) => s[1]))) tsLines.set(tl, (tsLines.get(tl) || 0) | lineCovered[jl]);
  });
  const branches = [...branchKeys.values()].map(([a], i) => [toTs(a), brCov[i]]);
  const funcs = [...funcKeys.values()].map(([a], i) => [toTs(a), fnCov[i]]);
  result[relJs.replace(/\.js$/, ".ts")] = { loaded: !!rec, lines: [...tsLines.entries()], branches, funcs };
  tot.lines += tsLines.size; tot.linesCov += [...tsLines.values()].filter(Boolean).length;
  tot.br += branches.length; tot.brCov += branches.filter((b) => b[1]).length;
  tot.fn += funcs.length; tot.fnCov += funcs.filter((b) => b[1]).length;
}
const p = (a, b) => ((100 * a) / b).toFixed(2) + "%";
console.log(`mapped TS lines ${tot.linesCov}/${tot.lines} = ${p(tot.linesCov, tot.lines)}; branches ${tot.brCov}/${tot.br} = ${p(tot.brCov, tot.br)}; functions ${tot.fnCov}/${tot.fn} = ${p(tot.fnCov, tot.fn)}`);
console.log("never-loaded src files:", Object.entries(result).filter(([, v]) => !v.loaded).map(([k]) => k).join(" ") || "none");
fs.writeFileSync(OUT, JSON.stringify(result));
