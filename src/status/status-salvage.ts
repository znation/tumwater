import fs from "node:fs";
import path from "node:path";
import { salvageDir } from "../paths.js";

/** One operator-kept workspace patch: its file name, when it was saved (the file's mtime) and
 * its byte size — the fields `tumwater status --json`'s `salvagePatches` carries and the doctor
 * `salvage patches` row and the standing `salvage-patches` alert render. */
export interface SalvagePatch {
  file: string;
  savedAt: number;
  bytes: number;
}

/** Every operator-kept workspace patch under `salvageDir(root)`, oldest first — the single home
 * of the kept-patch walk, shared by the status snapshot's `salvagePatches` field and the doctor
 * `salvage patches` row (src/doctor/doctor-salvage.ts's checkSalvagePatches), so the alert and
 * the row cannot disagree about which patches are kept. Only regular `*.patch` files directly
 * under the salvage dir are kept-without-restore (src/git/slot-salvage.ts: a settled run's
 * discarded edits, a verification's scratch output); everything under `pending/<role>/` waits
 * for that role's next run (restoreSalvagedWork) and is deliberately out of scope. A missing or
 * unreadable directory, or an unreadable entry, yields no entry rather than throwing — the same
 * best-effort rule the other title-row readers use. Never throws. */
export function collectSalvagePatches(root: string): SalvagePatch[] {
  const dir = salvageDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const patches: SalvagePatch[] = [];
  for (const name of names) {
    if (!name.endsWith(".patch")) continue;
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    // Direct children only: a subdirectory (e.g. `pending`) is not a kept patch even when its
    // name ends in .patch, and a non-regular entry cannot be a patch.
    if (!st.isFile()) continue;
    patches.push({ file: name, savedAt: st.mtimeMs, bytes: st.size });
  }
  patches.sort((a, b) => a.savedAt - b.savedAt);
  return patches;
}
