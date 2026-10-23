/**
 * The one write path for a role's notes, shared by every surface that touches it: the
 * `tumwater-notes` command (src/notes-cli.ts), `tumwater role --notes-file` /
 * `--clear-notes` (cli-role-command.ts), the dashboard drawer (gui-operator-commands.ts)
 * and the TUI editors (tui-editor-notes.ts, tui-pane-transcript.ts). Kept backend-neutral —
 * no pi, claude or opencode types — so every surface quotes the SAME 4 KB cap, the SAME
 * validation, and the SAME validate-then-atomic-write execution, and cannot drift on what
 * a valid note is or what a rejected write does.
 */

import { writeTextAtomic } from "../files/files.js";
import { gotSuffix } from "../text/text.js";

/** The cap on a role's note, in UTF-8 bytes. Small enough to cost little on every turn, large
 * enough for the codebase facts a role wants to keep. */
export const ROLE_NOTES_MAX_BYTES = 4096;

/** Validate note text against the byte cap. Returns null when the text is acceptable, or an
 * error naming the byte count and the fix — the same "shorten it to at most" wording
 * text/text.ts's tooLongMessage gives every other bounded text, so the model that overran
 * learns what to do, not just what went wrong. Pure, so the boundary is testable without pi. */
export function validateRoleNote(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > ROLE_NOTES_MAX_BYTES) {
    return `note is ${bytes} bytes — shorten it to at most ${ROLE_NOTES_MAX_BYTES} bytes`;
  }
  return null;
}

/** Replace the note file at `notesPath` with `text` through src/files/files.ts's
 * writeTextAtomic — the one home of the parent-dir creation, tmp+rename, and
 * no-remnant-on-failure contract, so a role's notes cannot litter `.tumwater/state/notes/`
 * with a temp file that nothing prunes. Callers validate first; this does not. */
export function writeRoleNote(notesPath: string, text: string): void {
  writeTextAtomic(notesPath, text);
}

/** Validate and write one note's text, returning the success message surfaces show. `text` is
 * `unknown` because a caller may hand it a malformed value (a malformed heredoc, a stray
 * argument) without having enforced the string contract: coercing a malformed `text` to ""
 * would clear the notes, the destructive reading of a typo the writer never sees, so a bad
 * value throws instead and the caller renders it as an error. Shared so every surface
 * rejects the same inputs with the same wording and the same no-write-on-failure behavior. */
export function saveRoleNote(notesPath: string, text: unknown): string {
  if (typeof text !== "string") {
    throw new Error(
      `a note must be a string, not ${typeof text}${gotSuffix(text)} — pass the full replacement note, or "" to clear it`,
    );
  }
  const error = validateRoleNote(text);
  if (error) throw new Error(error);
  writeRoleNote(notesPath, text);
  return text === "" ? "notes cleared" : `notes saved (${Buffer.byteLength(text, "utf8")} bytes)`;
}
