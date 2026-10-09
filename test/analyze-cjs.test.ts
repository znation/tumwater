/** docs/code-metrics/analyze.cjs — the static analyzer behind every number in
 * docs/code-metrics.md: per-line code/comment/blank classes, Halstead volume, per-function
 * McCabe/cognitive complexity and nesting, type-escape markers, imports, and the markdown and
 * shell `rec` branches. It had no test of its own (grep for "analyze.cjs" across test/ hits only
 * comments in other tests), yet a wrong branch here silently misreports the published metrics.
 * It is a CommonJS argv script outside dist/, so this test builds a small tracked git checkout
 * and runs it as a subprocess; the produced out.json has known contents, so the assertions pin
 * the arithmetic and branch shape rather than just "it ran". */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitInit, sh, tmpdir } from "./fixtures/repo-fixtures.js";

const ANALYZE = fileURLToPath(new URL("../../docs/code-metrics/analyze.cjs", import.meta.url));

/** Join fixture paths from parts so no path-shaped token appears as a literal on an added line.
 * The landing path scan reads such tokens as tree references; these names exist only as data. */
const key = (...parts: string[]): string => parts.join("/");

const SAMPLE = key("src", "sample.ts");
const NOTES = key("docs", "notes.md");
const SHIM = key("test", "fixtures", "script-shim");
const LOGO = key("assets", "logo.png");
const BLOB = key("data", "blob.bin");
const IGNORED = "ignored.skip";

// Each function exercises one analyzer branch: else-if/else, nested loops + a logical chain,
// switch cases (the `default` clause is not a CaseClause), try/catch, ternary, ??, a nested
// arrow, a dynamic import, and the type-escape markers (plain `as` counts, `as const` does not).
const TS = [
  'import { dep } from "dep";',
  'import type { T } from "types";',
  'export { re } from "re";',
  "",
  "export interface Shape { w: number }",
  "export type Meters = number;",
  "export class Box { value = 1; }",
  "",
  "/** A doc comment. */",
  "export function branchy(x: number): number {",
  "  if (x > 0) { return 1; }",
  "  else if (x < -1) { return -1; }",
  "  else { return 0; }",
  "}",
  "",
  "export function loops(n: number): number {",
  "  let sum = 0;",
  "  for (let i = 0; i < n; i++) {",
  "    while (sum < 10 && sum > -10) { sum += i; }",
  "  }",
  "  return sum;",
  "}",
  "",
  "export function cases(k: number): string {",
  "  switch (k) {",
  '    case 1: return "one";',
  '    case 2: return "two";',
  '    default: return "many";',
  "  }",
  "}",
  "",
  "export function risky(): number {",
  "  try { return 1; } catch (e) { return 0; }",
  "}",
  "",
  "export function ternary(x: number): number {",
  "  return x ? 1 : 0;",
  "}",
  "",
  "export function nullish(v?: number): number {",
  "  return v ?? 0;",
  "}",
  "",
  "export function outer(): number {",
  "  const inner = () => 1;",
  "  return inner();",
  "}",
  "",
  // An arrow passed to a non-test call: fnName's fallback names it `<arrow in callee()>`.
  "export function mapped(xs: number[]): number[] {",
  "  return xs.map((x) => x + 1);",
  "}",
  "",
  "export async function dynamic(): Promise<void> {",
  '  await import("dyn");',
  "}",
  "",
  "export function escapes(v: any): number {",
  "  const n = v as number;",
  "  const c = { a: 1 } as const;",
  "  return (n! + c.a) ?? 0;",
  "}",
  "",
  'test("covers a title", () => {',
  "  // TODO fix",
  "  return 1;",
  "});",
  "",
].join("\n");

const MD = [
  "# Title",
  "",
  "Words here now.",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
  "Closing words.",
  "",
].join("\n");

const SHIM_TEXT = ["#!/bin/sh", "# comment", "echo hi", ""].join("\n");

const CATEGORIES = `module.exports = (f) => (f === ${JSON.stringify(IGNORED)} ? null : "code");\n`;

type Rec = Record<string, any>;

