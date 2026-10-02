import fs from "node:fs";
import { readJson } from "./json-read.js";
import path from "node:path";

/** Deterministic per-file coverage of dist/src, computed from the raw V8 coverage dumps a
 * suite run leaves behind in its NODE_V8_COVERAGE directory.
 *
 * Why this exists (BUGS.md 2026-09-30): node --experimental-test-coverage's own table merges
 * the per-process coverage reports and its result flips between runs on the same tree — for
 * src/orchestrator.ts between 87% and 99% lines — because V8 omits a nested block range whose
 * count equals its parent's, so the set of ranges a process reports varies, and node's
 * per-function merge depends on which reports it combines. This module instead counts a range
 * as covered when ANY process's innermost containing range ran it: the merge
 * docs/code-metrics/coverage.cjs uses, which produced a byte-identical result across all 11
 * runs of the 2026-09-30 investigation. The two differ on granularity, on purpose: this table
 * reports per compiled JS file with no source-map step (mapping onto TypeScript lines needs a
 * second tsc pass, which the coverage pipeline's coverage.cjs does out in docs/code-metrics),
 * so the numbers here are executable-JS-line numbers, not node's table's.
 *
 * Semantics, matching coverage.cjs:
 *   lines     — a JS line whose trimmed extent is non-empty is covered when some process's
 *               innermost range fully containing it has a count > 0.
 *   branches  — node's --experimental-test-coverage semantics: every range of a block-coverage
 *               function (function bodies included) is a branch; covered when any process ran it.
 *   functions — every function's root range except the module's own; covered when any process ran it.
 */

interface CoverageCounts {
  covered: number;
  total: number;
}

interface CoverageRow {
  /** Path of the compiled file relative to the dist root, e.g. `src/orchestrator.js`. */
  file: string;
  lines: CoverageCounts;
  branches: CoverageCounts;
  functions: CoverageCounts;
}

/** One V8 block range: [startOffset, endOffset, count, isBlockCoverage?1:0, isFnRoot?1:0]. */
type Range = [number, number, number, number, number];
/** A query [a, b] paired with the index to answer it for. */
type Query = [number, number, number];
const byStart = (x: Query, y: Query): number => x[0] - y[0] || y[1] - x[1];

/** For one process's ranges (a laminar family), the count of the innermost range fully
 * containing each query [a, b], returned indexed by each query's recorded index (its third
 * element) — NOT by position in `queries`. Callers that filter or reorder queries must key
 * their result arrays on that recorded index (the line caller below indexes `lineCovered` by
 * line index this way). Queries must be sorted by a ascending, b descending. (Ported from
 * docs/code-metrics/coverage.cjs, whose callers read the result array the same way.) */
function makeLookup(ranges: Range[]): (queries: readonly Query[]) => number[] {
  const rs = [...ranges].sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  return (queries) => {
    const out = new Array<number>(queries.length).fill(0);
    const stack: Range[] = [];
    let i = 0;
    for (const [a, b, idx] of queries) {
      while (i < rs.length) {
        const next = rs[i];
        if (next === undefined || next[0] > a) break;
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (top === undefined || top[1] > next[0]) break;
          stack.pop();
        }
        stack.push(next);
        i++;
      }
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top === undefined || top[1] > a) break;
        stack.pop();
      }
      for (let k = stack.length - 1; k >= 0; k--) {
        const r = stack[k];
        if (r !== undefined && r[1] >= b) {
          out[idx] = r[2];
          break;
        }
      }
    }
    return out;
  };
}

/** Read every raw V8 coverage dump in `dumpDir` and collect, per dist/src script, the distinct
 * range sets any process reported (most processes load a module identically, so deduplication
 * keeps the merge cheap). Scripts outside `distRoot/src` are ignored. */
