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
import { tmpdir } from "./repo-fixtures.js";

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

    const cleared = await tool.execute("call-3", { text: "" });
    assert.match(cleared.content[0]!.text, /notebook cleared/);
    assert.equal(fs.readFileSync(notes, "utf8"), "");
  } finally {
    if (prev === undefined) delete process.env.TUMWATER_NOTES_PATH;
    else process.env.TUMWATER_NOTES_PATH = prev;
  }
});