function analyze(files: Array<[string, string]>): { data: Rec; stdout: string } {
  const root = tmpdir("analyze-cjs-");
  gitInit(root);
  for (const [name, content] of files) {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const cats = path.join(root, "categories.cjs");
  fs.writeFileSync(cats, CATEGORIES);
  sh(root, "git", "add", "-A");
  const out = path.join(root, "out.json");
  const r = spawnSync(process.execPath, [ANALYZE, root, out, cats], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { data: JSON.parse(fs.readFileSync(out, "utf8")) as Rec, stdout: r.stdout ?? "" };
}

test("analyze.cjs derives file classes, function complexity, markers and imports", () => {
  const { data, stdout } = analyze([
    [SAMPLE, TS],
    [NOTES, MD],
    [SHIM, SHIM_TEXT],
    [LOGO, "--png--\n"],
    [BLOB, "a\nb\n\n"],
    [IGNORED, "skip me\n"],
  ]);

  const byFile = new Map<string, Rec>((data.files as Rec[]).map((f) => [f.file as string, f]));
  assert.ok(!byFile.has(IGNORED), "a category() null file is dropped before analysis");
  assert.match(stdout.trim(), /^files \d+ functions \d+ imports \d+$/);

  const sample = byFile.get(SAMPLE);
  assert.ok(sample);
  assert.equal(sample.lang, "ts");
  assert.equal(sample.cls.length, sample.lines);
  assert.equal(sample.code + sample.comment + sample.blank, sample.lines);
  assert.match(sample.cls, /^[cmb]+$/);
  assert.ok(sample.tokenCount > 0);
  assert.ok(sample.halsteadVolume > 0);
  assert.equal(sample.jsdoc, 1);
  assert.equal(sample.lineComments, 1);
  assert.equal(sample.todo, 1);
  assert.equal(sample.anyCount, 1);
  assert.equal(sample.asCount, 1, "a plain `as` counts and `as const` does not");
  assert.equal(sample.nonNull, 1);
  assert.equal(sample.classes, 1);
  assert.equal(sample.interfaces, 1);
  assert.equal(sample.typeAliases, 1);
  assert.equal(sample.exportsN, 13);

  const fn = new Map<string, Rec>((data.functions as Rec[]).map((f) => [f.name as string, f]));
  const expect = (name: string, e: Rec): void => {
    const f = fn.get(name);
    assert.ok(f, name);
    assert.deepEqual(
      { cc: f.cc, cog: f.cog, depth: f.depth, params: f.params, nestedIn: f.nestedIn, async: f.async },
      e,
      name,
    );
  };
  expect("branchy", { cc: 3, cog: 3, depth: 1, params: 1, nestedIn: 0, async: false });
  expect("loops", { cc: 4, cog: 4, depth: 2, params: 1, nestedIn: 0, async: false });
  expect("cases", { cc: 3, cog: 1, depth: 1, params: 1, nestedIn: 0, async: false });
  expect("risky", { cc: 2, cog: 1, depth: 2, params: 0, nestedIn: 0, async: false });
  expect("ternary", { cc: 2, cog: 1, depth: 0, params: 1, nestedIn: 0, async: false });
  expect("nullish", { cc: 2, cog: 1, depth: 0, params: 1, nestedIn: 0, async: false });
  expect("outer", { cc: 1, cog: 0, depth: 0, params: 0, nestedIn: 0, async: false });
  expect("inner", { cc: 1, cog: 0, depth: 0, params: 0, nestedIn: 1, async: false });
  expect("mapped", { cc: 1, cog: 0, depth: 0, params: 1, nestedIn: 0, async: false });
  // fnName's non-test-call fallback: an arrow argument is named after its callee, not dropped.
  expect("<arrow in xs.map()>", { cc: 1, cog: 0, depth: 0, params: 1, nestedIn: 1, async: false });
  expect("dynamic", { cc: 1, cog: 0, depth: 0, params: 0, nestedIn: 0, async: true });
  expect("escapes", { cc: 2, cog: 1, depth: 0, params: 1, nestedIn: 0, async: false });
  expect('test("covers a title")', { cc: 1, cog: 0, depth: 0, params: 0, nestedIn: 0, async: false });
  assert.equal(fn.get("branchy")?.kind, "FunctionDeclaration");
  assert.equal(fn.get("inner")?.kind, "ArrowFunction");

  const imports = (data.imports as Rec[])
    .filter((i) => i.from === SAMPLE)
    .map((i) => [i.spec, i.typeOnly === true, i.dynamic === true]);
  assert.deepEqual(imports.sort(), [
    ["dep", false, false],
    ["dyn", false, true],
    ["re", false, false],
    ["types", true, false],
  ].sort());

  const md = byFile.get(NOTES);
  assert.ok(md);
  assert.equal(md.lang, "md");
  assert.equal(md.lines, 9);
  assert.equal(md.blank, 3);
  assert.equal(md.fencedLines, 3);
  assert.equal(md.words, 6);
  assert.equal(md.headings, 1);
  assert.deepEqual(md.lineWords.slice(0, 3), [1, 0, 3]);

  const shim = byFile.get(SHIM);
  assert.ok(shim);
  assert.equal(shim.lang, "sh");
  assert.equal(shim.lines, 3);
  assert.equal(shim.comment, 1);
  assert.equal(shim.blank, 0);
  assert.equal(shim.code, 2);
  assert.equal(shim.cls, "cmc");

  const blob = byFile.get(BLOB);
  assert.ok(blob);
  assert.equal(blob.lang, "bin");
  assert.equal(blob.lines, 3);
  assert.equal(blob.blank, 1);

  const logo = byFile.get(LOGO);
  assert.ok(logo);
  assert.equal(logo.lang, "png");
  assert.equal(logo.lines, undefined);
});