function readRangeSets(dumpDir: string, distRoot: string): Map<string, { sigs: Set<string>; sets: Range[][] }> {
  const srcRoot = path.join(distRoot, "src");
  const prefix = "file://" + fs.realpathSync(srcRoot) + "/";
  const scripts = new Map<string, { sigs: Set<string>; sets: Range[][] }>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dumpDir).filter((f) => f.endsWith(".json"));
  } catch {
    return scripts; // No dump directory — the caller reports its absence.
  }
  for (const f of names) {
    let j: { result?: { url?: unknown; functions?: { isBlockCoverage?: boolean; ranges?: { startOffset: number; endOffset: number; count: number }[] }[] }[] };
    try {
      j = readJson(path.join(dumpDir, f));
    } catch {
      continue; // A torn dump (a killed process) is one process's view short, not a failure.
    }
    for (const s of j.result ?? []) {
      if (typeof s.url !== "string" || !s.url.startsWith(prefix)) continue;
      const rel = "src/" + s.url.slice(prefix.length);
      let rec = scripts.get(rel);
      if (!rec) scripts.set(rel, (rec = { sigs: new Set(), sets: [] }));
      const ranges: Range[] = [];
      for (const fn of s.functions ?? [])
        (fn.ranges ?? []).forEach((r, i) =>
          ranges.push([r.startOffset, r.endOffset, r.count, fn.isBlockCoverage ? 1 : 0, i === 0 ? 1 : 0]));
      const sig = JSON.stringify(ranges);
      if (!rec.sigs.has(sig)) {
        rec.sigs.add(sig);
        rec.sets.push(ranges);
      }
    }
  }
  return scripts;
}

/** Every compiled JS file under `distRoot/src`, as paths relative to the dist root. */
function walkSrc(distRoot: string): string[] {
  const out: string[] = [];
  (function walk(dir: string, rel: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.endsWith(".js")) out.push(`src/${r}`);
    }
  })(path.join(distRoot, "src"), "");
  return out.sort();
}

/** Build the deterministic per-file coverage table: one row per dist/src JS file (a module no
 * process loaded reports zero coverage — an untested module must not vanish from the table),
 * each line/branch/function counted covered when any process's dump ran it. */
export function coverageRowsFromDumps(dumpDir: string, distRoot: string): CoverageRow[] {
  const scripts = readRangeSets(dumpDir, distRoot);
  const rows: CoverageRow[] = [];
  for (const relJs of walkSrc(distRoot)) {
    const js = fs.readFileSync(path.join(distRoot, relJs), "utf8");
    const lineExtents: [number, number][] = [];
    {
      let off = 0;
      for (const l of js.split("\n")) {
        lineExtents.push([off + l.length - l.trimStart().length, off + l.trimEnd().length]);
        off += l.length + 1;
      }
    }
    const lineCovered = new Uint8Array(lineExtents.length);
    const branches: CoverageCounts = { covered: 0, total: 0 };
    const functions: CoverageCounts = { covered: 0, total: 0 };
    const rec = scripts.get(relJs);
    if (rec) {
      const branchKeys = new Map<string, [number, number]>();
      const funcKeys = new Map<string, [number, number]>();
      for (const set of rec.sets)
        for (const r of set) {
          if (r[3]) branchKeys.set(`${r[0]}:${r[1]}`, [r[0], r[1]]);
          if (r[4] && r[0] !== 0) funcKeys.set(`${r[0]}:${r[1]}`, [r[0], r[1]]);
        }
      const lq: Query[] = lineExtents
        .map(([a, b], i) => [a, b, i] as Query)
        .filter(([a, b]) => b > a)
        .sort(byStart);
      const bq: Query[] = [...branchKeys.values()].map(([a, b], i) => [a, b, i] as Query).sort(byStart);
      const fq: Query[] = [...funcKeys.values()].map(([a, b], i) => [a, b, i] as Query).sort(byStart);
      branches.total = bq.length;
      functions.total = fq.length;
      const brCov = new Uint8Array(bq.length);
      const fnCov = new Uint8Array(fq.length);
      for (const set of rec.sets) {
        // node:test's V8 dumps record some functions their own tests demonstrably ran as
        // phantom fn roots — isBlockCoverage: false, count: 0 — while sibling roots in the
        // same dump carry real counts (BUGS.md 2026-10-01). When the module ran in this
        // process (some fn root has count > 0), such a zero is a reporting artifact, not
        // evidence of an unexecuted function: drop the phantom root so its queries resolve
        // against the enclosing range's real count instead of shadowing it with 0.
        const ran = set.some((r) => r[4] === 1 && r[2] > 0);
        const look = makeLookup(ran ? set.filter((r) => !(r[4] === 1 && r[3] === 0 && r[2] === 0)) : set);
        // makeLookup indexes its result by each query's recorded line index, so the forEach
        // index is the line index itself — NOT a position into the filtered, sorted lq. The
        // positional reading scrambled every line after a blank line (BUGS.md 2026-09-30).
        look(lq).forEach((c, i) => {
          if (c > 0) lineCovered[i] = 1;
        });
        look(bq).forEach((c, k) => {
          if (c > 0) brCov[k] = 1;
        });
        look(fq).forEach((c, k) => {
          if (c > 0) fnCov[k] = 1;
        });
      }
      branches.covered = [...brCov].filter(Boolean).length;
      functions.covered = [...fnCov].filter(Boolean).length;
    }
    rows.push({
      file: relJs,
      lines: { covered: [...lineCovered].filter(Boolean).length, total: lqTotal(lineExtents) },
      branches,
      functions,
    });
  }
  return rows;
}

