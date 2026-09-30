import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  findOnPath,
  pruneOldFiles,
  removeQuiet,
  rotateIfLarge,
  statOrNull,
  writeTextAtomic,
} from "../src/files.js";
import { runningAsRoot, tmpdir } from "./repo-fixtures.js";
import { failRenameSyncOn } from "./fs-faults.js";

test("rotateIfLarge rotates once over the cap and replaces the previous rotation", () => {
  const dir = tmpdir();
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, "x".repeat(100));
  assert.equal(rotateIfLarge(file, 1000), false);
  assert.equal(rotateIfLarge(file, 50), true);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(file + ".1", "utf8").length, 100);
  fs.writeFileSync(file, "y".repeat(80));
  assert.equal(rotateIfLarge(file, 50), true);
  assert.equal(fs.readFileSync(file + ".1", "utf8")[0], "y", "old rotation replaced");
  assert.equal(rotateIfLarge(path.join(dir, "missing"), 50), false);
});

test("pruneOldFiles removes only files older than the retention window", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "role"), { recursive: true });
  const oldFile = path.join(dir, "role", "old.jsonl");
  const newFile = path.join(dir, "role", "new.jsonl");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(newFile, "new");
  // A second old file two levels down: the walk must recurse past every directory level.
  const deepDir = path.join(dir, "role", "nested");
  fs.mkdirSync(deepDir, { recursive: true });
  const deepOldFile = path.join(deepDir, "deep.jsonl");
  fs.writeFileSync(deepOldFile, "old");
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
  fs.utimesSync(deepOldFile, tenDaysAgo, tenDaysAgo);
  assert.equal(pruneOldFiles(dir, 7), 2);
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(fs.existsSync(newFile));
  assert.equal(pruneOldFiles(path.join(dir, "nope"), 7), 0);
});

test("findOnPath locates executables like spawn would resolve them", () => {
  const dir = tmpdir();
  const bin = path.join(dir, "pi");
  fs.writeFileSync(bin, "#!/bin/sh\n");
  fs.chmodSync(bin, 0o755);
  assert.equal(findOnPath("pi", dir), bin);

  // A directory named like the binary is not a match (spawn would fail on it too).
  const dirs = tmpdir();
  fs.mkdirSync(path.join(dirs, "pi"));
  assert.equal(findOnPath("pi", dirs), null);

  // Non-executable files are skipped; empty PATH segments are ignored.
  const noexec = tmpdir();
  const plain = path.join(noexec, "pi");
  fs.writeFileSync(plain, "#!/bin/sh\n");
  fs.chmodSync(plain, 0o644);
  assert.equal(findOnPath("pi", `${noexec}::${dir}`), bin);

  // Missing binary or empty PATH.
  assert.equal(findOnPath("definitely-missing-xyz", dir), null);
  assert.equal(findOnPath("pi", ""), null);
});

test("statOrNull treats a missing file as no data, not an error", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");

  assert.equal(statOrNull(file), null); // missing — no throw

  fs.writeFileSync(file, JSON.stringify({ ticks: 3 }));
  assert.ok(statOrNull(file)!.isFile());
});

test("removeQuiet swallows every failure — an escape would crash the poll that calls it", () => {
  const dir = tmpdir();

  // A path already gone (a concurrent pass or an earlier cycle took it) reads as success.
  assert.doesNotThrow(() => removeQuiet(path.join(dir, "never-existed")));

  // rmSync without recursive throws EISDIR on a directory; whatever the errno, the helper's
  // contract is to stay quiet and leave the target for the next pass (orchestrator marker
  // removal runs every poll cycle).
  const sub = path.join(dir, "subdir");
  fs.mkdirSync(sub);
  assert.doesNotThrow(() => removeQuiet(sub));
  assert.ok(fs.existsSync(sub), "the unremovable target is left in place");

  // A plain file is still removed — swallowing errors must not swallow the delete.
  const marker = path.join(dir, "marker");
  fs.writeFileSync(marker, "x");
  removeQuiet(marker);
  assert.ok(!fs.existsSync(marker));
});

