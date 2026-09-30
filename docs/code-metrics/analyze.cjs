// Static metrics for one checkout: per-line classes (code/comment/blank), tokens, per-function
// McCabe and cognitive complexity, nesting depth, length, params, Halstead-based maintainability
// index, type-escape markers, and imports. Every metric in docs/code-metrics.md derives from this.
//
// Usage: node analyze.cjs <checkout> <out.json> <categories.cjs>
//   <categories.cjs> maps a tracked path to a category ("src…" = production, "test…" = tests,
//   "docs:…" = markdown) or null to skip it: categories-tumwater.cjs, categories-oss.cjs.
// Reads the working tree of every path `git ls-files` lists, so check out the "as of" commit first.
const path = require("path");
const root = path.resolve(process.argv[2]);
const ts = require(require.resolve("typescript", { paths: [root, __dirname] }));
const fs = require("fs");
const { execSync } = require("child_process");

const OUT = process.argv[3];
const category = require(path.resolve(process.argv[4]));
const files = execSync("git ls-files", { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n")
  .filter((f) => category(f) !== null);

const isFn = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);
const isJSDocKind = (k) => k >= ts.SyntaxKind.FirstJSDocNode && k <= ts.SyntaxKind.LastJSDocNode;
const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function fnName(n, sf) {
  if (n.name) return n.name.getText(sf);
  if (ts.isConstructorDeclaration(n)) return "constructor";
  const p = n.parent;
  if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf);
  if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
  if (p && ts.isPropertyDeclaration(p)) return p.name.getText(sf);
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression.getText(sf).slice(0, 30);
    // test("name", () => …) — use the test title
    if (/^(test|it|describe|suite)$/.test(callee) && p.arguments[0] && ts.isStringLiteralLike(p.arguments[0])) return `${callee}(${JSON.stringify(p.arguments[0].text.slice(0, 50))})`;
    return `<arrow in ${callee}()>`;
  }
  return "<anonymous>";
}

// McCabe: 1 + if/?:/for/for-in/for-of/while/do/case/catch/&&/||/??/logical-assign (lizard/ESLint-classic).
// Cognitive (SonarSource, approximated): structural +1 (+nesting) for if/?:/switch/loops/catch;
// +1 for else / else-if (no nesting); +1 per run of like logical operators; nested fns raise nesting.
function analyzeFunction(fn, sf) {
  let cc = 1, cog = 0, maxDepth = 0;
  const body = fn.body;
  function logicalRuns(expr) {
    // count sequences of like operators in a flattened binary logical chain
    const ops = [];
    (function flat(e) {
      if (ts.isParenthesizedExpression(e)) return; // parenthesized sub-chain counted on its own visit
      if (ts.isBinaryExpression(e) && LOGICAL.has(e.operatorToken.kind)) { flat(e.left); ops.push(e.operatorToken.kind); flat(e.right); }
    })(expr);
    let runs = 0;
    for (let i = 0; i < ops.length; i++) if (i === 0 || ops[i] !== ops[i - 1]) runs++;
    return runs;
  }
  function visit(n, depth, cogNest) {
    if (n !== fn && isFn(n)) return; // a nested function is measured as its own unit
    let nextDepth = depth, nextNest = cogNest;
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement: {
        cc++;
        const isElseIf = n.parent && ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
        cog += isElseIf ? 1 : 1 + cogNest;
        if (n.elseStatement && !ts.isIfStatement(n.elseStatement)) cog += 1;
        nextDepth = isElseIf ? depth : depth + 1;
        nextNest = isElseIf ? cogNest : cogNest + 1;
        // walk children manually so the else-if chain does not nest
        visit(n.expression, depth, cogNest);
        visit(n.thenStatement, nextDepth, nextNest);
        if (n.elseStatement) {
          if (ts.isIfStatement(n.elseStatement)) visit(n.elseStatement, depth, cogNest);
          else visit(n.elseStatement, nextDepth, nextNest);
        }
        maxDepth = Math.max(maxDepth, nextDepth);
        return;
      }
      case ts.SyntaxKind.ConditionalExpression: cc++; cog += 1 + cogNest; nextNest = cogNest + 1; break;
      case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForInStatement: case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement:
        cc++; cog += 1 + cogNest; nextDepth = depth + 1; nextNest = cogNest + 1; break;
      case ts.SyntaxKind.SwitchStatement: cog += 1 + cogNest; nextDepth = depth + 1; nextNest = cogNest + 1; break;
      case ts.SyntaxKind.CaseClause: cc++; break;
      case ts.SyntaxKind.CatchClause: cc++; cog += 1 + cogNest; nextDepth = depth + 1; nextNest = cogNest + 1; break;
      case ts.SyntaxKind.TryStatement: nextDepth = depth + 1; break;
      case ts.SyntaxKind.BinaryExpression:
        if (LOGICAL.has(n.operatorToken.kind)) {
          cc++;
          const p = n.parent;
          const parentIsSameChain = p && ts.isBinaryExpression(p) && LOGICAL.has(p.operatorToken.kind);
          if (!parentIsSameChain) cog += logicalRuns(n);
        }
        break;
    }
    maxDepth = Math.max(maxDepth, nextDepth);
    ts.forEachChild(n, (c) => visit(c, nextDepth, nextNest));
  }
  if (body) visit(body, 0, 0);
  return { cc, cog, maxDepth };
}