/** Executable JS lines: trimmed extents that are non-empty. */
function lqTotal(lineExtents: readonly [number, number][]): number {
  return lineExtents.filter(([a, b]) => b > a).length;
}

const pct = (c: number, t: number): string => (t === 0 ? "n/a" : ((100 * c) / t).toFixed(2) + "%");

/** Render the table: most uncovered lines first (so "the file with the most uncovered lines"
 * is the first file row), an `all files` row last. */
export function formatCoverageTable(rows: readonly CoverageRow[]): string {
  const sorted = [...rows].sort(
    (x, y) => y.lines.total - y.lines.covered - (x.lines.total - x.lines.covered) || x.file.localeCompare(y.file),
  );
  const tot = sorted.reduce(
    (a, r) => ({
      lines: { covered: a.lines.covered + r.lines.covered, total: a.lines.total + r.lines.total },
      branches: { covered: a.branches.covered + r.branches.covered, total: a.branches.total + r.branches.total },
      functions: { covered: a.functions.covered + r.functions.covered, total: a.functions.total + r.functions.total },
    }),
    {
      lines: { covered: 0, total: 0 },
      branches: { covered: 0, total: 0 },
      functions: { covered: 0, total: 0 },
    },
  );
  const wide = Math.max(1, ...sorted.map((r) => r.lines.total - r.lines.covered), tot.lines.total - tot.lines.covered);
  const pad = (n: number): string => String(n).padStart(String(wide).length);
  const cells = (r: { lines: CoverageCounts; branches: CoverageCounts; functions: CoverageCounts }): string =>
    `lines ${r.lines.covered}/${r.lines.total} ${pct(r.lines.covered, r.lines.total)}` +
    `  branches ${r.branches.covered}/${r.branches.total} ${pct(r.branches.covered, r.branches.total)}` +
    `  functions ${r.functions.covered}/${r.functions.total} ${pct(r.functions.covered, r.functions.total)}`;
  const lines = [
    "deterministic coverage (any-process merge of the raw V8 dumps; node's table above can flip" +
      " between runs on the same tree) — most uncovered lines first:",
    ...sorted.map((r) => `  ${pad(r.lines.total - r.lines.covered)}  ${r.file}  ${cells(r)}`),
    `  ${pad(tot.lines.total - tot.lines.covered)}  all files  ${cells(tot)}`,
  ];
  return lines.join("\n") + "\n";
}

/** Compute and print the deterministic table for the dumps in `dumpDir`. A failure here must
 * never flip a green suite red, so it is reported on stderr and the caller's status stands. */
export function printCoverageTable(dumpDir: string, distRoot: string, out: NodeJS.WriteStream = process.stdout): void {
  const dumpNames = fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir).filter((f) => f.endsWith(".json")) : [];
  if (dumpNames.length === 0) {
    process.stderr.write(`tumwater: no raw V8 coverage dumps were written to ${dumpDir}; the deterministic table needs them\n`);
    return;
  }
  let rows: CoverageRow[];
  try {
    rows = coverageRowsFromDumps(dumpDir, distRoot);
  } catch (e) {
    process.stderr.write(`tumwater: the deterministic coverage table failed: ${(e as Error).message}\n`);
    return;
  }
  out.write(formatCoverageTable(rows));
}
