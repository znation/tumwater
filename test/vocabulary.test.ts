/** Guards plans/terminology.md's plain-terms vocabulary: user-visible text in an opted-in `src/`
 * module never uses a retired word. A module opts in with a `// vocabulary: plain` line; with no
 * module opted in the scan passes. The guard reads string literals, template text, JSX text and
 * the string literals inside the `String.raw` browser blobs; identifiers, comments and `${…}`
 * expressions are code and never scanned. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The retired words, as regex sources; later series append here. This is the only list.
 * The role ids `dry` and `telemetry` stay out until Plain terms role ids switches them: the
 * dedupe part appends `dry(?![- ]run)` (so `--dry-run` and "dry run" stay legal) and the
 * selfcheck part appends `telemetry`. */
const RETIRED_WORDS: readonly string[] = [
  "fleet",
  "loop",
  "tick",
  "landing",
  "landed",
  "land queue",
  "vetted",
  "seam",
  "notebook",
  "initial prompt",
  "harness",
  "operator",
  "backoff",
  "backed off",
  "drain",
];

/** Letters, digits and `_` are word characters, so snake_case machine names (`tick_end`) and
 * camelCase identifiers (`lastTickEndedAt`) never match, while prose and inflections do. */
const RETIRED_RE = new RegExp(
  `(?<![a-z0-9_])(?:${RETIRED_WORDS.join("|")})(?:s|es|ed|ing)?(?![a-z0-9_])`,
  "gi",
);

/** Whether a module is scanned: one of its lines, trimmed, is exactly `// vocabulary: plain`.
 * Plain terms code cleanup flips the guard to all of `src/` by making this return true. */
function optedIn(text: string): boolean {
  return text.split("\n").some((line) => line.trim() === "// vocabulary: plain");
}

/** A finding's line is exempt when it ends with `// vocabulary-ok: <reason>` (non-empty reason).
 * A word inside multi-line template text cannot carry the comment, since the comment would be
 * part of the text: move such a machine name into a constant on its own exempted line and
 * interpolate it. */
const EXEMPT_RE = /\/\/ vocabulary-ok: +\S.*$/;

/** Blank every `${…}` substitution of a template with a `0` plus spaces of the same length
 * (newlines kept), so the remaining source parses as JavaScript with unchanged offsets. `base`
 * is the file offset where `text` starts. */
function blankSubstitutions(text: string, tpl: ts.TemplateLiteral, base: number): string {
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) return text;
  const chars = text.split("");
  const blank = (a: number, b: number): void => {
    const from = a - base;
    const to = b - base;
    chars[from] = "0";
    for (let i = from + 1; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  let from = tpl.head.end - 2;
  for (const span of tpl.templateSpans) {
    blank(from, span.literal.getStart() + 1);
    from = span.literal.end - 2;
  }
  return chars.join("");
}

function isModuleSpecifierLiteral(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    const callee = p.expression;
    return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
  }
  return false;
}

/** Scan one parsed source; `emit(pos, lineBase)` receives each literal's raw text and the offset
 * of that text within `sf`, `lineBase` mapping `sf` line 0 to a real file line. */
function scanLiterals(
  sf: ts.SourceFile,
  emit: (raw: string, pos: number, sf: ts.SourceFile) => void,
  onBlob?: (decl: ts.VariableDeclaration, tpl: ts.TemplateLiteral) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (
      onBlob &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith("_JS") &&
      node.initializer &&
      ts.isTaggedTemplateExpression(node.initializer) &&
      node.initializer.tag.getText(sf) === "String.raw"
    ) {
      onBlob(node, node.initializer.template);
      return;
    }
    if (ts.isLiteralTypeNode(node)) return;
    const k = node.kind;
    const textual =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      k === ts.SyntaxKind.TemplateHead ||
      k === ts.SyntaxKind.TemplateMiddle ||
      k === ts.SyntaxKind.TemplateTail ||
      k === ts.SyntaxKind.JsxText;
    if (textual) {
      const skip =
        isModuleSpecifierLiteral(node) ||
        (node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node);
      if (!skip) emit(node.getText(sf), node.getStart(sf), sf);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** `"<file>:<line>: <word> in <excerpt>"` for each retired word in the user-visible text of an
 * opted-in module; empty for a module without the header. Shared by the real scan and the
 * self-tests. */
function vocabularyFindings(fileName: string, text: string): string[] {
  if (!optedIn(text)) return [];
  const lines = text.split("\n");
  const out: string[] = [];
  const report = (raw: string, pos: number, sf: ts.SourceFile, lineBase: number): void => {
    for (const m of raw.matchAll(RETIRED_RE)) {
      const at = pos + (m.index ?? 0);
      const line = lineBase + sf.getLineAndCharacterOfPosition(at).line + 1;
      const src = lines[line - 1] ?? "";
      if (EXEMPT_RE.test(src)) continue;
      out.push(`${fileName}:${line}: ${m[0]} in ${src.trim().slice(0, 80)}`);
    }
  };
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  scanLiterals(
    sf,
    (raw, pos) => report(raw, pos, sf, 0),
    (_decl, tpl) => {
      const start = tpl.getStart(sf);
      const source = blankSubstitutions(text.slice(start, tpl.end), tpl, start).slice(1, -1);
      const baseLine = sf.getLineAndCharacterOfPosition(start).line;
      const js = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      scanLiterals(js, (raw, p) => report(raw, p, js, baseLine));
    },
  );
  return out;
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`could not locate the project root above ${start}`);
    dir = parent;
  }
}

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
}

