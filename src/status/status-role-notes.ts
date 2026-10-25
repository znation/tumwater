import fs from "node:fs";
import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import { cachedByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { roleNotesPath } from "../paths.js";
import { ROLE_NOTES_MAX_BYTES } from "../agent/role-notes-write.js";

/** One role's notes file that the run prompt would truncate on read: the role's id and the
 * file's length in UTF-16 *characters* (the unit truncateWithNote cuts on, so this can never
 * disagree with the doctor `role notes` row — see below). */
export interface RoleNoteOverCap {
  role: string;
  chars: number;
}

/** The per-file lengths, keyed by absolute path. One stat per unchanged file per poll (the
 * same stat-keyed contract status-inbox.ts relies on for the inbox's prompt cache), so the
 * dashboards' once-a-second poll never re-reads an unchanged notes file. */
const noteLengthCache = new Map<string, StatKeyedValue<number>>();

/** The role-notes slice of a status snapshot: every role whose notes file runs past the read
 * bound. `readRoleNote` (src/run/run-prompt.ts) cuts every notes file at ROLE_NOTES_MAX_BYTES
 * *characters* on read, but every operator surface reads the file whole — so a hand-edited or
 * old-build note past the bound reaches that role's run prompt as only its head plus a
 * truncation marker while `tumwater status` looks green. This is the standing twin of the
 * doctor `role notes` row's warn (src/doctor/doctor-role-notes.ts's checkRoleNotes): it reads
 * the same directory and shares the same length predicate (text.length > ROLE_NOTES_MAX_BYTES,
 * characters not bytes), so the alert and the doctor row cannot disagree. Sorted descending by
 * chars (the doctor row's order). Never throws: a missing or unreadable notes dir is the same
 * "nothing recorded yet" degrade checkRoleNotes returns as a pass. */
export function collectRoleNotesOverCap(root: string): RoleNoteOverCap[] {
  const notesDir = path.dirname(roleNotesPath(root, "role"));
  let entries: readonly string[];
  try {
    entries = fs.readdirSync(notesDir);
  } catch {
    // Missing or unreadable notes dir: nothing recorded yet (the write path creates it).
    return [];
  }
  const over: RoleNoteOverCap[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(notesDir, name);
    const chars = cachedByStat(
      noteLengthCache,
      file,
      file,
      () => {
        const text = readTextOrNull(file);
        return text === null ? null : text.length;
      },
      (n) => n,
    );
    if (chars === null) continue;
    if (chars > ROLE_NOTES_MAX_BYTES) over.push({ role: name.slice(0, -3), chars });
  }
  if (over.length === 0) return [];
  over.sort((a, b) => b.chars - a.chars);
  return over;
}
