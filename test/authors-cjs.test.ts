/** docs/code-metrics/authors.cjs — the attribution report that splits lines, functions and
 * duplication between Tumwater's own role loops and human-directed Claude sessions using
 * blame.json. It had no test (grep for its name across test/ found nothing), yet every
 * tumwater-vs-Claude figure in the metrics docs is this script's arithmetic: authorOf, the who()
 * mapping, the p90/median quantile, the majority-authorship and "pure function" split, and the
 * 50-token duplication pass.
 *
 * It is a CommonJS argv script outside dist/ (reads metrics.json + blame.json from a data dir and
 * logs to stdout), so the tests write synthetic inputs to a temp dir and run it as a subprocess —
 * the .cjs specifier never enters tsc. The fixture uses tiny files with known code/comment/blank
 * runs and known blame classes so the assertions pin the arithmetic, not just "it ran". */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";

const AUTHORS = fileURLToPath(new URL("../../docs/code-metrics/authors.cjs", import.meta.url));

type Tok = [number, string, number];

/** 50 tokens, ten per line, so the single 50-token window spans lines 0–4 (five lines, the exact
 * minLines cutoff). Two files sharing a tag share every token; a third tag is unique. */
const toks = (tag: string): Tok[] =>
  Array.from({ length: 50 }, (_, i) => [0, `${tag}${i}`, Math.floor(i / 10)] as Tok);

/** Join fixture paths from parts so no path-shaped token appears as a literal on an added line.
 * These names exist only as data keys in the synthetic metrics/blame JSON, never on disk. */
const key = (...parts: string[]): string => parts.join("/");

type Blame = { cls: string[]; t: number[] };

