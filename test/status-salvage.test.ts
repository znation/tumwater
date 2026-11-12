import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  collectSalvagePatches,
  dropSalvagePatch,
  grepSalvagePatches,
  readSalvagePatch,
  salvagePatchAt,
} from "../src/status/status-salvage.js";
import { salvageDir, salvagePendingDir } from "../src/paths.js";
import { makeRepo, runningAsRoot } from "./fixtures/repo-fixtures.js";
test("salvagePatchAt resolves an in-range position to its patch", () => {
  const patches = [
    { position: 1, file: "a.patch", savedAt: 1000, bytes: 3 },
    { position: 2, file: "b.patch", savedAt: 2000, bytes: 5 },
  ];
  assert.deepEqual(salvagePatchAt(patches, 1), { patch: patches[0] });
  assert.deepEqual(salvagePatchAt(patches, 2), { patch: patches[1] });
});
test("salvagePatchAt refuses a below-1 or past-the-list position with the shared sentence", () => {
  const patches = [
    { position: 1, file: "a.patch", savedAt: 1000, bytes: 3 },
    { position: 2, file: "b.patch", savedAt: 2000, bytes: 5 },
  ];
  // The message is the wording every salvage surface (CLI --show/--drop/--apply, the TUI
  // Health apply and drop arms, the dashboard apply/drop endpoints) shows for a bad number,
  // so it is pinned exactly here.
  for (const bad of [0, 3]) {
    const out = salvagePatchAt(patches, bad);
    assert.ok("message" in out);
    assert.equal(out.message, `no salvaged workspace patch at position ${bad} (salvage holds 2 patches)`);
  }
  // An empty list refuses every position, naming that it holds none.
  const empty = salvagePatchAt([], 1);
  assert.ok("message" in empty);
  assert.equal(empty.message, "no salvaged workspace patch at position 1 (salvage holds 0 patches)");
});

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

test("collectSalvagePatches invalidates its stat cache when a new patch is saved", () => {
  const root = makeRepo();
  fs.mkdirSync(salvageDir(root), { recursive: true });
  fs.writeFileSync(path.join(salvageDir(root), "a.patch"), "old");
  // First poll seeds the cache.
  assert.deepEqual(collectSalvagePatches(root).map((p) => p.file), ["a.patch"]);
  // A settled run saves another patch (atomic temp+rename), which bumps the dir stat: the
  // next poll must see it rather than serve a stale cached listing.
  fs.writeFileSync(path.join(salvageDir(root), "b.patch"), "newer");
  assert.deepEqual(collectSalvagePatches(root).map((p) => p.file), ["a.patch", "b.patch"]);
  // A kept patch's content changing while it keeps the same name and the dir is unchanged is
  // never the write path (all saves rename over a new name), but readSalvagePatch must still
  // serve the new bytes, not a stale cache.
  fs.writeFileSync(path.join(salvageDir(root), "b.patch"), "edited");
  assert.equal(readSalvagePatch(root, "b.patch"), "edited");
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
  assert.deepEqual(patches.map((p) => p.position), [1, 2], "positions number the sorted list oldest first");
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
  assert.deepEqual(patches.map((p) => p.position), [1], "a lone patch takes position 1");
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
  // A kept row carries the patch's own whole-list position, not a renumbered index.
  assert.deepEqual(
    grepSalvagePatches(root, patches, "B.patch").map((r) => r.position),
    [2],
    "the filtered row keeps the whole-list position",
  );
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

test("dropSalvagePatch removes a direct patch, returns false for a missing file and leaves a pending patch", () => {
  const root = makeRepo();
  fs.mkdirSync(salvageDir(root), { recursive: true });
  fs.mkdirSync(salvagePendingDir(root, "feature"), { recursive: true });
  const direct = path.join(salvageDir(root), "a.patch");
  const pending = path.join(salvagePendingDir(root, "feature"), "a.patch");
  fs.writeFileSync(direct, "body");
  fs.writeFileSync(pending, "pending work");
  assert.equal(dropSalvagePatch(root, "a.patch"), true, "the direct patch reports dropped");
  assert.equal(fs.existsSync(direct), false, "the direct patch is removed");
  assert.equal(fs.existsSync(pending), true, "the pending patch is untouched");
  assert.equal(dropSalvagePatch(root, "missing.patch"), false, "a missing file returns false");
  assert.equal(fs.existsSync(path.join(salvageDir(root), "a.patch")), false, "a second drop of a gone file stays false");
});
