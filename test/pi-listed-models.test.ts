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