function run(data: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [AUTHORS, data], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** One ts/js record with a cls run and a matching blame entry. The caller overrides markers/tokens
 * where the section under test needs them. */
function seed(): string {
  const data = tmpdir("authors-");
  const blame: Record<string, Blame> = {};
  const file = (file: string, cat: string, lang: string, cls: string, authors: string[], extra: Record<string, unknown> = {}) => {
    blame[file] = { cls: authors, t: authors.map((_, i) => 1000 + i * 10) };
    const code = [...cls].filter((c) => c === "c").length;
    const comment = [...cls].filter((c) => c === "m").length;
    const markers = { any: [] as number[], as: [] as number[], nonNull: [] as number[], todo: [] as number[], decision: [] as number[] };
    return { file, cat, lang, lines: cls.length, code, comment, blank: cls.length - code - comment, words: 0, cls, markers, tokens: [] as Tok[], ...extra };
  };
  const mdfile = (file: string, cat: string, words: number, lineWords: number[], authors: string[]) => {
    blame[file] = { cls: authors, t: authors.map((_, i) => 1000 + i * 10) };
    return { file, cat, lang: "md", lines: lineWords.length, code: 0, comment: 0, blank: 0, words, cls: "", markers: {}, tokens: [] as Tok[], lineWords };
  };

  const A = key("src", "a.ts"), B = key("src", "b.ts"), CU = key("src", "ui", "c.ts"), X = key("test", "x.test.ts"), E = key("scripts", "e.mjs");
  const metrics = {
    files: [
      // a: five tumwater code lines; b: five claude code lines, same tokens as a.
      file(A, "src", "ts", "ccccc", ["tumwater", "tumwater", "tumwater", "tumwater", "tumwater"], {
        tokens: toks("s"), markers: { any: [3], as: [1], nonNull: [2], todo: [], decision: [0] },
      }),
      file(B, "src", "ts", "ccccc", ["claude-sonnet", "claude-sonnet", "claude-sonnet", "claude-sonnet", "claude-sonnet"], {
        tokens: toks("s"), markers: { any: [], as: [], nonNull: [], todo: [4], decision: [0] },
      }),
      // c: three tumwater code lines and one claude comment line, unique tokens.
      file(CU, "src/ui", "ts", "cccm", ["tumwater", "tumwater", "tumwater", "claude-sonnet"], { tokens: toks("u") }),
      file(X, "test:spec", "ts", "cc", ["tumwater", "claude-sonnet"], { markers: { any: [], as: [0], nonNull: [1], todo: [], decision: [] } }),
      // e: a code line by a third author ("human" via who()) plus one tumwater line.
      file(E, "scripts", "js", "cc", ["human", "tumwater"]),
      mdfile("README.md", "docs:prose", 7, [3, 4], ["tumwater", "claude-sonnet"]),
      mdfile("PLANS.md", "docs:backlog", 5, [5], ["claude-sonnet"]),
    ],
    functions: [
      { file: A, line: 1, span: 5, name: "alpha", cat: "src", cc: 5, cog: 3, codeLines: 5, params: 2, depth: 1, mi: 80, kind: "FunctionDeclaration", nestedIn: 0 },
      { file: B, line: 1, span: 5, name: "beta", cat: "src", cc: 15, cog: 8, codeLines: 5, params: 5, depth: 3, mi: 40, kind: "FunctionDeclaration", nestedIn: 0 },
      { file: CU, line: 1, span: 3, name: "gamma", cat: "src/ui", cc: 3, cog: 2, codeLines: 3, params: 1, depth: 0, mi: 90, kind: "FunctionDeclaration", nestedIn: 0 },
      { file: X, line: 1, span: 2, name: 'test("works")', cat: "test:spec", cc: 2, cog: 1, codeLines: 2, params: 0, depth: 0, mi: 90, kind: "ArrowFunction", nestedIn: 0 },
    ],
    imports: [],
  };
  fs.writeFileSync(path.join(data, "metrics.json"), JSON.stringify(metrics));
  fs.writeFileSync(path.join(data, "blame.json"), JSON.stringify({ commits: {}, files: blame }));
  return data;
}

test("authors.cjs splits lines, functions and duplication between the two authors", () => {
  const r = run(seed());
  assert.equal(r.status, 0, r.stderr);
  const o = r.stdout;

  // Line groups: src has 8 tumwater code lines (a's 5 + c's 3) and 5 claude (b), the one comment
  // is claude's; test 2 code lines split evenly; scripts credits the human line as "other".
  assert.match(o, /^SRC_SCOPE=all$/m);
  assert.match(o, /^\s+src code lines\s+8 \(61\.5%\)\s+5 \(38\.5%\)$/m);
  assert.match(o, /^\s+src comment lines\s+0\s+1$/m);
  assert.match(o, /^\s+src comment density\s+0\.0%\s+16\.7%$/m);
  assert.match(o, /^\s+test code lines\s+1 \(50\.0%\)\s+1 \(50\.0%\)$/m);
  assert.match(o, /^\s+scripts code lines\s+1 \(50\.0%\)\s+0 \(0\.0%\)$/m);
  assert.match(o, /^\s+scripts comment density\s+0\.0%\s+-$/m);
  assert.match(o, /other authors: \{"src":\{\},"test":\{\},"scripts":\{"human":\{"c":1,"m":0,"b":0\}\}\}/);

  // Markdown words follow the line's author, and the per-file Claude share is word-weighted.
  assert.match(o, /^\s+markdown words: prose\s+3 \(42\.9%\)\s+4 \(57\.1%\)$/m);
  assert.match(o, /^\s+markdown words: backlog\s+0 \(0\.0%\)\s+5 \(100\.0%\)$/m);
  assert.match(o, /Claude's share of each markdown file's words: README\.md:57\.1% PLANS\.md:100\.0%/);

  // Per-1000-code-line density: a's markers are all tumwater except `any`; b contributes one
  // claude decision and one claude todo.
  assert.match(o, /^\s+decision points \(McCabe\) \/kLOC\s+125\.0 \(1\)\s+200\.0 \(1\)$/m);
  assert.match(o, /^\s+todo \/kLOC\s+0\.0 \(0\)\s+200\.0 \(1\)$/m);

  // Function stats by majority author: tumwater's alpha+gamma (cc 5,3), claude's beta (cc 15).
  assert.match(o, /^\s+n\s+2\s+1$/m);
  assert.match(o, /^\s+ccMean\s+4\.00\s+15\.00$/m);
  assert.match(o, /^\s+ccMed\s+4\s+15$/m);
  assert.match(o, /^\s+cc10\s+0\.0%\s+100\.0%$/m);
  assert.match(o, /^\s+lenMean\s+4\.0\s+5\.0$/m);
  assert.match(o, /^\s+mi\s+85\.0\s+40\.0$/m);
  assert.match(o, /mixed-authorship functions \(<90% one author\): 0\/3; of the CC>20 functions: 0\/0 are mixed/);
  assert.match(o, /^\s+CC  5 cog   3   5L  tumwater=100\.0%  src\/a\.ts:1 alpha$/m);
  assert.match(o, /^\s+CC 15 cog   8   5L  claude=100\.0%  src\/b\.ts:1 beta$/m);
  // File ownership counts code lines only: a and c are 100% tumwater, b is 100% claude.
  assert.match(o, /src files ≥80% tumwater 2, ≥80% claude 1, mixed 0/);

  // Duplication: a and b share every token window (5 lines each); c's tokens are unique.
  assert.match(o, /^\s+src duplicated lines\s+62\.5% \(5\)\s+100\.0% \(5\)$/m);
  assert.match(o, /^\s+test duplicated lines\s+0\.0% \(0\)\s+0\.0% \(0\)$/m);

  // Tests section: one test() callback, majority tumwater; markers land on the marker's own line.
  assert.match(o, /test\(\) cases \(majority author\)\s+1\s+0/);
  assert.match(o, /^\s+test as \/kLOC\s+1000\.0\s+0\.0$/m);
  assert.match(o, /^\s+test nonNull \/kLOC\s+0\.0\s+1000\.0$/m);
});

test("authors.cjs narrows the code scope with SRC_SCOPE", () => {
  const data = seed();

  const core = run(data, { SRC_SCOPE: "core" });
  assert.equal(core.status, 0, core.stderr);
  assert.match(core.stdout, /^SRC_SCOPE=core$/m);
  // core drops src/ui: a's 5 tumwater vs b's 5 claude code lines, no comments.
  assert.match(core.stdout, /^\s+src code lines\s+5 \(50\.0%\)\s+5 \(50\.0%\)$/m);
  assert.match(core.stdout, /^\s+src comment density\s+0\.0%\s+0\.0%$/m);
  assert.match(core.stdout, /src files ≥80% tumwater 1, ≥80% claude 1, mixed 0/);

  const ui = run(data, { SRC_SCOPE: "ui" });
  assert.equal(ui.status, 0, ui.stderr);
  assert.match(ui.stdout, /^SRC_SCOPE=ui$/m);
  // ui keeps only c: 3 tumwater code lines and one claude comment.
  assert.match(ui.stdout, /^\s+src code lines\s+3 \(100\.0%\)\s+0 \(0\.0%\)$/m);
  assert.match(ui.stdout, /^\s+src comment density\s+0\.0%\s+100\.0%$/m);
  // c's one comment line is claude but file ownership counts code lines only, so it is tumwater.
  assert.match(ui.stdout, /src files ≥80% tumwater 1, ≥80% claude 0, mixed 0/);
});
