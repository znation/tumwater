#!/usr/bin/env node
// vocabulary: plain
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
 *   show             print the note (nothing when there is none)
 *   clear            empty the note
 *
 * Exits 0 on success, 1 on a refusal (empty input, over-cap note, or no
 * TUMWATER_NOTES_PATH), and 2 with usage for anything else. */

import fs from "node:fs";
import { readTextOrNull } from "./files/files.js";
import { validateRoleNote, writeRoleNote } from "./agent/role-notes-write.js";

/** The note's path, read ONLY from the environment — never from an argument. */
const NOTES_PATH = process.env.TUMWATER_NOTES_PATH;

const USAGE = [
  "usage: tumwater-notes <write [--file <path>] | show | clear>",
  "  write replaces the note with stdin, clear empties it, show prints it (--file reads <path> instead of stdin)",
  "  the note is the file TUMWATER_NOTES_PATH names",
].join("\n");

/** Read the child's stdin to EOF as UTF-8. */
function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

/** Read the note's current text; a missing note reads as empty (show prints nothing). */
function readNote(): string {
  return readTextOrNull(NOTES_PATH!) ?? "";
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
  writeRoleNote(NOTES_PATH!, text);
  process.stdout.write(`notes saved (${Buffer.byteLength(text, "utf8")} bytes)\n`);
  return 0;
}

function main(): number {
  if (NOTES_PATH === undefined || NOTES_PATH === "") {
    return refuse("this run keeps no notes");
  }

  const args = process.argv.slice(2);
  const [command, flag, flagArg] = args;
  switch (command) {
    case "write":
      if (flag === undefined) return writeNote(readStdin());
      if (flag === "--file") {
        if (flagArg === undefined || args.length > 3) return refuse(USAGE);
        let text: string;
        try {
          text = fs.readFileSync(flagArg, "utf8");
        } catch {
          return refuse(`cannot read ${flagArg}`);
        }
        return writeNote(text);
      }
      return refuse(USAGE);
    case "show":
      if (flag !== undefined) return refuse(USAGE);
      process.stdout.write(readNote());
      return 0;
    case "clear":
      if (flag !== undefined) return refuse(USAGE);
      writeRoleNote(NOTES_PATH, "");
      process.stdout.write("notes cleared\n");
      return 0;
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

process.exit(main());
