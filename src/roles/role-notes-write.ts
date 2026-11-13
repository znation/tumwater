/**
 * The one write path for a role's notes, shared by every surface that touches it: the
 * `tumwater-notes` command (src/notes-cli.ts), `tumwater role --notes-file` /
 * `--clear-notes` (cli-role-command.ts), the dashboard drawer (gui-operator-commands.ts)
 * and the TUI editors (tui-editor-notes.ts, tui-pane-transcript.ts). Kept backend-neutral —
 * no pi, claude or opencode types — so every surface quotes the SAME 4 KB cap, the SAME
 * validation, and the SAME validate-then-atomic-write execution, and cannot drift on what
 * a valid note is or what a rejected write does.
 */

import { readTextIfExists, writeTextAtomic } from "../files/files.js";
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

/** The cap on one role's lessons store: at most this many lessons, each at most this many
 * UTF-8 bytes, for at most this many bytes in the whole file. A full store refuses `add` and
 * names the curation commands, so the cap forces curation instead of silently dropping
 * lessons (plans/typed-role-notes.md "Lessons file"). */
export const ROLE_LESSONS_MAX_COUNT = 12;

/** The cap on one lesson's text, in UTF-8 bytes — one short paragraph. */
export const ROLE_LESSON_MAX_BYTES = 300;

/** The cap on the whole lessons file, in UTF-8 bytes. */
export const ROLE_LESSONS_MAX_BYTES = 2048;

/** The first line of a lessons file: `<!-- next: L<n> -->` holds the next id so ids increase
 * and are never reused, even after a retire. */
const NEXT_ID_RE = /^<!-- next: L(\d+) -->$/;

/** One stored lesson: its id, its date, and its text. */
export interface RoleLesson {
  id: string;
  date: string;
  text: string;
}

/** Parse a lessons file's text into its id, its next-id counter, and its lessons in file
 * order. A missing file is the empty store. A malformed file — a next-id line that is not
 * the first line, a line that is neither the next-id marker nor a `- L<n> (date): text` lesson,
 * or an out-of-sequence or duplicate id — throws, so a hand-corrupted store is surfaced rather
 * than silently dropped or renumbered. Pure, so the parse is testable without a file. */
export function parseRoleLessons(text: string): { nextId: number; lessons: RoleLesson[] } {
  const lines = text.split("\n");
  // A trailing newline leaves one empty tail line; the file is otherwise expected to end with a
  // newline, so drop exactly one trailing empty line (never interior blanks, which a lesson
  // paragraph must not contain).
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let nextId = 1;
  if (lines.length > 0) {
    const first = lines[0]!;
    const m = NEXT_ID_RE.exec(first);
    if (!m) {
      throw new Error(
        `lessons file must begin with a next-id marker like "<!-- next: L${nextId} -->" (got ${first.slice(0, 40)})`,
      );
    }
    nextId = Number(m[1]!);
  }
  const lessons: RoleLesson[] = [];
  let prev = 0;
  // File order: the next-id marker is line 0, then one lesson per line with strictly
  // increasing ids. Validating in file order surfaces a store whose ids descend or repeat, and
  // the lessons are kept in the order the file holds them (render re-emits that order).
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^- L(\d+) \((\d{4}-\d{2}-\d{2})\): (.*)$/.exec(line);
    if (!m) {
      throw new Error(
        `a lessons line must be "- L<n> (YYYY-MM-DD): text" (got ${line.slice(0, 40)})`,
      );
    }
    const idNum = Number(m[1]!);
    if (idNum <= prev) {
      throw new Error(`a lessons id is reused or out of order (L${idNum} follows L${prev})`);
    }
    prev = idNum;
    lessons.push({ id: `L${idNum}`, date: m[2]!, text: m[3]! });
  }
  if (nextId <= prev) {
    throw new Error(`a lessons file's next id (L${nextId}) is not past its highest id (L${prev})`);
  }
  return { nextId, lessons };
}

/** Serialize a lessons store to its file text: the next-id marker, then one line per lesson,
 * each ending in a newline. The inverse of parseRoleLessons. */
export function renderRoleLessons(nextId: number, lessons: RoleLesson[]): string {
  const lines = [`<!-- next: L${nextId} -->`];
  for (const l of lessons) lines.push(`- ${l.id} (${l.date}): ${l.text}`);
  return lines.join("\n") + "\n";
}

/** Validate one lesson's text against the per-lesson bounds: it must be non-empty, a single
 * paragraph (no line break), and at most ROLE_LESSON_MAX_BYTES. Returns null when it is
 * acceptable, or an error naming the overage and the fix — the same "at most" wording
 * validateRoleNote uses, so the model that overran learns what to do. The whole-file 2 KB
 * cap is checked separately against the rendered store, because it depends on the other
 * lessons, not on this one in isolation. */
export function validateRoleLesson(text: string): string | null {
  if (text.trim() === "") return `a lesson must not be empty — pass one lesson, or none`;
  if (text.includes("\n") || text.includes("\r")) {
    return `a lesson must be a single paragraph (no blank line) — it contains a line break`;
  }
  const lessonBytes = Buffer.byteLength(text, "utf8");
  if (lessonBytes > ROLE_LESSON_MAX_BYTES) {
    return `a lesson is ${lessonBytes} bytes — shorten it to at most ${ROLE_LESSON_MAX_BYTES} bytes`;
  }
  return null;
}

