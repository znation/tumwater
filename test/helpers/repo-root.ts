/** The tests' single home for "find the repo root from this test file": the suite runs both from
 * test/ (node --test on the source) and from dist/test/ (the compiled runner), so walk up from
 * `from` to the directory that has package.json and src/. Throws if there is none. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export function repoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src"))) return dir;
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, `no repo root above ${from}`);
    dir = parent;
  }
}
