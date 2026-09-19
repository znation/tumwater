/** The directory-of-timestamped-files queue convention shared by the director's prompt inbox
 * (inbox.ts) and the durable land queue (land-queue.ts): listing, naming, and ENOENT-tolerant
 * removal. Both queues are pinned through their own tests; this file pins the shared rules so
 * they cannot drift apart underneath them. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listQueueFiles, queueFileName, removeQueueFile } from "../src/file-queue.js";
import { tmpdir } from "./util.js";

test("listQueueFiles reads a missing directory as an empty queue", () => {
  const dir = path.join(tmpdir(), "does-not-exist");
  assert.deepEqual(listQueueFiles(dir, ".json"), []);
});

test("listQueueFiles keeps only matching extensions, oldest-first by filename", () => {
  const dir = tmpdir();
  // Deliberately created out of order and interleaved with other extensions.
  for (const name of ["2000-000002-1.json", "1000-000003-1.json", "1000-000001-1.json", "notes.txt", "ENTRY.JSON"]) {
    fs.writeFileSync(path.join(dir, name), "");
  }
  assert.deepEqual(listQueueFiles(dir, ".json"), [
    path.join(dir, "1000-000001-1.json"),
    path.join(dir, "1000-000003-1.json"),
    path.join(dir, "2000-000002-1.json"),
  ]);
  // The extension filter is exact: the uppercase ENTRY.JSON and the .txt file are both excluded.
  assert.deepEqual(listQueueFiles(dir, ".txt"), [path.join(dir, "notes.txt")]);
});

test("queueFileName orders across processes and breaks ties with seq and pid", () => {
  const name = queueFileName(1700000000000, 7, ".json");
  assert.equal(name, `1700000000000-000007-${process.pid}.json`);
  // A later stamp sorts after an earlier one lexicographically (same-width millisecond stamps).
  assert.ok(queueFileName(1700000000001, 1, ".json") > queueFileName(1700000000000, 999999, ".json"));
  // Within one stamp, the zero-padded counter keeps 10 after 9 rather than before it.
  assert.ok(queueFileName(1700000000000, 10, ".json") > queueFileName(1700000000000, 9, ".json"));
});

test("removeQueueFile reports true for a file it removed", () => {
  const dir = tmpdir();
  const file = path.join(dir, "entry.json");
  fs.writeFileSync(file, "x");
  assert.equal(removeQueueFile(file), true);
  assert.ok(!fs.existsSync(file));
});

test("removeQueueFile reports false for a file that already vanished", () => {
  const dir = tmpdir();
  const file = path.join(dir, "entry.json");
  assert.equal(removeQueueFile(file), false);
});

test("removeQueueFile rethrows errors other than ENOENT", () => {
  const dir = tmpdir();
  assert.throws(() => removeQueueFile(dir), (err: NodeJS.ErrnoException) => {
    assert.equal(err.code, "ERR_FS_EISDIR");
    return true;
  });
});
