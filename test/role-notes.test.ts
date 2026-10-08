// The bundled role-notes extension (src/pi-extension/role-notes.ts): the `role_notes` tool a
// role's authoring tick uses to leave a bounded note for its next fresh session. The byte
// validation is pure and tested directly; the default export is exercised through a fake pi
// API so registration (only under TUMWATER_NOTES_PATH) and the execute path are both covered.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ROLE_NOTES_MAX_BYTES,
  default as roleNotesExtension,
  validateRoleNote,
  writeRoleNote,
} from "../src/pi-extension/role-notes.js";
import { tmpdir } from "./fixtures/repo-fixtures.js";

/** The subset of pi's registered tool shape the tests drive. */
interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute(toolCallId: string, params: { text?: unknown }): Promise<{ content: Array<{ text: string }> }> | { content: Array<{ text: string }> };
}

function withNotesEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.TUMWATER_NOTES_PATH;
  try {
    if (value === undefined) delete process.env.TUMWATER_NOTES_PATH;
    else process.env.TUMWATER_NOTES_PATH = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TUMWATER_NOTES_PATH;
    else process.env.TUMWATER_NOTES_PATH = prev;
  }
}

function registerTool(): RegisteredTool {
  const registered: RegisteredTool[] = [];
  const api = { registerTool: (tool: RegisteredTool) => registered.push(tool) };
  roleNotesExtension(api as unknown as Parameters<typeof roleNotesExtension>[0]);
  assert.equal(registered.length, 1, "the tool registers when a notebook path is set");
  return registered[0]!;
}

test("validateRoleNote accepts the 4,096-byte boundary and rejects one byte past it", () => {
  assert.equal(validateRoleNote(""), null, "empty text is valid — it clears the note");
  assert.equal(validateRoleNote("a".repeat(ROLE_NOTES_MAX_BYTES)), null, "exactly at the limit");
  const error = validateRoleNote("a".repeat(ROLE_NOTES_MAX_BYTES + 1));
  assert.ok(error, "one byte past the limit is rejected");
  assert.match(error, /limit is 4096 bytes/);
});

test("validateRoleNote counts UTF-8 bytes, not characters", () => {
  // 2,048 characters of "é" are 4,096 bytes: valid. 2,049 are 4,098: rejected.
  assert.equal(validateRoleNote("é".repeat(2048)), null);
  assert.match(validateRoleNote("é".repeat(2049)) ?? "", /limit is 4096 bytes/);
});

test("writeRoleNote writes the text and empty text clears the file", () => {
  const dir = tmpdir();
  const notes = path.join(dir, "state", "notes", "feature.md");
  writeRoleNote(notes, "fact one\nfact two");
  assert.equal(fs.readFileSync(notes, "utf8"), "fact one\nfact two");
  writeRoleNote(notes, "");
  assert.equal(fs.readFileSync(notes, "utf8"), "");
});

test("writeRoleNote removes its temp file when the write cannot complete", () => {
  // A failed write must not litter the notes directory: the temp is written beside the target,
  // and the rename fails when the target path is occupied by a directory (ENOTDIR/EISDIR).
  // Nothing prunes .tumwater/state/notes/, so a leaked temp would survive every tick.
  const dir = tmpdir();
  const notesDir = path.join(dir, "notes");
  const notes = path.join(notesDir, "feature.md");
  fs.mkdirSync(notes, { recursive: true }); // the target path is a directory, so the rename fails
  assert.throws(() => writeRoleNote(notes, "cannot land"), "the failure is rethrown, not swallowed");
  assert.deepEqual(
    fs.readdirSync(notesDir).filter((f) => f.endsWith(".tmp")),
    [],
    "a failed write leaves no .tmp remnant behind",
  );
});

