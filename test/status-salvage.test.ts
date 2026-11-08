import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectSalvagePatches, grepSalvagePatches, readSalvagePatch } from "../src/status/status-salvage.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { makeRepo, runningAsRoot } from "./fixtures/repo-fixtures.js";

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

test("grepSalvagePatches matches file names and patch text, keeping whole-list positions and order", () => {
  const root = makeRepo();
  fs.mkdirSync(salvageDir(root), { recursive: true });
  const older = path.join(salvageDir(root), "a.patch");
  const newer = path.join(salvageDir(root), "b.patch");
  fs.writeFileSync(older, "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n");
  fs.writeFileSync(newer, "newer patch body\n");
  fs.utimesSync(older, new Date(0), new Date(0));
  fs.utimesSync(newer, new Date(1), new Date(1));
  const patches = collectSalvagePatches(root);
  // A file-name match keeps the row under its whole-list position.
  assert.deepEqual(grepSalvagePatches(root, patches, "B.patch").map((r) => r.position), [2]);
  // A patch-text match is case-insensitive.
  assert.deepEqual(grepSalvagePatches(root, patches, "BODY").map((r) => r.file), ["b.patch"]);
  // A pattern in both keeps both rows in the collected order under their own positions.
  assert.deepEqual(
    grepSalvagePatches(root, patches, "new").map((r) => ({ position: r.position, file: r.file })),
    [
      { position: 1, file: "a.patch" },
      { position: 2, file: "b.patch" },
    ],
  );
  assert.deepEqual(grepSalvagePatches(root, patches, "zzz"), []);
  assert.equal(patches.length, 2, "the filter never mutates its input");
});

test("grepSalvagePatches lets an unreadable patch match by name only", { skip: runningAsRoot() }, () => {
  const root = makeRepo();
  fs.mkdirSync(salvageDir(root), { recursive: true });
  const unreadable = path.join(salvageDir(root), "keep-me.patch");
  const readable = path.join(salvageDir(root), "other.patch");
  fs.writeFileSync(unreadable, "secret body\n");
  fs.writeFileSync(readable, "second patch\n");
  fs.chmodSync(unreadable, 0o000);
  fs.utimesSync(unreadable, new Date(0), new Date(0));
  fs.utimesSync(readable, new Date(1), new Date(1));
  const patches = collectSalvagePatches(root);
  assert.equal(readSalvagePatch(root, "keep-me.patch"), null, "the seeded patch reads as null");
  assert.deepEqual(grepSalvagePatches(root, patches, "keep-me").map((r) => r.position), [1]);
  assert.deepEqual(grepSalvagePatches(root, patches, "secret"), [], "its unreadable text cannot match");
  assert.deepEqual(grepSalvagePatches(root, patches, "second").map((r) => r.position), [2]);
});
