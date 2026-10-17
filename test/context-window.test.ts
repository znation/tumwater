import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_PROMPT_MAX_WINDOW,
  PI_COMPACTION_RESERVE_TOKENS,
  REFERENCE_WINDOW_TOKENS,
  compactPromptWindow,
  compactionPercent,
  declaredWindow,
  windowScale,
} from "../src/pi-extension/context-window.js";

// The shared window arithmetic of the bundled pi extensions (src/pi-extension/context-window.ts):
// values tuned on the 128k window hold at or above it and scale down below it.

test("declaredWindow accepts only a positive finite number", () => {
  assert.equal(declaredWindow(65_536), 65_536);
  for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "65536", {}]) {
    assert.equal(declaredWindow(value), null, String(value));
  }
});

test("windowScale is the share of the 128k window, capped at 1, and 1 when unknown", () => {
  assert.equal(REFERENCE_WINDOW_TOKENS, 128 * 1024);
  assert.equal(windowScale(65_536), 0.5);
  assert.equal(windowScale(REFERENCE_WINDOW_TOKENS), 1);
  assert.equal(windowScale(1_048_576), 1);
  assert.equal(windowScale(undefined), 1);
  assert.equal(windowScale(0), 1);
});

test("compactionPercent is where pi's default reserve puts its compaction", () => {
  assert.equal(PI_COMPACTION_RESERVE_TOKENS, 16_384);
  assert.equal(compactionPercent(REFERENCE_WINDOW_TOKENS), 87.5);
  assert.equal(compactionPercent(65_536), 75);
  assert.equal(compactionPercent(16_384), 0);
  assert.equal(compactionPercent(8_192), 0, "a window inside the reserve compacts at once");
});

test("compactPromptWindow holds for a known window of at most 128k", () => {
  assert.equal(COMPACT_PROMPT_MAX_WINDOW, REFERENCE_WINDOW_TOKENS);
  for (const window of [32_768, 65_536, 126_928, 131_072]) assert.equal(compactPromptWindow(window), true, String(window));
  for (const window of [131_073, 262_144, 1_048_576, undefined, 0, Number.NaN, "65536"]) {
    assert.equal(compactPromptWindow(window), false, String(window));
  }
});
