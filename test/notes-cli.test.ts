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
import { ROLE_NOTES_MAX_BYTES, saveRoleNote, validateRoleNote, writeRoleNote } from "../src/roles/role-notes-write.js";

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

test("show strips terminal controls so a note cannot drive the operator's terminal", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  const hostile = "plain\x1b[2J\x1b]0;GOTCHA\x07\x1b[31mRED\x00";
  writeRoleNote(notesPath, hostile);
  const res = run(["show"], notesPath);
  assert.equal(res.status, 0, res.stderr);
  // The prose survives, and the bytes actually emitted to the terminal contain no C0/C1/DEL
  // control (ESC, BEL, NUL all stripped) — so a hostile note cannot drive the operator's
  // terminal when they run `tumwater-notes show`.
  assert.ok(res.stdout.includes("plain"));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/.test(res.stdout));
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

test("write --file with a stray trailing argument exits 1 with usage", () => {
  const dir = tmpdir();
  const source = path.join(dir, "draft.txt");
  const notesPath = path.join(dir, "feature.md");
  fs.writeFileSync(source, "from a file\n");
  const res = run(["write", "--file", source, "extra"], notesPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: tumwater-notes/);
  assert.equal(noteText(notesPath), undefined, "the stray arg must not write the note");
});

test("write --file with an unreadable path exits 1 naming the path", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  const missing = path.join(tmpdir(), "no such draft.txt");
  const res = run(["write", "--file", missing], notesPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`cannot read ${JSON.stringify(missing)}`));
  assert.equal(noteText(notesPath), undefined, "no note is written");
});

test("write --file of an empty or over-cap draft refuses like stdin and writes nothing", () => {
  const dir = tmpdir();
  const notesPath = path.join(dir, "feature.md");
  run(["write"], notesPath, "the old note");

  // An empty draft is refused through the file path exactly as empty stdin is, so pointing
  // --file at a wiped draft cannot silently clear the note.
  const emptyDraft = path.join(dir, "empty.txt");
  fs.writeFileSync(emptyDraft, "");
  const empty = run(["write", "--file", emptyDraft], notesPath);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /nothing to write/);
  assert.equal(noteText(notesPath), "the old note", "an empty draft must not clobber or clear the note");

  // An over-cap draft is refused through the file path with the same byte-count validation
  // message, not silently truncated or written.
  const bigDraft = path.join(dir, "big.txt");
  fs.writeFileSync(bigDraft, "x".repeat(ROLE_NOTES_MAX_BYTES + 1));
  const big = run(["write", "--file", bigDraft], notesPath);
  assert.equal(big.status, 1);
  assert.match(big.stderr, new RegExp(`${ROLE_NOTES_MAX_BYTES + 1} bytes`));
  assert.equal(noteText(notesPath), "the old note", "an over-cap draft must not be written");
});

test("no TUMWATER_NOTES_PATH exits 1 with 'this run keeps no notes'", () => {
  const res = run(["show"], null);
  assert.equal(res.status, 1);
  assert.equal(res.stderr.trim(), "this run keeps no notes");
});

test("an empty TUMWATER_NOTES_PATH exits 1 with 'this run keeps no notes'", () => {
  // The path is read only from the environment; an empty value means "no notes" just like a
  // missing one, so a shell exporting an empty TUMWATER_NOTES_PATH cannot make `write`/`show`
  // target the current directory (where an empty path names '' and fs would open the cwd).
  const res = run(["write"], "", "body");
  assert.equal(res.status, 1);
  assert.equal(res.stderr.trim(), "this run keeps no notes");
});

test("show with a stray argument exits 1 with usage and prints nothing", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  run(["write"], notesPath, "something");
  const res = run(["show", "--bogus"], notesPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: tumwater-notes/);
  assert.equal(res.stdout, "");
});

test("clear with a stray argument exits 1 with usage and leaves the note", () => {
  const notesPath = path.join(tmpdir(), "feature.md");
  run(["write"], notesPath, "something");
  const res = run(["clear", "extra"], notesPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: tumwater-notes/);
  assert.equal(noteText(notesPath), "something", "a stray arg must not clear the note");
});

