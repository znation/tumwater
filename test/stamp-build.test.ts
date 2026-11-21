/** scripts/stamp-build.mjs's stale-output prune: `tsc --incremental` never deletes the output
 * of a removed or renamed source, so the script removes every dist .js whose source is gone.
 * A .js output's source is its .ts alone — the .tsx exception the ink renderer needed is gone
 * with the renderer, and the fixture below keeps a nested source's output exercised (a pruned
 * output never comes back: the incremental build does not re-emit it, 2026-10-01). It also
 * keeps dist/test/.durations.json, whose only "source" is the runner's ledger — pruning it
 * reset the longest-first file order on every run. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

// From dist/test/ this is the checkout's scripts/stamp-build.mjs.
const script = fileURLToPath(new URL("../../scripts/stamp-build.mjs", import.meta.url));

function touch(file: string): void {
  writeFileDeep(file, "");
}

test("the prune keeps a .ts source's output and removes a sourceless one", () => {
  const root = tmpdir("stamp-build-");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  touch(path.join(root, "src", "kept.ts"));
  touch(path.join(root, "src", "ui", "app.ts"));
  // A leftover .tsx source compiles to nothing now, so its stale output is pruned: the
  // script has no .tsx branch to keep it (the renderer that needed one is gone).
  touch(path.join(root, "src", "ui", "stale.tsx"));
  for (const out of ["kept.js", "ui/app.js", "ui/stale.js", "gone.js", "ui/renamed.js"])
    touch(path.join(root, "dist", "src", out));
  touch(path.join(root, "dist", "test", ".durations.json"));

  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });

  const left = (rel: string) => fs.existsSync(path.join(root, "dist", "src", rel));
  assert.ok(left("kept.js"), "a .ts source keeps its output");
  assert.ok(left("ui/app.js"), "a nested .ts source keeps its output");
  assert.ok(!left("ui/stale.js"), "a .tsx source is no longer a source, so its output is pruned");
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

test("the stamp the build script writes names the release when HEAD is the tagged commit", () => {
  // The prepack path: `npm publish` builds from the tagged commit, so the shipped
  // dist/build-info.json names the version. Expected values come from the version and tag this
  // test writes, never from the code under test.
  const root = tmpdir("stamp-build-release-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "tumwater", version: "1.2.3" }));
  touch(path.join(root, "src", "cli.ts"));
  touch(path.join(root, "dist", "src", "cli.js"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  // The identity the commit needs is pinned on the argv, not left to the ambient config:
  // makeRepo's fixture repos carry it in .git/config, and a bare `git init` here carries none,
  // so a machine (or CI container) with no global user.name would fail this test outright.
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", root, "tag", "v1.2.3"]);

  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });

  const stamp = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"));
  assert.equal(stamp.release, "1.2.3", "the packed stamp names the release");

  // With the tag deleted (a checkout build), the same script stamps no release.
  execFileSync("git", ["-C", root, "tag", "-d", "v1.2.3"]);
  execFileSync(process.execPath, [script], { cwd: root, stdio: "ignore" });
  const plain = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"));
  assert.equal(plain.release, undefined, "an untagged build names no version");
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
