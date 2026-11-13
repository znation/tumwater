import { readRoleLessonsOverCap, readRoleNotesOverCap } from "../status/status-role-notes.js";
import { ROLE_LESSONS_MAX_BYTES, ROLE_LESSONS_MAX_COUNT, ROLE_NOTES_MAX_BYTES } from "../roles/role-notes-write.js";
import { agree, plural } from "../text/phrases.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./doctor-outcome.js";

/** How many oversized notes the `role notes` row names before appending "and N more", the
 * cap the other multi-role observer rows (e.g. workspaces) use so a long tail does not drown
 * the report. */
const ROLE_NOTES_NAMED_CAP = 3;

/** The `role notes` check: whether any role's notes file would be truncated when read into
 * that role's run prompt, or any role's lessons file has grown past its store caps (role-
 * notes-write.ts: 12 lessons, 2 KB). `readRoleNote` (src/run/run-prompt.ts) cuts every notes
 * file at ROLE_NOTES_MAX_BYTES *characters* on read (truncateWithNote's text.length bound),
 * and the lessons store is read whole but the write path refuses to grow it past the caps, so
 * a hand edit or old build can leave either the operator sees but the role's own `add` will
 * now refuse. This row warns on both gaps without touching either file. The notes over-cap
 * walk is shared with the status snapshot's collectRoleNotesOverCap
 * (src/status/status-role-notes.ts), so the row and the status alert cannot disagree about
 * which notes are over the bound; null means the notes dir is missing or unreadable.
 * Read-only against .tumwater/, like every check. Never throws. */
export function checkRoleNotes(root: string): CheckOutcome {
  const over = readRoleNotesOverCap(root);
  const overLessons = readRoleLessonsOverCap(root);
  const hasNotes = over !== null;
  if (!hasNotes && overLessons.length === 0) {
    // Missing or unreadable notes dir and no lessons file: nothing recorded yet (the write
    // paths create them on first write).
    return okOutcome("no role notes recorded yet");
  }
  const noteCount = over?.length ?? 0;
  if (noteCount === 0 && overLessons.length === 0) {
    return okOutcome(`every role note is within the ${ROLE_NOTES_MAX_BYTES}-character read bound`);
  }
  const clauses: string[] = [];
  if (noteCount > 0) {
    const first = over!.
      slice(0, ROLE_NOTES_NAMED_CAP)
      .map((o) => `${o.role} (${o.chars})`)
      .join(", ");
    const more = noteCount > ROLE_NOTES_NAMED_CAP ? ` and ${noteCount - ROLE_NOTES_NAMED_CAP} more` : "";
    clauses.push(
      `${plural(noteCount, "note", "notes")} across ${plural(noteCount, "role", "roles")} ${agree(noteCount, "exceeds", "exceed")} the ${ROLE_NOTES_MAX_BYTES}-character read bound: ${first}${more} — each role's prompt shows only the truncated head, so rewrite the note under the cap (tumwater role <id> --notes-file <path> or the tumwater-notes shim)`,
    );
  }
  if (overLessons.length > 0) {
    const first = overLessons
      .slice(0, ROLE_NOTES_NAMED_CAP)
      .map((o) => `${o.role} (${o.lessons} lessons, ${o.bytes} bytes)`)
      .join(", ");
    const more = overLessons.length > ROLE_NOTES_NAMED_CAP ? ` and ${overLessons.length - ROLE_NOTES_NAMED_CAP} more` : "";
    clauses.push(
      `${plural(overLessons.length, "lessons file", "lessons files")} across ${plural(overLessons.length, "role", "roles")} ${agree(overLessons.length, "exceeds", "exceed")} the ${ROLE_LESSONS_MAX_COUNT}-lesson / ${ROLE_LESSONS_MAX_BYTES}-byte store caps: ${first}${more} — a role's own lesson add will now be refused until one is retired (tumwater role <id> --clear-lessons, or retire a lesson with tumwater-notes lesson retire)`,
    );
  }
  return warnOutcome(clauses.join("; "));
}