function lineClasses(sf, text) {
  const nLines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const code = new Uint8Array(nLines + 1), comment = new Uint8Array(nLines + 1);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const seenComments = new Set();
  const tokens = [];
  function markComments(pos) {
    for (const r of [...(ts.getLeadingCommentRanges(text, pos) || []), ...(ts.getTrailingCommentRanges(text, pos) || [])]) {
      if (seenComments.has(r.pos)) continue;
      seenComments.add(r.pos);
      for (let l = lineOf(r.pos); l <= lineOf(r.end - 1); l++) comment[l] = 1;
    }
  }
  function walk(n) {
    if (isJSDocKind(n.kind)) return;
    const kids = n.getChildren(sf).filter((c) => !isJSDocKind(c.kind));
    if (kids.length === 0) {
      markComments(n.pos);
      const s = n.getStart(sf), e = n.end;
      if (e > s) {
        for (let l = lineOf(s); l <= lineOf(e - 1); l++) code[l] = 1;
        tokens.push({ kind: n.kind, text: text.slice(s, e), line: lineOf(s) });
      }
      markComments(n.end);
      return;
    }
    kids.forEach(walk);
  }
  walk(sf);
  if (text.startsWith("#!")) code[0] = 1;
  let c = 0, cm = 0, b = 0, cls = "";
  for (let l = 0; l < nLines; l++) {
    if (code[l]) { c++; cls += "c"; }
    else if (comment[l]) { cm++; cls += "m"; }
    else { b++; cls += "b"; }
  }
  return { lines: nLines, code: c, comment: cm, blank: b, tokens, cls, commentChars: [...seenComments].length };
}

function halstead(tokens) {
  const ops = new Map(), opnds = new Map();
  let N1 = 0, N2 = 0;
  for (const t of tokens) {
    const isOperand = t.kind === ts.SyntaxKind.Identifier || t.kind === ts.SyntaxKind.PrivateIdentifier ||
      (t.kind >= ts.SyntaxKind.FirstLiteralToken && t.kind <= ts.SyntaxKind.LastLiteralToken) ||
      (t.kind >= ts.SyntaxKind.FirstTemplateToken && t.kind <= ts.SyntaxKind.LastTemplateToken) ||
      t.kind === ts.SyntaxKind.TrueKeyword || t.kind === ts.SyntaxKind.FalseKeyword || t.kind === ts.SyntaxKind.NullKeyword;
    if (isOperand) { N2++; opnds.set(t.text, 1); } else { N1++; ops.set(t.text, 1); }
  }
  const n = ops.size + opnds.size, N = N1 + N2;
  return { volume: N * Math.log2(Math.max(n, 2)), N, n };
}

