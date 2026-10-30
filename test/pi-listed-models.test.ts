import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePiModelImages,
  piListedImageInput,
  readPiListedModels,
  writePiListedModels,
} from "../src/pi/pi-listed-models.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

// Unit coverage for the saved `pi --list-models` images column (src/pi/pi-listed-models.ts).

test("parsePiModelImages reads the images column and refuses anything else", () => {
  const header = "provider     model                      context  max-out  thinking  images";
  const table = `${header}\nhuggingface  deepseek-ai/DeepSeek-V3.1  131.1K  8.2K  yes  no\nanthropic    claude-x  200K  8K  yes  yes\n`;
  assert.deepEqual(parsePiModelImages(table), {
    "huggingface/deepseek-ai/DeepSeek-V3.1": false,
    "anthropic/claude-x": true,
  });
  assert.equal(parsePiModelImages('No models matching "x"'), null);
  assert.equal(parsePiModelImages(""), null);
  assert.equal(parsePiModelImages("provider model context\nanthropic claude-x 200K\n"), null);
});

test("readPiListedModels round-trips writePiListedModels and piListedImageInput answers per pair", () => {
  const root = tmpdir("pi-listed-");
  assert.equal(readPiListedModels(root), null);
  writePiListedModels(root, { "a/vision": true, "a/text": false }, 42);
  const listed = readPiListedModels(root);
  assert.deepEqual(listed, { checkedAt: 42, images: { "a/vision": true, "a/text": false } });
  assert.equal(piListedImageInput(listed, "a", "vision"), true);
  assert.equal(piListedImageInput(listed, "a", "text"), false);
  assert.equal(piListedImageInput(listed, "a", "other"), null);
  assert.equal(piListedImageInput(listed, "a", undefined), null);
  assert.equal(piListedImageInput(null, "a", "vision"), null);
});

test("readPiListedModels clone-guards each result and re-reads a rewritten file", () => {
  const root = tmpdir("pi-listed-clone-");
  writePiListedModels(root, { "a/vision": true, "a/text": false }, 42);

  // Two reads of the unchanged file are served from the stat-keyed cache (one stat per poll).
  const first = readPiListedModels(root);
  const second = readPiListedModels(root);
  assert.equal(second?.checkedAt, 42);
  assert.deepEqual(second?.images, { "a/vision": true, "a/text": false });

  // Mutating one caller's result (e.g. a status surface deleting or flipping an entry) must
  // not poison the shared cache entry: the next read is a clone, so it is unaffected.
  assert.ok(first);
  first.images["a/vision"] = false;
  delete first.images["a/text"];
  first.checkedAt = 0;
  const unpoisoned = readPiListedModels(root);
  assert.deepEqual(
    unpoisoned?.images,
    { "a/vision": true, "a/text": false },
    "a caller's images mutation never reaches the shared cache or the next reader",
  );
  assert.equal(unpoisoned?.checkedAt, 42, "a caller's scalar mutation never reaches the next reader");

  // A rewritten file (writeJsonAtomic rename, new inode/stat) invalidates the cache and is
  // re-read with new content.
  writePiListedModels(root, { "a/vision": false }, 7);
  const reread = readPiListedModels(root);
  assert.equal(reread?.checkedAt, 7, "a rewritten listing is re-read, not a stale cached value");
  assert.deepEqual(reread?.images, { "a/vision": false });
  assert.equal(piListedImageInput(reread, "a", "text"), null);
});
