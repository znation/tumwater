/** scripts/stamp-build.mjs's stale-output prune: `tsc --incremental` never deletes the output
 * of a removed or renamed source, so the script removes every dist .js whose source is gone —
 * and must count a .tsx as a source. Checking .ts alone pruned each .tsx's output right after
 * tsc emitted it, and the incremental build never re-emitted it (2026-10-01: the ink
 * renderer's src/ui/tui/tui.tsx lost dist/src/ui/tui/tui.js, so the CLI could not start). It also keeps
 * dist/test/.durations.json, whose only "source" is the runner's ledger — pruning it reset the
 * longest-first file order on every run. */

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
  touch(path.join(root, "dist", "test", ".durations.json"));

  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });

  const left = (rel: string) => fs.existsSync(path.join(root, "dist", "src", rel));
  assert.ok(left("kept.js"), "a .ts source keeps its output");
  assert.ok(left("ui/app.js"), "a .tsx source keeps its output");
  assert.ok(!left("gone.js") && !left("ui/renamed.js"), "an output with no source is pruned");
  assert.ok(
    fs.existsSync(path.join(root, "dist", "test", ".durations.json")),
    "the suite's durations ledger has no test/ source and is kept by name",
  );
});

test("a string bin entry has its existing target made executable", () => {
  const root = tmpdir("stamp-build-bin-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ bin: "dist/src/cli.js" }));
  touch(path.join(root, "src", "cli.ts"));
  touch(path.join(root, "dist", "src", "cli.js"));

  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });

  assert.equal(
    fs.statSync(path.join(root, "dist", "src", "cli.js")).mode & 0o777,
    0o755,
    "the string form's target regains the exec bit tsc drops",
  );
});

test("an object bin map chmods string targets and ignores non-string values", () => {
  const root = tmpdir("stamp-build-binmap-");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ bin: { tumwater: "dist/src/cli.js", bad: 123, missing: "dist/src/nope.js" } }),
  );
  touch(path.join(root, "src", "cli.ts"));
  touch(path.join(root, "dist", "src", "cli.js"));

  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });

  assert.equal(fs.statSync(path.join(root, "dist", "src", "cli.js")).mode & 0o777, 0o755);
  assert.ok(!fs.existsSync(path.join(root, "dist", "src", "nope.js")), "a missing target is skipped, not created");
});

test("the top-level prune removes a stray file and keeps the named artifacts", () => {
  const root = tmpdir("stamp-build-top-");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  touch(path.join(root, "dist", "stray.txt"));
  touch(path.join(root, "dist", "build-info.json"));
  touch(path.join(root, "dist", "tsconfig.tsbuildinfo"));

  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });

  assert.ok(!fs.existsSync(path.join(root, "dist", "stray.txt")), "a non-directory, non-keep file is pruned");
  assert.ok(fs.existsSync(path.join(root, "dist", "build-info.json")), "the build stamp is kept by name");
  assert.ok(fs.existsSync(path.join(root, "dist", "tsconfig.tsbuildinfo")), "tsc's incremental state is kept by name");
});