/** The whole-file byte bound as a refusal, naming the overage and the curation fix. */
function lessonsTooBig(bytes: number): string {
  return `the lessons file is ${bytes} bytes — shorten it to at most ${ROLE_LESSONS_MAX_BYTES} bytes (retire or replace one first)`;
}

/** The one write path for a role's lessons store, shared by every surface that touches it:
 * the `tumwater-notes lesson` commands (src/notes-cli.ts) and, later, the operator surfaces
 * (plans/typed-role-notes.md part 3/3). Like writeRoleNote, it writes through
 * src/files/files.ts's writeTextAtomic — the one home of the parent-dir creation, tmp+rename,
 * and no-remnant-on-failure contract — so the lessons dir cannot be littered with a temp file
 * nothing prunes. Callers validate first; this does not. */
export function writeRoleLessons(lessonsPath: string, nextId: number, lessons: RoleLesson[]): void {
  writeTextAtomic(lessonsPath, renderRoleLessons(nextId, lessons));
}

/** Read and parse a lessons file, or the empty store when it is missing. An unreadable or
 * malformed file throws, so a corrupted store is surfaced rather than read as empty: clearing
 * it from a mistaken read would lose every lesson. */
export function readRoleLessons(lessonsPath: string): { nextId: number; lessons: RoleLesson[] } {
  const text = readTextIfExists(lessonsPath);
  if (text === null) return { nextId: 1, lessons: [] };
  return parseRoleLessonsText(text);
}

/** Parse a lessons file's text, or the empty store for an empty string — the text sibling of
 * readRoleLessons, for callers that already hold the bytes. A malformed text throws, like
 * readRoleLessons. */
export function parseRoleLessonsText(text: string): { nextId: number; lessons: RoleLesson[] } {
  if (text === "") return { nextId: 1, lessons: [] };
  return parseRoleLessons(text);
}

/** Add one lesson with the store's next id, validated against the count and byte caps. The
 * file is rewritten atomically. Returns the new lesson's id. Throws with the cap or byte
 * wording on refusal; the file is left untouched. */
export function addRoleLesson(lessonsPath: string, text: string, date: string): string {
  const { nextId, lessons } = readRoleLessons(lessonsPath);
  if (lessons.length >= ROLE_LESSONS_MAX_COUNT) {
    throw new Error(`lessons full (${lessons.length}/${ROLE_LESSONS_MAX_COUNT}): retire or replace one first`);
  }
  const error = validateRoleLesson(text);
  if (error) throw new Error(error);
  const id = `L${nextId}`;
  const after = [...lessons, { id, date, text }];
  const rendered = renderRoleLessons(nextId + 1, after);
  if (Buffer.byteLength(rendered, "utf8") > ROLE_LESSONS_MAX_BYTES) {
    throw new Error(lessonsTooBig(Buffer.byteLength(rendered, "utf8")));
  }
  writeRoleLessons(lessonsPath, nextId + 1, after);
  return id;
}

/** Replace one lesson's text, keeping its id and taking `date` as its new date. Refuses an
 * unknown id. The file is rewritten atomically. */
export function replaceRoleLesson(lessonsPath: string, id: string, text: string, date: string): void {
  const { nextId, lessons } = readRoleLessons(lessonsPath);
  const i = lessons.findIndex((l) => l.id === id);
  if (i === -1) {
    throw new Error(`no lesson ${id} to replace — tumwater-notes lesson list shows the stored ids`);
  }
  const error = validateRoleLesson(text);
  if (error) throw new Error(error);
  const next = [...lessons];
  next[i] = { id, date, text };
  const rendered = renderRoleLessons(nextId, next);
  if (Buffer.byteLength(rendered, "utf8") > ROLE_LESSONS_MAX_BYTES) {
    throw new Error(lessonsTooBig(Buffer.byteLength(rendered, "utf8")));
  }
  writeRoleLessons(lessonsPath, nextId, next);
}

/** Empty a role's lessons store: every lesson is dropped, but the next-id counter is kept so
 * a later add takes a fresh id, never a retired one (the same id-never-reused rule retire
 * keeps). A missing file is already empty: this is a no-op that still writes the empty store,
 * so the caller can rely on "the file exists and is empty" afterwards. The file is rewritten
 * atomically. */
export function clearRoleLessons(lessonsPath: string): void {
  const { nextId } = readRoleLessons(lessonsPath);
  writeRoleLessons(lessonsPath, nextId, []);
}

/** Retire one lesson, dropping it. Its id is never reused: the next-id counter is untouched,
 * so a later add takes a fresh id, not the retired one's. */
export function retireRoleLesson(lessonsPath: string, id: string): void {
  const { nextId, lessons } = readRoleLessons(lessonsPath);
  if (!lessons.some((l) => l.id === id)) {
    throw new Error(`no lesson ${id} to retire — tumwater-notes lesson list shows the stored ids`);
  }
  writeRoleLessons(lessonsPath, nextId, lessons.filter((l) => l.id !== id));
}