test("pruneOldFiles skips files it cannot delete instead of crashing the session cleanup", () => {
  // A read-only directory makes rmSync fail with EACCES; the walk must skip that file,
  // still prune what it can, and count only what was actually removed. Under root the
  // permission is bypassed — then the file IS pruned, which also satisfies "no crash".
  const asRoot = runningAsRoot();
  const dir = tmpdir();
  const lockedDir = path.join(dir, "locked");
  fs.mkdirSync(lockedDir);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  const lockedOld = path.join(lockedDir, "old.jsonl");
  fs.writeFileSync(lockedOld, "old");
  fs.utimesSync(lockedOld, tenDaysAgo, tenDaysAgo);
  const freeOld = path.join(dir, "free.jsonl");
  fs.writeFileSync(freeOld, "old");
  fs.utimesSync(freeOld, tenDaysAgo, tenDaysAgo);

  try {
    if (!asRoot) fs.chmodSync(lockedDir, 0o555); // readable and searchable, not writable
    let pruned = -1;
    assert.doesNotThrow(() => {
      pruned = pruneOldFiles(dir, 7);
    });
    assert.ok(!fs.existsSync(freeOld), "the removable file is still pruned");
    if (asRoot) {
      assert.equal(pruned, 2);
    } else {
      assert.equal(pruned, 1, "only the removable file counts");
      assert.ok(fs.existsSync(lockedOld), "the unremovable file stays for the next pass");
    }
  } finally {
    fs.chmodSync(lockedDir, 0o755); // restore so temp-dir cleanup can remove it
  }
});

test("pruneOldFiles skips symlinks: it neither deletes a linked file nor walks a linked directory", () => {
  // A symlink is neither file nor directory under lstat semantics (the readdir entry's
  // isFile/isDirectory are both false), so the walk must skip it on both counts. The stakes
  // are real: pruneOldFiles is the session cleanup's delete pass, and a walk that followed
  // links would delete (or prune inside) whatever the link points at — data the retention
  // window does not own and may sit far outside the pruned tree.
  const dir = tmpdir();
  const outside = tmpdir();
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);

  // An old file outside the prune root, linked from inside it.
  const linkedFile = path.join(outside, "old.jsonl");
  fs.writeFileSync(linkedFile, "old");
  fs.utimesSync(linkedFile, tenDaysAgo, tenDaysAgo);
  fs.symlinkSync(linkedFile, path.join(dir, "link.jsonl"));

  // Same stake one level deeper: a linked directory must not be recursed into, or the
  // walk would prune the target tree's own old files.
  const linkedDir = path.join(outside, "tree");
  fs.mkdirSync(linkedDir);
  const linkedDirOld = path.join(linkedDir, "old.jsonl");
  fs.writeFileSync(linkedDirOld, "old");
  fs.utimesSync(linkedDirOld, tenDaysAgo, tenDaysAgo);
  fs.symlinkSync(linkedDir, path.join(dir, "tree-link"), "dir");

  // A dangling link: skipped like any non-regular entry, never a crash mid-walk.
  fs.symlinkSync(path.join(outside, "vanished-target"), path.join(dir, "dangling.jsonl"));

  assert.equal(pruneOldFiles(dir, 7), 0, "nothing counts as pruned");
  assert.ok(fs.existsSync(linkedFile), "the linked file itself survives");
  assert.ok(fs.existsSync(linkedDirOld), "nothing inside the linked directory is pruned");
  // The links are checked with lstat: existsSync follows them, so a dangling link would
  // read as gone even though it was never touched.
  for (const link of ["link.jsonl", "tree-link", "dangling.jsonl"])
    assert.ok(fs.lstatSync(path.join(dir, link)).isSymbolicLink(), `${link} stays`);
});

test("writeTextAtomic writes the exact text and leaves no tmp remnant", () => {
  const dir = tmpdir();
  const file = path.join(dir, "deep", "queue", "p.md");
  writeTextAtomic(file, "hello world");
  assert.equal(fs.readFileSync(file, "utf8"), "hello world");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-")), []);
});

test("writeTextAtomic rethrows a failed rename and leaves no tmp remnant", () => {
  const dir = tmpdir();
  const file = path.join(dir, "p.md");
  const undo = failRenameSyncOn(file, "boom");
  try {
    assert.throws(() => writeTextAtomic(file, "x"), /boom/);
    assert.ok(!fs.existsSync(file), "the target must stay absent on failure");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")), []);
  } finally {
    undo();
  }
});
