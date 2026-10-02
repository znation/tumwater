/** scripts/stamp-build.mjs's stale-output prune: `tsc --incremental` never deletes the output
 * of a removed or renamed source, so the script removes every dist .js whose source is gone —
 * and must count a .tsx as a source. Checking .ts alone pruned each .tsx's output right after
 * tsc emitted it, and the incremental build never re-emitted it (2026-10-01: the ink
 * renderer's src/ui/tui.tsx lost dist/src/ui/tui.js, so the CLI could not start). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./repo-fixtures.js";

// From dist/test/ this is the checkout's scripts/stamp-build.mjs.
const script = fileURLToPath(new URL("../../scripts/stamp-build.mjs", import.meta.url));

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
}

test("the prune keeps a .ts or .tsx source's output and removes a sourceless one", () => {
  const root = tmpdir("stamp-build-");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  touch(path.join(root, "src", "kept.ts"));
  touch(path.join(root, "src", "ui", "app.tsx"));
  for (const out of ["kept.js", "ui/app.js", "gone.js", "ui/renamed.js"]) touch(path.join(root, "dist", "src", out));

  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });

  const left = (rel: string) => fs.existsSync(path.join(root, "dist", "src", rel));
  assert.ok(left("kept.js"), "a .ts source keeps its output");
  assert.ok(left("ui/app.js"), "a .tsx source keeps its output");
  assert.ok(!left("gone.js") && !left("ui/renamed.js"), "an output with no source is pruned");
});
