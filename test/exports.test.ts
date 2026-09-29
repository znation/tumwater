import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// A deterministic unused-export check: tsconfig's noUnusedLocals does not cover exports, so an
// exported symbol nothing outside its own file uses would otherwise cost a clean tick per case.
// This test fails in the author's gate check instead. Tests count as users: exported-for-test is
// legitimate.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
// The suite runs both from test/ (node --test on the source) and from dist/test/ (the compiled
// runner), so find the repo root by walking up to the directory that has package.json and src/.
function repoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "src"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no repo root above ${from}`);
    dir = parent;
  }
}
const SCAN_ROOTS = ["src", "test", "scripts"].map((dir) => path.join(repoRoot(TEST_DIR), dir));

// Genuine entry points with no in-tree user yet, as "src/file.ts: Name". Keep it short and
// commented; the goal is an empty list.
const ALLOWED = new Set<string>([]);

// Only top-level declarations matter: the line must start (after whitespace) with `export`, so
// `// export const x` and other comment lines are not declarations. Block-comment lines
// (`* ...`, `/* ...`) are skipped the same way.
const DECLARATION =
  /^\s*export\s+(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function declarations(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const match = trimmed.match(DECLARATION);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function userRegex(name: string): RegExp {
  // Whole-word: nothing identifier-shaped may touch the name on either side (lookarounds rather
  // than \b, because \b misbehaves around `$` in names like `$fetch`).
  return new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`);
}

function rel(file: string): string {
  return path.relative(repoRoot(TEST_DIR), file).split(path.sep).join("/");
}

test("no exported symbol goes unused outside its own file", () => {
  const files = SCAN_ROOTS.flatMap((root) => (fs.existsSync(root) ? tsFiles(root) : []));
  assert.ok(files.length > 0, "the scan found TypeScript files under src/, test/, scripts/");
  const texts = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));
  const offenders: string[] = [];
  for (const [file, text] of texts) {
    for (const name of declarations(text)) {
      const re = userRegex(name);
      const used = [...texts].some(([other, otherText]) => other !== file && re.test(otherText));
      if (!used) offenders.push(`${rel(file)}: ${name}`);
    }
  }
  const unexpected = offenders.filter((entry) => !ALLOWED.has(entry));
  assert.deepEqual(
    unexpected,
    [],
    `exported names with no user outside their own file (drop \`export\`, or use it elsewhere):\n  ${unexpected.join("\n  ")}`,
  );
});
