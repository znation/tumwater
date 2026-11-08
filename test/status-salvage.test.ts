import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectSalvagePatches, readSalvagePatch } from "../src/status/status-salvage.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { makeRepo } from "./fixtures/repo-fixtures.js";

test("collectSalvagePatches returns [] for a missing salvage directory", () => {
  const root = makeRepo();
  assert.deepEqual(collectSalvagePatches(root), []);
});

test("collectSalvagePatches ignores a pending patch and a non-.patch file", () => {
  const root = makeRepo();
  // A patch waiting for a role's next run is deliberately out of scope.
  fs.mkdirSync(salvagePendingDir(root, "feature"), { recursive: true });
  fs.writeFileSync(path.join(salvagePendingDir(root, "feature"), "a.patch"), "pending work");
  // A non-patch file directly under the salvage dir is not a kept patch.
  fs.mkdirSync(salvageDir(root), { recursive: true });
  fs.writeFileSync(path.join(salvageDir(root), "scratch.txt"), "verification output");
  assert.deepEqual(collectSalvagePatches(root), []);
});

test("collectSalvagePatches returns two direct patches oldest first with their sizes", () => {
  const root = makeRepo();
  fs.mkdirSync(salvageDir(root), { recursive: true });
  const older = path.join(salvageDir(root), "a.patch");
  const newer = path.join(salvageDir(root), "b.patch");
  fs.writeFileSync(older, "old");
  fs.writeFileSync(newer, "newer");
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 10_000), new Date(now - 10_000));
  fs.utimesSync(newer, new Date(now), new Date(now));
  const patches = collectSalvagePatches(root);
  assert.deepEqual(patches.map((p) => p.file), ["a.patch", "b.patch"]);
  assert.equal(patches[0]!.savedAt, now - 10_000);
  assert.equal(patches[0]!.bytes, 3);
  assert.equal(patches[1]!.savedAt, now);
  assert.equal(patches[1]!.bytes, 5);
});

test("readSalvagePatch returns a direct patch's exact text and null for a missing file", () => {
  const root = makeRepo();
  fs.mkdirSync(salvageDir(root), { recursive: true });
  const patch = path.join(salvageDir(root), "a.patch");
  fs.writeFileSync(patch, "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(readSalvagePatch(root, "a.patch"), "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(readSalvagePatch(root, "missing.patch"), null);
});

test("collectSalvagePatches skips non-regular children and never throws", () => {
  const root = makeRepo();
  fs.mkdirSync(salvageDir(root), { recursive: true });
  // A subdirectory whose name looks like a patch is not a regular file and is skipped.
  fs.mkdirSync(path.join(salvageDir(root), "dir.patch"));
  const regular = path.join(salvageDir(root), "ok.patch");
  fs.writeFileSync(regular, "body");
  fs.utimesSync(regular, new Date(0), new Date(0));
  const patches = collectSalvagePatches(root);
  assert.deepEqual(patches.map((p) => p.file), ["ok.patch"]);
  assert.equal(patches[0]!.savedAt, 0);
});
