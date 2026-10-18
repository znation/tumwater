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
