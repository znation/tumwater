import fs from "node:fs";
import path from "node:path";
import { readRegularTextOrNull } from "../files/files.js";
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

/** The notes directory's listing, keyed by the directory's own stat. A notes file appears,
 * vanishes, or is renamed only when a note is first written, cleared, or a role is added or
 * retired — asynchronous events the next poll's stat observes — so an unchanged directory
 * costs one stat per poll instead of re-readdir'ing it every second (the same stat-keyed
 * listing cache liveClaimRunnerIds keeps for the runner-state directory). A note's CONTENT
 * changing in place does not touch the directory's mtime/size (only the file's own stat),
 * so the entry set stays served while the per-file length cache below still sees the new
 * bytes; the atomic tmp+rename write path bumps the dir mtime transiently, which invalidates
 * the listing like any add/remove — both correct and cheap. Bounded inside cachedByStat. */
const notesDirListingCache = new Map<string, StatKeyedValue<string[]>>();

/** Every role whose notes file runs past the read bound, in descending-char order — the
 * single home of the role-notes over-cap walk, shared by the status snapshot's
 * `collectRoleNotesOverCap` and the doctor `role notes` row
 * (src/doctor/doctor-role-notes.ts's checkRoleNotes), so the alert and the doctor row cannot
 * disagree about which notes are over the bound. `readRoleNote` (src/run/run-prompt.ts) cuts
 * every notes file at ROLE_NOTES_MAX_BYTES *characters* on read, but every operator surface
 * reads the file whole — so a hand-edited or old-build note past the bound reaches that role's
 * run prompt as only its head plus a truncation marker while `tumwater status` looks green.
 * Returns null when the notes dir is missing or unreadable (the write path creates it on first
 * write), whose callers each map to their own "nothing recorded yet" reading. Never throws. */
export function readRoleNotesOverCap(root: string): RoleNoteOverCap[] | null {
  const notesDir = path.dirname(roleNotesPath(root, "role"));
  // The notes dir's listing from the stat-keyed cache: a fresh readdir only when a note file
  // was added, removed, or renamed (the same contract the queue and runner-state listings
  // keep), one stat otherwise. A missing or unreadable directory loads null — and, like every
  // cachedByStat caller, a dir that cannot be stat'd reads null too — so the "nothing recorded
  // yet" reading is preserved exactly (an existing EMPTY dir loads []).
  const entries = cachedByStat(
    notesDirListingCache,
    notesDir,
    notesDir,
    () => {
      try {
        return fs.readdirSync(notesDir);
      } catch {
        // Missing or unreadable notes dir: nothing recorded yet (the write path creates it).
        return null;
      }
    },
    (names) => [...names], // A copy: callers may treat the result as their own.
  );
  if (entries === null) return null;
  const over: RoleNoteOverCap[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(notesDir, name);
    const chars = cachedByStat(
      noteLengthCache,
      file,
      file,
      () => {
        const text = readRegularTextOrNull(file);
        return text === null ? null : text.length;
      },
      (n) => n,
    );
    if (chars === null) continue;
    if (chars > ROLE_NOTES_MAX_BYTES) over.push({ role: name.slice(0, -3), chars });
  }
  over.sort((a, b) => b.chars - a.chars);
  return over;
}

/** The role-notes slice of a status snapshot as a plain array for the dashboard payloads:
 * every over-cap note in descending-char order, or [] when the notes dir is missing (the same
 * "nothing recorded yet" degrade the doctor's checkRoleNotes treats as a pass). */
export function collectRoleNotesOverCap(root: string): RoleNoteOverCap[] {
  return readRoleNotesOverCap(root) ?? [];
}
