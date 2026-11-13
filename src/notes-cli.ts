#!/usr/bin/env node
/** The `tumwater-notes` command — the second bin entry (dist/src/notes-cli.js), the one
 * carrier for writing a role's note on every backend (plans/notes-command.md "The
 * `tumwater-notes` command"). A run finds it on its PATH (src/agent/notes-shim.ts) and hands
 * it only the note `TUMWATER_NOTES_PATH` names — the path comes from the environment tumwater
 * set, never from an argument. It replaces the three legacy carriers (the pi extension, and
 * the MCP server for Claude Code and OpenCode), validating and writing through the same
 * validateRoleNote / writeRoleNote as those, so the 4 KB cap and atomic write cannot drift.
 *
 * Subcommands:
 *   write            replace the note with stdin (refuses empty input)
 *   write --file <p> replace the note with the file at <p>
 *   show             print the lessons, then the note (nothing when there is none)
 *   clear            empty the note
 *   lesson add       read one lesson from stdin and store it, printing its id
 *   lesson replace <id>  replace a lesson's text from stdin (keeps the id, takes today)
 *   lesson retire <id>   drop it from the store
 *   lesson list      print the stored entries (nothing when there are none)
 *
 * The lessons file is the note's typed twin (plans/typed-role-notes.md): the durable lessons
 * a role keeps verbatim, in `<dirname(TUMWATER_NOTES_PATH)>/lessons/<basename>`. The path is
 * derived from the note's, never taken from an argument, so a run can only ever touch its own
 * store. `write` and `clear` touch only the note; `show` prints the lessons, then the note.
 *
 * Exits 0 on success, 1 on a refusal (empty input, over-cap note or lesson, a lessons store
 * that is full or over its byte cap, an unknown lesson id, or a note/lessons file that cannot
 * be written or read, or no TUMWATER_NOTES_PATH), and 2 with usage for an unknown subcommand
 * (a known subcommand with bad arguments refuses with usage and exit 1). */

import fs from "node:fs";
import path from "node:path";
import { readTextIfExists } from "./files/files.js";
import { formatDate } from "./text/datetime.js";
import { errorMessage, stripTerminalControls } from "./text/text.js";
import {
  validateRoleNote,
  writeRoleNote,
  readRoleLessons,
  parseRoleLessonsText,
  addRoleLesson,
  replaceRoleLesson,
  retireRoleLesson,
  type RoleLesson,
} from "./roles/role-notes-write.js";

/** The note's path, read ONLY from the environment — never from an argument. */
const NOTES_PATH = process.env.TUMWATER_NOTES_PATH;

/** The lessons file beside the note: `<dirname(note)>/lessons/<basename>`. Derived, never an
 * argument (plans/typed-role-notes.md "Commands"). */
function lessonsPath(notesPath: string): string {
  return path.join(path.dirname(notesPath), "lessons", path.basename(notesPath));
}

const USAGE = [
  "usage: tumwater-notes <write [--file <path>] | show | clear | lesson add | lesson replace <id> | lesson retire <id> | lesson list>",
  "  write replaces the note with stdin, clear empties it, show prints the lessons then the note (--file reads <path> instead of stdin)",
  "  lesson add | replace <id> | retire <id> | list manage the role's lessons file beside the note",
  "  the note and its lessons are the files TUMWATER_NOTES_PATH names (the lessons file sits in a lessons/ subdirectory)",
].join("\n");

/** Read the child's stdin to EOF as UTF-8. */
function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

/** Read the note's current text; a missing note reads as empty (show prints nothing). Any
 * other read failure (EACCES, EISDIR) throws, so it is never mistaken for an empty note. */
function readNote(): string {
  return readTextIfExists(NOTES_PATH!) ?? "";
}

/** Read the lessons' current text; a missing or empty store reads as the empty string (show
 * prints no lessons section). Any other read failure throws, like readNote. */
function readLessonsText(): string {
  const text = readTextIfExists(lessonsPath(NOTES_PATH!));
  if (text === null) return "";
  const store = parseRoleLessonsText(text);
  // The next-id marker is internal bookkeeping, not a lesson: render only the lesson lines,
  // each on its own line. An empty store renders nothing, so show prints no lessons section.
  return store.lessons.map((l) => `- ${l.id} (${l.date}): ${l.text}`).join("\n") + (store.lessons.length ? "\n" : "");
}

/** Print a lessons store's text as the show's lessons section: each lesson's line verbatim.
 * The lessons are model-authored, so the text is stripped of terminal controls at this display
 * boundary, exactly as the note is, so a prompt-injected lesson cannot drive the terminal. */
function writeLessonsSection(text: string): void {
  if (text === "") return;
  process.stdout.write(stripTerminalControls(text));
  // The stored text already ends in a newline; add one blank line to separate the lessons
  // section from the note that follows.
  process.stdout.write("\n");
}

/** Refuse with `message` on stderr and exit 1 — the exit code for every expected refusal. */
function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

