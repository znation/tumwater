import fs from "node:fs";
import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import { roleNotesPath } from "../paths.js";
import { ROLE_NOTES_MAX_BYTES } from "../agent/role-notes-write.js";
import { plural } from "../text/phrases.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** How many oversized notes the `role notes` row names before appending "and N more", the
 * cap the other multi-role observer rows (e.g. workspaces) use so a long tail does not drown
 * the report. */
const ROLE_NOTES_NAMED_CAP = 3;

/** The `role notes` check: whether any role's notes file would be truncated when read into
 * that role's run prompt. `readRoleNote` (src/run/run-prompt.ts) cuts every notes file at
 * ROLE_NOTES_MAX_BYTES *characters* on read (truncateWithNote's text.length bound), but every
 * operator surface reads the file whole — so a hand edit or old build can leave a note the
 * operator sees and the role never does. This row warns on that gap without touching the file.
 * Read-only against .tumwater/, like every check. Never throws. */
export function checkRoleNotes(root: string): CheckOutcome {
  const notesDir = path.dirname(roleNotesPath(root, "role"));
  let entries: readonly string[];
  try {
    entries = fs.readdirSync(notesDir);
  } catch {
    // Missing or unreadable notes dir: nothing recorded yet (the write path creates it).
    return okOutcome("no role notes recorded yet");
  }
  // The bound is the read's own unit — truncateWithNote cuts on text.length (UTF-16
  // characters), not the write path's Buffer.byteLength, so compare characters too or a
  // multibyte note the prompt reads in full would false-positive; never statSync().size.
  const over: Array<{ role: string; chars: number }> = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const text = readTextOrNull(path.join(notesDir, name));
    if (text === null) continue;
    if (text.length > ROLE_NOTES_MAX_BYTES) over.push({ role: name.slice(0, -3), chars: text.length });
  }
  if (over.length === 0) {
    return okOutcome(`every role note is within the ${ROLE_NOTES_MAX_BYTES}-character read bound`);
  }
  over.sort((a, b) => b.chars - a.chars);
  const first = over
    .slice(0, ROLE_NOTES_NAMED_CAP)
    .map((o) => `${o.role} (${o.chars})`)
    .join(", ");
  const more = over.length > ROLE_NOTES_NAMED_CAP ? ` and ${over.length - ROLE_NOTES_NAMED_CAP} more` : "";
  return warnOutcome(
    `${plural(over.length, "note", "notes")} across ${plural(over.length, "role", "roles")} exceed the ${ROLE_NOTES_MAX_BYTES}-character read bound: ${first}${more} — each role's prompt shows only the truncated head, so rewrite the note under the cap (tumwater role <id> --notes-file <path> or the tumwater-notes shim)`,
  );
}