test("an unknown subcommand exits 2 with usage", () => {
  const res = run(["frobnicate"], path.join(tmpdir(), "feature.md"));
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: tumwater-notes/);
});

// The shared validate-and-atomic-write helpers (src/roles/role-notes-write.ts) are the same
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
  // Nothing prunes .tumwater/state/notes/, so a leaked temp would survive every run.
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

/** A note path that is a directory, so writing it fails and reading it fails with EISDIR. */
function directoryNote(): string {
  const notes = path.join(tmpdir(), "notes", "feature.md");
  fs.mkdirSync(notes, { recursive: true });
  return notes;
}

function assertOneLineRefusal(res: ReturnType<typeof run>, prefix: string): void {
  assert.equal(res.status, 1);
  assert.ok(res.stderr.startsWith(prefix), res.stderr);
  assert.equal(res.stderr.split("\n").filter((l) => l.trim() !== "").length, 1, res.stderr);
  assert.ok(!res.stderr.includes("    at "), "no stack trace");
  assert.equal(res.stdout, "");
}

test("write to a note that cannot be written exits 1 with one 'could not save the note' line and no stack trace", () => {
  assertOneLineRefusal(run(["write"], directoryNote(), "hi"), "could not save the note: ");
});

test("clear on a note that cannot be written exits 1 with one 'could not clear the note' line", () => {
  assertOneLineRefusal(run(["clear"], directoryNote()), "could not clear the note: ");
});

test("show on a note that cannot be read exits 1 naming the failure instead of printing nothing", () => {
  const res = run(["show"], directoryNote());
  assert.equal(res.status, 1);
  assert.ok(res.stderr.startsWith("could not read the note: "), res.stderr);
  assert.equal(res.stdout, "");
});


/** The `lesson` subcommands (plans/typed-role-notes.md part 1/3), run against a temp role
 * notes file whose lessons sibling lives at <dirname>/lessons/<basename>. Expected file
 * contents are written literally from the lessons format contract, not by calling the code. */

/** A temp role notes path; its lessons file sits at the lessons/ sibling of the same basename. */
function lessonNotesPath(): { notesPath: string; lessonsPath: string } {
  const notesPath = path.join(tmpdir(), "feature.md");
  const lessonsPath = path.join(path.dirname(notesPath), "lessons", path.basename(notesPath));
  return { notesPath, lessonsPath };
}

function lessonsText(lessonsPath: string): string | undefined {
  try {
    return fs.readFileSync(lessonsPath, "utf8");
  } catch {
    return undefined;
  }
}

test("lesson add twice gives L1 then L2, writing the lessons file; the note file is left untouched", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  const a1 = run(["lesson", "add"], notesPath, "first lesson\n");
  assert.equal(a1.status, 0, a1.stderr);
  assert.equal(a1.stdout, "L1\n", "add prints the new id");
  const a2 = run(["lesson", "add"], notesPath, "second lesson\n");
  assert.equal(a2.status, 0, a2.stderr);
  assert.equal(a2.stdout, "L2\n");
  // The stored file: the next-id marker, then the two lessons in file order.
  const stored = lessonsText(lessonsPath)!;
  assert.equal(stored.split("\n")[0], "<!-- next: L3 -->");
  assert.match(stored, /- L1 \(\d{4}-\d{2}-\d{2}\): first lesson\n/, stored);
  assert.match(stored, /- L2 \(\d{4}-\d{2}-\d{2}\): second lesson\n/, stored);
  // add never writes the note file.
  assert.equal(noteText(notesPath), undefined, "add does not create or change the note");
});

test("lesson retire L1 then add gives L3, not L1 (a retired id is never reused)", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  run(["lesson", "add"], notesPath, "first\n"); // L1
  run(["lesson", "add"], notesPath, "second\n"); // L2
  const r = run(["lesson", "retire", "L1"], notesPath);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lessonsText(lessonsPath)!.split("\n")[0], "<!-- next: L3 -->", "retire advances the next id past the retired one");
  const a = run(["lesson", "add"], notesPath, "third\n");
  assert.equal(a.stdout, "L3\n", "the new id is L3, not the retired L1");
});