/** Write a non-empty note and announce it; assumes NOTES_PATH is set. Returns the exit code. */
function writeNote(text: string): number {
  if (text === "") {
    return refuse("nothing to write — use `tumwater-notes clear` to empty the note");
  }
  const error = validateRoleNote(text);
  if (error) return refuse(error);
  try {
    writeRoleNote(NOTES_PATH!, text);
  } catch (err) {
    return refuse(`could not save the note: ${errorMessage(err)}`);
  }
  process.stdout.write(`notes saved (${Buffer.byteLength(text, "utf8")} bytes)\n`);
  return 0;
}

function cmdWrite(args: string[]): number {
  const [, flag, flagArg] = args;
  if (flag === undefined) return writeNote(readStdin());
  if (flag === "--file") {
    if (flagArg === undefined || args.length > 3) return refuse(USAGE);
    let text: string;
    try {
      text = fs.readFileSync(flagArg, "utf8");
    } catch (err) {
      return refuse(`cannot read ${JSON.stringify(flagArg)}: ${errorMessage(err)}`);
    }
    return writeNote(text);
  }
  return refuse(USAGE);
}

function cmdShow(flag: string | undefined): number {
  if (flag !== undefined) return refuse(USAGE);
  let lessons: string;
  try {
    lessons = readLessonsText();
  } catch (err) {
    return refuse(`could not read the lessons: ${errorMessage(err)}`);
  }
  let note: string;
  try {
    note = readNote();
  } catch (err) {
    return refuse(`could not read the note: ${errorMessage(err)}`);
  }
  // The lessons are model-authored text, so strip terminal controls at this display
  // boundary — the same treatment say()/fail()/the TUI frame give every untrusted
  // string, so a prompt-injected lesson with an ANSI escape (cursor move, title set,
  // OSC 52 clipboard write, carriage-return overwrite) cannot drive the operator's
  // terminal when they run `tumwater-notes show`.
  writeLessonsSection(lessons);
  // The note is model-authored text, so strip terminal controls at this display
  // boundary — the same treatment as the lessons above.
  process.stdout.write(stripTerminalControls(note));
  return 0;
}

function cmdClear(flag: string | undefined): number {
  if (flag !== undefined) return refuse(USAGE);
  try {
    writeRoleNote(NOTES_PATH!, "");
  } catch (err) {
    return refuse(`could not clear the note: ${errorMessage(err)}`);
  }
  process.stdout.write("notes cleared\n");
  return 0;
}

/** The `lesson` subcommands. `lesson <sub> <id?>`; `add` and `replace` read the lesson's text
 * from stdin. The lessons file is derived from the note's path, never an argument. */
function cmdLesson(args: string[]): number {
  const [, sub, id] = args;
  const lp = lessonsPath(NOTES_PATH!);
  const date = formatDate(new Date());
  if (sub === "add") {
    if (id !== undefined) return refuse(USAGE);
    const text = readStdin().trim();
    if (text === "") return refuse("nothing to add — pipe one lesson, or `tumwater-notes lesson list` to see the stored ones");
    let newId: string;
    try {
      newId = addRoleLesson(lp, text, date);
    } catch (err) {
      return refuse(errorMessage(err));
    }
    process.stdout.write(`${newId}\n`);
    return 0;
  }
  if (sub === "replace") {
    if (id === undefined || args.length > 3) return refuse(USAGE);
    const text = readStdin().trim();
    if (text === "") return refuse("nothing to replace — pipe the lesson's full replacement text");
    try {
      replaceRoleLesson(lp, id, text, date);
    } catch (err) {
      return refuse(errorMessage(err));
    }
    process.stdout.write(`${id} replaced\n`);
    return 0;
  }
  if (sub === "retire") {
    if (id === undefined || args.length > 3) return refuse(USAGE);
    try {
      retireRoleLesson(lp, id);
    } catch (err) {
      return refuse(errorMessage(err));
    }
    process.stdout.write(`${id} retired\n`);
    return 0;
  }
  if (sub === "list") {
    if (id !== undefined) return refuse(USAGE);
    let lessons: RoleLesson[];
    try {
      lessons = readRoleLessons(lp).lessons;
    } catch (err) {
      return refuse(`could not read the lessons: ${errorMessage(err)}`);
    }
    for (const l of lessons) {
      process.stdout.write(stripTerminalControls(`- ${l.id} (${l.date}): ${l.text}\n`));
    }
    return 0;
  }
  return refuse(USAGE);
}

function main(): number {
  if (NOTES_PATH === undefined || NOTES_PATH === "") {
    return refuse("this run keeps no notes");
  }

  const args = process.argv.slice(2);
  const [command, flag] = args;
  switch (command) {
    case "write":
      return cmdWrite(args);
    case "show":
      return cmdShow(flag);
    case "clear":
      return cmdClear(flag);
    case "lesson":
      return cmdLesson(args);
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

process.exit(main());