const out = { files: [], functions: [], imports: [] };
for (const f of files) {
  const abs = path.join(root, f);
  const cat = category(f);
  const text = fs.readFileSync(abs, "utf8");
  const rec = { file: f, cat, bytes: Buffer.byteLength(text) };
  if (/\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(f) || f === "test/fixtures/script-shim") {
    if (f === "test/fixtures/script-shim") { // tumwater's one shell script
      const ls = text.split("\n"); if (ls.at(-1) === "") ls.pop();
      rec.lines = ls.length; rec.blank = ls.filter((l) => !l.trim()).length;
      rec.comment = ls.filter((l) => /^\s*#/.test(l) && !l.startsWith("#!")).length;
      rec.code = rec.lines - rec.blank - rec.comment; rec.lang = "sh";
      rec.cls = ls.map((l) => (!l.trim() ? "b" : /^\s*#/.test(l) && !l.startsWith("#!") ? "m" : "c")).join("");
      out.files.push(rec); continue;
    }
    const kind = /\.[cm]?ts$/.test(f) ? ts.ScriptKind.TS : f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kind);
    const lc = lineClasses(sf, text);
    Object.assign(rec, { lines: lc.lines, code: lc.code, comment: lc.comment, blank: lc.blank, lang: /\.[cm]?tsx?$/.test(f) ? "ts" : "js" });
    rec.tokenCount = lc.tokens.length;
    rec.cls = lc.cls;
    rec.markers = { any: [], as: [], nonNull: [], todo: [], decision: [] };
    text.split("\n").forEach((l, i) => { if (/\b(TODO|FIXME|XXX|HACK)\b/.test(l)) rec.markers.todo.push(i); });
    const lineAt = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
    rec.tokens = lc.tokens.map((t) => [t.kind, t.text, t.line]);
    const hv = halstead(lc.tokens); rec.halsteadVolume = hv.volume;
    // type-escape hatches and markers, per file and per line (the per-line lists feed the author split)
    let anyCount = 0, asCount = 0, nonNull = 0, classes = 0, exportsN = 0, interfaces = 0, typeAliases = 0;
    const jsdocTokens = (text.match(/\/\*\*/g) || []).length;
    rec.jsdoc = jsdocTokens;
    rec.lineComments = (text.match(/^\s*\/\/.*/gm) || []).length;
    rec.todo = (text.match(/\b(TODO|FIXME|XXX|HACK)\b/g) || []).length;
    rec.eslintDisable = (text.match(/eslint-disable/g) || []).length;
    rec.tsIgnore = (text.match(/@ts-(ignore|expect-error|nocheck)/g) || []).length;
    const fnStack = [];
    (function visit(n) {
      if (n.kind === ts.SyntaxKind.AnyKeyword) { anyCount++; rec.markers.any.push(lineAt(n)); }
      if (ts.isAsExpression(n) && !(n.type && n.type.kind === ts.SyntaxKind.TypeReference && n.type.getText(sf) === "const")) { asCount++; rec.markers.as.push(lineAt(n)); }
      if (ts.isNonNullExpression(n)) { nonNull++; rec.markers.nonNull.push(lineAt(n)); }
      if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isForStatement(n) || ts.isForInStatement(n) ||
          ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isCaseClause(n) || ts.isCatchClause(n))
        rec.markers.decision.push(lineAt(n));
      else if (ts.isBinaryExpression(n) && LOGICAL.has(n.operatorToken.kind))
        rec.markers.decision.push(sf.getLineAndCharacterOfPosition(n.operatorToken.getStart(sf)).line);
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) classes++;
      if (ts.isInterfaceDeclaration(n)) interfaces++;
      if (ts.isTypeAliasDeclaration(n)) typeAliases++;
      if (ts.canHaveModifiers(n) && (ts.getModifiers(n) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exportsN++;
      if (ts.isImportDeclaration(n) || (ts.isExportDeclaration(n) && n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        const typeOnly = ts.isImportDeclaration(n) ? !!(n.importClause && n.importClause.isTypeOnly) : n.isTypeOnly;
        out.imports.push({ from: f, spec, typeOnly });
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        out.imports.push({ from: f, spec: n.arguments[0].text, dynamic: true });
      }
      if (isFn(n)) {
        const s = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line, e = sf.getLineAndCharacterOfPosition(n.end).line;
        const m = analyzeFunction(n, sf);
        // length = code lines within the span (nested functions included)
        const fnCode = new Set(lc.tokens.filter((t) => t.line >= s && t.line <= e).map((t) => t.line)).size;
        const fnTokens = lc.tokens.filter((t) => t.line >= s && t.line <= e);
        const fv = halstead(fnTokens).volume;
        const mi = Math.max(0, (171 - 5.2 * Math.log(Math.max(fv, 1)) - 0.23 * m.cc - 16.2 * Math.log(Math.max(fnCode, 1))) * 100 / 171);
        out.functions.push({
          file: f, cat, name: fnName(n, sf), line: s + 1, span: e - s + 1, codeLines: fnCode,
          params: n.parameters.length, cc: m.cc, cog: m.cog, depth: m.maxDepth, mi,
          kind: ts.SyntaxKind[n.kind], nestedIn: fnStack.length,
          async: !!(ts.getModifiers(n) || []).some((x) => x.kind === ts.SyntaxKind.AsyncKeyword),
        });
        fnStack.push(1); ts.forEachChild(n, visit); fnStack.pop();
        return;
      }
      ts.forEachChild(n, visit);
    })(sf);
    Object.assign(rec, { anyCount, asCount, nonNull, classes, exportsN, interfaces, typeAliases });
  } else if (f.endsWith(".md")) {
    const ls = text.split("\n"); if (ls.at(-1) === "") ls.pop();
    let inFence = false, fenced = 0;
    for (const l of ls) { if (/^\s*```/.test(l)) { inFence = !inFence; fenced++; continue; } if (inFence) fenced++; }
    const prose = text.replace(/```[\s\S]*?```/g, "");
    rec.lineWords = ls.map((l) => (l.match(/[A-Za-z0-9][\w'’.-]*/g) || []).length);
    Object.assign(rec, { lang: "md", lines: ls.length, blank: ls.filter((l) => !l.trim()).length, fencedLines: fenced,
      words: (prose.match(/[A-Za-z0-9][\w'’.-]*/g) || []).length, headings: ls.filter((l) => /^#{1,6} /.test(l)).length });
  } else if (!f.endsWith(".png")) {
    const ls = text.split("\n"); if (ls.at(-1) === "") ls.pop();
    Object.assign(rec, { lang: path.extname(f).slice(1) || "other", lines: ls.length, blank: ls.filter((l) => !l.trim()).length });
  } else rec.lang = "png";
  out.files.push(rec);
}

fs.writeFileSync(OUT, JSON.stringify(out));
console.log("files", out.files.length, "functions", out.functions.length, "imports", out.imports.length);