const H = "// vocabulary: plain\n";

test("opted-in src modules use only plain terms", () => {
  const root = findRepoRoot(fileURLToPath(new URL(".", import.meta.url)));
  const files: string[] = [];
  walk(path.join(root, "src"), files);
  assert.ok(files.length > 0, "the vocabulary scan found no sources under src/");
  const findings = files.flatMap((f) => vocabularyFindings(path.relative(root, f), fs.readFileSync(f, "utf8")));
  assert.deepEqual(findings, []);
});

test("flags retired words in string and template text, with inflections, not machine names", () => {
  const src = H + 'const a = "the fleet";\nconst b = `drained ${x} ticks`;\nconst c = "tick_end land_queued fleet_paused";\n';
  const f = vocabularyFindings("m.ts", src);
  assert.equal(f.length, 3);
  assert.match(f[0]!, /^m\.ts:2: fleet in /);
  assert.match(f[1]!, /^m\.ts:3: drained in /);
  assert.match(f[2]!, /^m\.ts:3: ticks in /);
  assert.equal(vocabularyFindings("m.ts", H + 'const d = "fleet-wide tumwater(operator): Loop";\n').length, 3);
});

test("ignores retired words in identifiers, comments and template expressions", () => {
  const src = H + "// the fleet loop\nconst fleet = 1;\nconst s = `ok ${fleet.loop} fine`;\n/* tick */\n";
  assert.deepEqual(vocabularyFindings("m.ts", src), []);
});

test("honors vocabulary-ok with a reason and refuses an empty one", () => {
  assert.deepEqual(vocabularyFindings("m.ts", H + 'const a = "tick"; // vocabulary-ok: event type\n'), []);
  assert.equal(vocabularyFindings("m.ts", H + 'const a = "tick"; // vocabulary-ok:\n').length, 1);
  assert.equal(vocabularyFindings("m.ts", H + 'const a = "tick"; // vocabulary-ok:   \n').length, 1);
});

test("skips import specifiers, property-name literals and type literals", () => {
  const src =
    H +
    'import x from "./fleet.js";\nexport * from "./loop.js";\nconst o = { "tick": 1 };\ntype T = "fleet" | "loop";\nconst m = await import("./tick.js");\nconst r = require("./seam.js");\n';
  assert.deepEqual(vocabularyFindings("m.ts", src), []);
});

test("flags JsxText in a tsx fixture", () => {
  const f = vocabularyFindings("v.tsx", H + "const e = <b>the fleet</b>;\n");
  assert.equal(f.length, 1);
  assert.match(f[0]!, /^v\.tsx:2: fleet in /);
});

test("scans String.raw browser blobs by their real file lines", () => {
  const src = [
    "// vocabulary: plain",
    "export const X_JS = String.raw`",
    "var fleet = 1;",
    "el.textContent = 'the loop ' + ${JSON.stringify(\"tick\")};",
    "`;",
    "",
  ].join("\n");
  const f = vocabularyFindings("b.ts", src);
  assert.equal(f.length, 1);
  assert.match(f[0]!, /^b\.ts:4: loop in /);
});

test("does not flag ticket, seamless or lastTickEndedAt", () => {
  assert.deepEqual(vocabularyFindings("m.ts", H + 'const a = "ticket seamless lastTickEndedAt loophole";\n'), []);
});

test("ignores a module without the header", () => {
  assert.deepEqual(vocabularyFindings("m.ts", 'const a = "the fleet";\n'), []);
});
