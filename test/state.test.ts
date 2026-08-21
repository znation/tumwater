import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freshLoopState, loadLoopState, nextBackoffSeconds, saveLoopState } from "../src/state.js";
import type { LoopState } from "../src/types.js";
import { statePath } from "../src/paths.js";
import { defaultConfig } from "../src/config.js";
import { tmpdir } from "./util.js";

/** Every field a fresh state has must hold its default value (extra junk keys are allowed). */
function assertFreshFields(s: LoopState, role: string): void {
  const fresh = freshLoopState(role);
  for (const key of Object.keys(fresh)) {
    assert.equal(
      s[key as keyof LoopState],
      fresh[key as keyof LoopState],
      `field ${key} should keep its default`,
    );
  }
}

test("loadLoopState returns fresh defaults when no file exists", () => {
  const dir = tmpdir();
  assert.deepEqual(loadLoopState(dir, "clean"), freshLoopState("clean"));
});

test("saveLoopState creates the state dir and round-trips without leaving a temp file", () => {
  const dir = tmpdir();
  const s = freshLoopState("feature");
  s.ticks = 7;
  s.totalTokens = 123456;
  s.lastResult = "changed";
  saveLoopState(dir, s); // .automaton/ does not exist yet
  assert.ok(fs.existsSync(statePath(dir, "feature")));
  const stateDir = path.dirname(statePath(dir, "feature"));
  assert.deepEqual(fs.readdirSync(stateDir), ["feature.json"], "no .tmp leftovers");
  assert.deepEqual(loadLoopState(dir, "feature"), s);
});

test("loadLoopState fills fields missing from an older or partial file", () => {
  const dir = tmpdir();
  const file = statePath(dir, "clean");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A state file written before totalTokens/lastMainHead existed.
  fs.writeFileSync(file, JSON.stringify({ role: "clean", ticks: 3, commits: 1 }));
  const s = loadLoopState(dir, "clean");
  assert.equal(s.ticks, 3);
  assert.equal(s.commits, 1);
  // loop.ts adds to these every tick; undefined would turn them into NaN.
  assert.equal(s.totalTokens, 0);
  assert.equal(s.backoffSeconds, 0);
  assert.equal(s.lastMainHead, "");
  assert.ok(Number.isFinite(s.nextRunAt));
});

test("loadLoopState recovers from torn or non-object JSON", () => {
  const dir = tmpdir();
  const file = statePath(dir, "dry");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ['{"ticks": 2', '"just a string"', "[1, 2]", "null"]) {
    fs.writeFileSync(file, junk);
    assertFreshFields(loadLoopState(dir, "dry"), "dry"); // must not throw or lose defaults
  }
});

test("nextBackoffSeconds caps an initial above max and treats non-positive current as first", () => {
  const config = defaultConfig();
  config.idleBackoff = { initialSeconds: 100, factor: 2, maxSeconds: 30 };
  assert.equal(nextBackoffSeconds(0, config), 30); // min(initial, max)
  assert.equal(nextBackoffSeconds(-5, config), 30); // current <= 0 → initial (capped)
  assert.equal(nextBackoffSeconds(29, config), 30); // growth still capped at max
});
