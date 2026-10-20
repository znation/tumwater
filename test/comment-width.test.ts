import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { repoRoot } from "./helpers/repo-root.js";

// Comments in this tree wrap at 100 columns; code lines have no limit. This test makes that
// a deterministic gate: a new long comment line fails the commit that adds it, and the clean
// loop stops hand-sweeping the theme with ad hoc greps. ESLint's core max-len is deprecated
// (removed in ESLint 11) and its replacement would be a new dependency, which PRINCIPLES.md
// rules out, so this is a node:test file like test/exports.test.ts.

const MAX_COMMENT_COLUMNS = 100;

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
function tsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(full);
  }
  return out;
}

// A line is a comment line when its trimmed text starts with `//`, or when it lies inside a
// block comment. Block comments are tracked with one flag per file: a line whose trimmed text
// starts with `/*` opens the block (outside an open block), and the first `*/` on that line or
// a later one closes it. That keeps a `* …` markdown bullet inside a template literal (as prompt
// text could hold) out of scope. Width is in code points ([...line].length), so an em dash
// counts as one column, as a terminal shows it. A line that starts with `/*` while a block is
// already open is a `nested` offender: a rewrap that left a stray `/**` at the start of an
// overflow line, which the width check alone cannot see.
interface Offender {
  number: number;
  text: string;
  kind: "cols" | "nested";
}

function commentOffenders(text: string): Offender[] {
  const offenders: Offender[] = [];
  let inBlock = false;
  text.split("\n").forEach((line, i) => {
    const trimmed = line.trimStart();
    if (inBlock || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      if ([...line].length > MAX_COMMENT_COLUMNS) {
        offenders.push({ number: i + 1, text: line, kind: "cols" });
      }
    }
    if (inBlock && trimmed.startsWith("/*")) {
      offenders.push({ number: i + 1, text: line, kind: "nested" });
    }
    if (trimmed.startsWith("/*")) inBlock = true;
    if (inBlock && line.includes("*/")) inBlock = false;
  });
  return offenders;
}

function offendersInFile(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return commentOffenders(text).map(({ number, kind }) => `${file}:${number} (${kind})`);
}

test("every comment line in src/ and test/ fits in 100 columns and opens no block inside a block", () => {
  const root = repoRoot(TEST_DIR);
  const offenders: string[] = [];
  for (const rootName of ["src", "test"]) {
    for (const file of tsFiles(path.join(root, rootName))) {
      offenders.push(...offendersInFile(file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("commentOffenders flags over-wide comment lines only", () => {
  // A 101-column `//` line and a 101-column line inside a `/* … */` block are offenders; a
  // 101-column code line, a 101-column `* bullet` inside a template literal, and a 100-column
  // comment holding an em dash are not.
  const wide = "y".repeat(99);
  const templateFill = "template paragraph of plain text";
  const sample = [
    "const code = '" + "z".repeat(101) + "';",
    "// " + wide + " and a bit more to cross 101 columns",
    "/* " + wide + " and a bit more inside a block",
    " * " + wide + " and a bit more still inside the block",
    " */",
    "const tpl = `",
    " * bullet " + templateFill + templateFill + templateFill,
    "`;",
  ];
  const offenders = commentOffenders(sample.join("\n"));
  assert.ok(offenders.some((o) => o.text.startsWith("// ")));
  assert.ok(offenders.some((o) => o.text.startsWith("/* ")));
  assert.ok(offenders.some((o) => o.text.startsWith(" * ")));
  assert.ok(!offenders.some((o) => o.text.startsWith("const code")));
  assert.ok(!offenders.some((o) => o.text.includes("bullet")));
});

test("commentOffenders flags a block opened inside a block as nested", () => {
  const nested = commentOffenders(["/** a", "/** b", " */"].join("\n"));
  assert.deepEqual(
    nested.map((o) => [o.number, o.kind]),
    [[2, "nested"]],
  );
  assert.deepEqual(commentOffenders(["/** a */", "/** b */"].join("\n")), []);
});