test("lesson replace keeps the id and takes today's date; the file is rewritten", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  run(["lesson", "add"], notesPath, "original\n"); // L1
  const res = run(["lesson", "replace", "L1"], notesPath, "amended\n");
  assert.equal(res.status, 0, res.stderr);
  const text = lessonsText(lessonsPath)!;
  assert.match(text, /- L1 \(\d{4}-\d{2}-\d{2}\): amended\n/, text);
  assert.equal(text.split("\n")[0], "<!-- next: L2 -->", "replace does not advance the next id");
});

test("lesson list prints the stored lessons in order; an empty store prints nothing", () => {
  const { notesPath } = lessonNotesPath();
  assert.equal(run(["lesson", "list"], notesPath).stdout, "", "an empty store prints nothing");
  run(["lesson", "add"], notesPath, "first\n");
  run(["lesson", "add"], notesPath, "second\n");
  const res = run(["lesson", "list"], notesPath);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /- L1 /);
  assert.match(res.stdout, /- L2 /);
  assert.ok(res.stdout.indexOf("L1") < res.stdout.indexOf("L2"), "file order");
});

test("show prints the lessons then the note, separated by a blank line", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  fs.mkdirSync(path.dirname(lessonsPath), { recursive: true });
  fs.writeFileSync(lessonsPath, "<!-- next: L2 -->\n- L1 (2026-11-13): a lesson\n");
  fs.writeFileSync(notesPath, "Note body.\n");
  const res = run(["show"], notesPath);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "- L1 (2026-11-13): a lesson\n\nNote body.\n");
});

test("a 13th lesson is refused with the count cap and the file is left unchanged", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  for (let n = 0; n < 12; n++) run(["lesson", "add"], notesPath, `lesson ${n}\n`);
  const before = lessonsText(lessonsPath)!;
  const res = run(["lesson", "add"], notesPath, "one more\n");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /lessons full \(12\/12\)/);
  assert.match(res.stderr, /retire or replace one first/);
  assert.equal(res.stdout, "");
  assert.equal(lessonsText(lessonsPath), before, "the file is untouched");
});

test("a lesson over 300 bytes or containing a blank line is refused with exit 1, file unchanged", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  const before = lessonsText(lessonsPath) ?? undefined;
  let res = run(["lesson", "add"], notesPath, "a".repeat(301) + "\n");
  assert.equal(res.status, 1, "over the per-lesson cap");
  assert.match(res.stderr, /shorten it to at most 300 bytes/);
  res = run(["lesson", "add"], notesPath, "line one\nline two\n");
  assert.equal(res.status, 1, "a blank line is not a single paragraph");
  assert.match(res.stderr, /single paragraph/);
  assert.equal(lessonsText(lessonsPath), before);
});

test("a lesson that would push the file past 2 KB is refused with the byte cap, file unchanged", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  for (let n = 0; n < 6; n++) run(["lesson", "add"], notesPath, "a".repeat(290) + "\n");
  const before = lessonsText(lessonsPath)!;
  assert.ok(Buffer.byteLength(before, "utf8") < 2048);
  const res = run(["lesson", "add"], notesPath, "a".repeat(290) + "\n");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /shorten it to at most 2048 bytes/);
  assert.equal(lessonsText(lessonsPath), before);
});

test("an unknown id to replace or retire is refused with exit 1 and the file unchanged", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  run(["lesson", "add"], notesPath, "only\n"); // L1
  const before = lessonsText(lessonsPath)!;
  let res = run(["lesson", "replace", "L9"], notesPath, "x\n");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no lesson L9 to replace/);
  res = run(["lesson", "retire", "L9"], notesPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no lesson L9 to retire/);
  assert.equal(lessonsText(lessonsPath), before);
});

test("write and clear leave the lessons file byte-identical", () => {
  const { notesPath, lessonsPath } = lessonNotesPath();
  run(["lesson", "add"], notesPath, "a lesson\n");
  const before = lessonsText(lessonsPath)!;
  assert.equal(run(["write"], notesPath, "the whole new note\n").status, 0);
  assert.equal(lessonsText(lessonsPath), before, "write does not touch lessons");
  assert.equal(run(["clear"], notesPath).status, 0);
  assert.equal(lessonsText(lessonsPath), before, "clear does not touch lessons");
});