test("writeRoleNote rethrows the original failure when the temp cleanup itself fails", (t) => {
  // The best-effort rmSync can itself fail (a vanished or unremovable temp). That must not mask
  // the write/rename failure the caller needs, so the original error — with its errno code —
  // propagates instead of the cleanup error.
  const dir = tmpdir();
  const notesDir = path.join(dir, "notes");
  const notes = path.join(notesDir, "feature.md");
  fs.mkdirSync(notes, { recursive: true }); // the target path is a directory, so the rename fails
  let original: NodeJS.ErrnoException | undefined;
  try {
    writeRoleNote(notes, "cannot land");
  } catch (err) {
    original = err as NodeJS.ErrnoException;
  }
  assert.ok(original?.code, "precondition: the rename onto a directory fails with an errno code");

  t.mock.method(fs, "rmSync", (() => {
    throw new Error("cleanup unavailable");
  }) as typeof fs.rmSync);
  try {
    assert.throws(
      () => writeRoleNote(notes, "cannot land"),
      (err: unknown) => {
        const e = err as NodeJS.ErrnoException;
        assert.equal(e.code, original!.code, "the original fs error propagates, not the cleanup one");
        assert.notEqual(e.message, "cleanup unavailable");
        return true;
      },
      "a failing temp cleanup must not mask the write failure",
    );
  } finally {
    t.mock.restoreAll();
  }
});

test("the extension registers no tool when TUMWATER_NOTES_PATH is unset", () => {
  const registered: RegisteredTool[] = [];
  const api = { registerTool: (tool: RegisteredTool) => registered.push(tool) };
  withNotesEnv(undefined, () => {
    roleNotesExtension(api as unknown as Parameters<typeof roleNotesExtension>[0]);
  });
  assert.equal(registered.length, 0, "no notebook path means the tool never registers");
});

test("the registered tool names role_notes and carries a text parameter schema", () => {
  const dir = tmpdir();
  const notes = path.join(dir, "notes.md");
  withNotesEnv(notes, () => {
    const tool = registerTool();
    assert.equal(tool.name, "role_notes");
    assert.equal((tool.parameters as { properties: { text: unknown } }).properties.text !== undefined, true);
  });
});

test("executing role_notes replaces the note and rejects an oversized one without writing", async () => {
  const dir = tmpdir();
  const notes = path.join(dir, "feature.md");
  const prev = process.env.TUMWATER_NOTES_PATH;
  process.env.TUMWATER_NOTES_PATH = notes;
  try {
    const tool = registerTool();
    const saved = await tool.execute("call-1", { text: "where things live" });
    assert.match(saved.content[0]!.text, /notebook saved/);
    assert.equal(fs.readFileSync(notes, "utf8"), "where things live");

    await assert.rejects(
      async () => tool.execute("call-2", { text: "a".repeat(ROLE_NOTES_MAX_BYTES + 1) }),
      /limit is 4096 bytes/,
    );
    assert.equal(fs.readFileSync(notes, "utf8"), "where things live", "the rejected note leaves the old one intact");

    // A malformed call must not be read as "clear the notebook": reject it and keep the note.
    await assert.rejects(
      async () => tool.execute("call-bad", { text: 123 }),
      /requires a string "text" \(got 123\)/,
    );
    assert.equal(fs.readFileSync(notes, "utf8"), "where things live", "a malformed call leaves the old one intact");

    const cleared = await tool.execute("call-3", { text: "" });
    assert.match(cleared.content[0]!.text, /notebook cleared/);
    assert.equal(fs.readFileSync(notes, "utf8"), "");
  } finally {
    if (prev === undefined) delete process.env.TUMWATER_NOTES_PATH;
    else process.env.TUMWATER_NOTES_PATH = prev;
  }
});

test("executing role_notes without a text argument rejects instead of clearing the note", async () => {
  // pi does not guarantee it enforced the tool's schema, so a call carrying no `text` at all
  // (no params object, or one without the field) must hit the same reject path as `{ text: 123 }`
  // rather than coercing to "" and wiping the continuity the notebook exists to keep.
  const dir = tmpdir();
  const notes = path.join(dir, "missing.md");
  const prev = process.env.TUMWATER_NOTES_PATH;
  process.env.TUMWATER_NOTES_PATH = notes;
  try {
    const tool = registerTool();
    writeRoleNote(notes, "keep me");
    for (const [id, params] of [
      ["call-no-params", undefined],
      ["call-empty-params", {}],
    ] as const) {
      await assert.rejects(
        async () => tool.execute(id, params as unknown as { text?: unknown }),
        /requires a string "text" — pass the full replacement note, or "" to clear it/,
        id,
      );
    }
    assert.equal(fs.readFileSync(notes, "utf8"), "keep me", "a missing-text call leaves the note intact");
  } finally {
    if (prev === undefined) delete process.env.TUMWATER_NOTES_PATH;
    else process.env.TUMWATER_NOTES_PATH = prev;
  }
});
