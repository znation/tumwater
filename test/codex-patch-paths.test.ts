// The pure patch-path parser the codex write-guard hook will use (plans/codex-write-guard.md
// "The hook (parts 1–2)"; PLANS.md "Write guard on Codex, part 1/9"): which paths an
// `apply_patch` text writes, from the text alone, with no filesystem.
import test from "node:test";
import assert from "node:assert/strict";
import { patchWritePaths } from "../src/agent/codex/codex-patch-paths.js";

test("the live payload's patch yields the update target", () => {
  const patch =
    "*** Begin Patch\n" +
    "*** Update File: /abs/repo/notes.md\n" +
    "@@\n" +
    "-primary\n" +
    "+GUARD_TEST\n" +
    "*** End Patch";
  assert.deepEqual(patchWritePaths(patch), ["/abs/repo/notes.md"]);
});

test("an Add, a Delete, an Update and a Move each yield their path, in order", () => {
  const patch =
    "*** Add File: a/new.ts\n" +
    "*** Delete File: b/gone.ts\n" +
    "@@\n" +
    "-old\n" +
    "+new\n" +
    "*** Update File: c/keep.ts\n" +
    "*** Move to: b/moved.ts";
  assert.deepEqual(patchWritePaths(patch), [
    "a/new.ts",
    "b/gone.ts",
    "c/keep.ts",
    "b/moved.ts",
  ]);
});

test("a hunk line that reads like a header is not counted", () => {
  const patch = "+*** Update File: evil.ts\n-*** Delete File: evil2.ts\n *** Add File: evil3.ts\n@@ ev\n*** Update File: good.ts";
  assert.deepEqual(patchWritePaths(patch), ["good.ts"]);
});

test("CRLF line endings and trailing spaces are stripped", () => {
  const patch = "*** Update File: notes.md   \r\n*** Update File: docs.md\r\n";
  assert.deepEqual(patchWritePaths(patch), ["notes.md", "docs.md"]);
});

test("a repeated path is listed once", () => {
  const patch =
    "*** Update File: notes.md\n" +
    "*** Add File: notes.md\n" +
    "*** Delete File: notes.md";
  assert.deepEqual(patchWritePaths(patch), ["notes.md"]);
});

test("empty text yields []", () => {
  assert.deepEqual(patchWritePaths(""), []);
});

test("paths not written (garbage text and an empty header) yield none", () => {
  assert.deepEqual(patchWritePaths("just some text\nno headers here\n"), []);
  assert.deepEqual(patchWritePaths("*** Update File: \n"), []);
});
