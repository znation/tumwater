import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Comments cite plans by quoted title, by quoted title (the file name, then the title in
// double quotes). This test fails when such a citation matches no heading or one-line Done
// record in PLANS.md or PLANS-DONE.md (where finished plans are archived), so an edit that
// drops a record cannot merge silently. Only this exact quoted form is checked: unquoted
// citations (PLANS.md 2026-09-30, part 1/3) are out of scope.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
// The suite runs both from test/ and from dist/test/, so walk up to the repo root.
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
const ROOT = repoRoot(TEST_DIR);

function normalize(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("every quoted PLANS.md title cited in a src/ or test/ comment names a record", () => {
  const plans = ["PLANS.md", "PLANS-DONE.md"]
    .map((file) => path.join(ROOT, file))
    .filter((full) => fs.existsSync(full))
    .flatMap((full) => fs.readFileSync(full, "utf8").split("\n"));
  const titles: string[] = [];
  for (const line of plans) {
    const m = /^### (.*)$/.exec(line) ?? /^- (.*\(planned .*)$/.exec(line);
    if (m) titles.push(normalize(m[1]!));
  }
  assert.ok(titles.length > 0, "no titles found in PLANS.md");

  const dead: string[] = [];
  let checked = 0;
  for (const dir of ["src", "test"]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const file of walk(base)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      let i = 0;
      while (i < lines.length) {
        if (!/^(\/\/|\/\*|\*)/.test(lines[i]!.trim())) {
          i++;
          continue;
        }
        const start = i;
        const parts: string[] = [];
        while (i < lines.length && /^(\/\/|\/\*|\*)/.test(lines[i]!.trim())) {
          parts.push(lines[i]!.trim().replace(/^(\/\/|\/\*\*|\/\*|\*\/|\*) ?/, ""));
          i++;
        }
        const joined = parts.join(" ");
        for (const m of joined.matchAll(/PLANS\.md "([^"]+)"/g)) {
          checked++;
          const quote = normalize(m[1]!);
          if (!titles.some((t) => t.includes(quote))) {
            dead.push(`${path.relative(ROOT, file)}:${start + 1} "${m[1]}"`);
          }
        }
      }
    }
  }
  assert.ok(checked > 0, "found no quoted PLANS.md citations to check");
  assert.deepEqual(dead, [], `dead PLANS.md citations:\n${dead.join("\n")}`);
});
