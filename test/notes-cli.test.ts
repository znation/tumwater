/** The `tumwater-notes` command (plans/notes-command.md "The `tumwater-notes` command"),
 * run as a child process with a temp TUMWATER_NOTES_PATH: write/show/clear semantics, the
 * refusal of empty input and over-cap notes, the no-notes-path refusal, and unknown
 * subcommands. Runs only against the compiled bin — never a real model (see PRINCIPLES.md). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { withThrowingFs } from "./helpers/fs-faults.js";
import { ROLE_NOTES_MAX_BYTES, saveRoleNote, validateRoleNote, writeRoleNote } from "../src/agent/role-notes-write.js";

// From dist/test/ this is dist/src/notes-cli.js — the compiled file package.json's second bin.
const cli = fileURLToPath(new URL("../src/notes-cli.js", import.meta.url));

/** Run the command with `args` and an env whose TUMWATER_NOTES_PATH is `notesPath` (omitted
 * when null), feeding `input` on stdin. Returns the full spawn result. */
function run(
  args: string[],
  notesPath: string | null,
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  if (notesPath === null) delete env.TUMWATER_NOTES_PATH;
  else env.TUMWATER_NOTES_PATH = notesPath;
  const res = spawnSync(process.execPath, [cli, ...args], {
    input: input ?? "",
    env,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** The note file at `notesPath`, or undefined when absent. */
function noteText(notesPath: string): string | undefined {
  try {
    return fs.readFileSync(notesPath, "utf8");
  } catch {
    return undefined;
  }
}

test("tumwater-notes write saves stdin and prints its byte count; show prints it back", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  const body = "Rotation next: init.\nRuled out: nothing.\n";
  const wrote = run(["write"], notesPath, body);
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(wrote.stdout, `notes saved (${Buffer.byteLength(body, "utf8")} bytes)\n`);
  assert.equal(noteText(notesPath), body);

  const shown = run(["show"], notesPath);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, body);
});

test("tumwater-notes write --file saves the file's text", () => {
  const dir = tmpdir();
  const source = path.join(dir, "draft.txt");
  const notesPath = path.join(dir, "feature.md");
  const body = "from a file\n";
  fs.writeFileSync(source, body);
  const res = run(["write", "--file", source], notesPath);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(noteText(notesPath), body);
});

test("show prints nothing for a missing note", () => {
  const res = run(["show"], path.join(tmpdir(), "never-written.md"));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "");
});

test("tumwater-notes clear empties the note", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  run(["write"], notesPath, "something");
  const res = run(["clear"], notesPath);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "notes cleared\n");
  assert.equal(noteText(notesPath), "");
});

test("empty stdin exits 1 and leaves the old note in place", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  run(["write"], notesPath, "the old note");
  const res = run(["write"], notesPath, "");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /nothing to write/);
  assert.equal(noteText(notesPath), "the old note", "a wiped heredoc must not clear the note");
});

test("an over-cap note exits 1 and leaves the old note in place", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  run(["write"], notesPath, "old");
  const big = "x".repeat(4097);
  const res = run(["write"], notesPath, big);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /4097 bytes/);
  assert.equal(noteText(notesPath), "old");
});

test("write with a flag that is not --file exits 1 with usage", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  const res = run(["write", "--bogus", "x"], notesPath, "never read");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: tumwater-notes/);
  assert.equal(noteText(notesPath), undefined, "no note is touched");
});

test("write --file with no path exits 1 with usage", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  const res = run(["write", "--file"], notesPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: tumwater-notes/);
  assert.equal(noteText(notesPath), undefined, "no note is touched");
});

test("write --file with an unreadable path exits 1 naming the path", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  const missing = path.join(tmpdir(), "no-such-draft.txt");
  const res = run(["write", "--file", missing], notesPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`cannot read ${missing}`));
  assert.equal(noteText(notesPath), undefined, "no note is written");
});

test("no TUMWATER_NOTES_PATH exits 1 with 'this run keeps no notes'", () => {
  const res = run(["show"], null);
  assert.equal(res.status, 1);
  assert.equal(res.stderr.trim(), "this run keeps no notes");
});

test("an unknown subcommand exits 2 with usage", () => {
  const res = run(["frobnicate"], path.join(tmpdir(), "feature.md"));
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: tumwater-notes/);
});

// The shared validate-and-atomic-write helpers (src/agent/role-notes-write.ts) are the same
// code the command runs, so their pure contracts are pinned here beside the CLI tests.

test("validateRoleNote accepts the 4,096-byte boundary and rejects one byte past it", () => {
  assert.equal(validateRoleNote(""), null, "empty text is valid — it clears the note");
  assert.equal(validateRoleNote("a".repeat(ROLE_NOTES_MAX_BYTES)), null, "exactly at the limit");
  const error = validateRoleNote("a".repeat(ROLE_NOTES_MAX_BYTES + 1));
  assert.ok(error, "one byte past the limit is rejected");
  assert.match(error, /shorten it to at most 4096 bytes/);
});

test("validateRoleNote counts UTF-8 bytes, not characters", () => {
  // 2,048 characters of "é" are 4,096 bytes: valid. 2,049 are 4,098: rejected.
  assert.equal(validateRoleNote("é".repeat(2048)), null);
  assert.match(validateRoleNote("é".repeat(2049)) ?? "", /shorten it to at most 4096 bytes/);
});

test("saveRoleNote rejects a non-string note with a command-neutral message", () => {
  const dir = tmpdir();
  const notes = path.join(dir, "state", "notes", "feature.md");
  assert.throws(
    () => saveRoleNote(notes, 42),
    /a note must be a string, not number/,
    "a malformed value is refused rather than coerced to ''",
  );
  assert.equal(fs.existsSync(notes), false, "the refusal writes nothing");
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
    fs.readdirSync(notesDir).filter((f) => f.includes(".tmp-")),
    [],
    "a failed write leaves no temp remnant behind",
  );
});

test("writeRoleNote rethrows the original failure when the temp cleanup itself fails", () => {
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

  withThrowingFs("rmSync", new Error("cleanup unavailable"), () => {
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
  });
});
