import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  findOnPath,
  forEachTailChunk,
  pruneOldFiles,
  removeQuiet,
  rotateIfLarge,
  statOrNull,
} from "../src/files.js";
import { tmpdir, vanishOnOpen, vanishOnReadFile } from "./util.js";

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

test("forEachTailChunk delivers chunks newest-first and honors onChunk's early stop", () => {
  const dir = tmpdir();
  const file = path.join(dir, "log.jsonl");
  // Exactly three tail chunks (8 KB each), with a position-identifiable byte pattern.
  const data = Buffer.alloc(3 * 8192);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(file, data);

  // Early stop: a callback that returns true after the first chunk must not read further —
  // this is what keeps per-poll I/O bounded by the caller's need (readEvents' limit lines,
  // readWindowEvents' window) rather than by how far the log has grown.
  const stopped: Buffer[] = [];
  forEachTailChunk(file, (chunk) => {
    stopped.push(Buffer.from(chunk));
    return true;
  });
  assert.equal(stopped.length, 1, "scan stops after the first chunk");
  assert.ok(stopped[0]!.equals(data.subarray(2 * 8192)), "first chunk is the newest (tail) bytes");

  // No early stop: all three chunks arrive in newest-first order with their exact contents.
  const full: Buffer[] = [];
  forEachTailChunk(file, (chunk) => {
    full.push(Buffer.from(chunk));
    return false;
  });
  assert.equal(full.length, 3);
  for (let k = 0; k < 3; k++) {
    const start = (2 - k) * 8192; // newest first: [16384..), [8192..16384), [0..8192)
    assert.ok(
      full[k]!.equals(data.subarray(start, start + 8192)),
      `chunk ${k} is bytes ${start}..${start + 8192}`,
    );
  }

  // A file at or under the small-file threshold is delivered whole as a single chunk.
  const small = path.join(dir, "small.jsonl");
  fs.writeFileSync(small, "abc\n");
  const smallParts: Buffer[] = [];
  forEachTailChunk(small, (chunk) => {
    smallParts.push(Buffer.from(chunk));
    return true;
  });
  assert.equal(smallParts.length, 1);
  assert.equal(smallParts[0]!.toString("utf8"), "abc\n");

  // A missing file delivers nothing.
  let missingCalls = 0;
  forEachTailChunk(path.join(dir, "nope.jsonl"), () => {
    missingCalls++;
    return false;
  });
  assert.equal(missingCalls, 0);
});

test("forEachTailChunk delivers nothing when rotation removes the file between stat and open", () => {
  const dir = tmpdir();
  // Both read paths: over the small-file threshold opens an fd, at or under it reads whole.
  for (const [name, data] of [
    ["large.jsonl", Buffer.alloc(3 * 8192).fill(0x61)],
    ["small.jsonl", Buffer.from("abc\n")],
  ] as const) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    const restore = name === "large.jsonl" ? vanishOnOpen(file) : vanishOnReadFile(file);
    try {
      let calls = 0;
      forEachTailChunk(file, () => {
        calls++;
        return false;
      }); // must not throw — a rotated-away file is no data, like a missing one
      assert.equal(calls, 0, `${name}: nothing delivered`);
    } finally {
      restore();
    }
  }
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
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
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

