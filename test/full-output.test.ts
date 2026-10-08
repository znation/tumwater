import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findTumwaterRoot, writeFullOutput } from "../src/pi-extension/full-output.js";
import { tmpdir } from "./repo-fixtures.js";
import { dieMidWrite } from "./helpers/fs-faults.js";

test("writeFullOutput writes into .tumwater/log/tool-output named by toolCallId", () => {
  const dir = tmpdir("bound-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const nested = path.join(dir, "worktrees", "feature");
  fs.mkdirSync(nested, { recursive: true });
  const file = writeFullOutput("full output text", "call-42", nested);
  assert.ok(file, "returns the written path");
  assert.equal(file, path.join(dir, ".tumwater", "log", "tool-output", "call-42.log"));
  assert.equal(fs.readFileSync(file!, "utf-8"), "full output text");
});

test("writeFullOutput returns null when no ancestor has .tumwater/", () => {
  const dir = tmpdir("bound-none-");
  assert.equal(writeFullOutput("text", "call-1", dir), null);
});

test("writeFullOutput leaves no truncated log when the process dies mid-write", () => {
  const dir = tmpdir("bound-kill-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const nested = path.join(dir, "worktrees", "feature");
  fs.mkdirSync(nested, { recursive: true });
  const target = path.join(dir, ".tumwater", "log", "tool-output", "call-kill.log");
  // The write reaches the disk partway and then the process is gone: a plain direct write
  // would leave `ful` at the marker path, which the model would later read back as the whole
  // output. The atomic tmp+rename must leave the target absent instead.
  const restore = dieMidWrite("ful");
  try {
    assert.equal(writeFullOutput("full output text", "call-kill", nested), null);
  } finally {
    restore();
  }
  assert.equal(
    fs.existsSync(target),
    false,
    "a mid-write death must not leave a truncated log at the marker path",
  );
});

test("writeFullOutput returns null when the write fails instead of throwing", () => {
  const dir = tmpdir("bound-fail-");
  fs.mkdirSync(path.join(dir, ".tumwater", "log"), { recursive: true });
  // .tumwater/log/tool-output exists as a regular file, so the recursive mkdirSync inside
  // writeFullOutput throws: the catch must turn that into null (a failing write can never
  // crash a tick's tool_result handling), and nothing is written.
  fs.writeFileSync(path.join(dir, ".tumwater", "log", "tool-output"), "occupied");
  assert.equal(writeFullOutput("text", "call-9", dir), null);
});

test("findTumwaterRoot gives up after 64 levels without .tumwater/ instead of looping forever", () => {
  // A chain deeper than the walk's 64-level cap, with no .tumwater/ on any ancestor of it:
  // the walk exhausts its depth budget and returns null (it must terminate by depth, not
  // only by reaching the filesystem root).
  const base = tmpdir("bound-deep-");
  const deep = path.join(base, ...Array(70).fill("d"));
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findTumwaterRoot(deep), null);
});

test("findTumwaterRoot walks up to the harness root", () => {
  const dir = tmpdir("bound-root-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const deep = path.join(dir, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findTumwaterRoot(deep), dir);
  const bare = tmpdir("bound-bare-");
  assert.equal(findTumwaterRoot(bare), null);
});

test("writeFullOutput falls back to a timestamped name when the tool call has no id", () => {
  // Parallel tool mode names files by toolCallId; a call without one (or with a junk-free
  // empty id) still gets a file — named by the current time instead of crashing or
  // colliding on a bare ".log".
  const dir = tmpdir("bound-id-");
  fs.mkdirSync(path.join(dir, ".tumwater"));
  const nested = path.join(dir, "worktrees", "feature");
  fs.mkdirSync(nested, { recursive: true });
  const file = writeFullOutput("full output text", undefined, nested);
  assert.ok(file, "returns the written path");
  assert.match(file!, /result-\d+\.log$/, "timestamped name");
  assert.equal(fs.readFileSync(file!, "utf-8"), "full output text");
});
