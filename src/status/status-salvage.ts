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

/** Read one kept patch's text verbatim, or null when it cannot be read — the reader half of
 * `tumwater salvage --show <n>` (src/cli/cli-salvage-command.ts). Reads only a file name
 * `collectSalvagePatches` already returned, so the name always lands directly under the
 * salvage dir and this never reaches `pending/<role>/` (whose patches wait for a role's next
 * run and are deliberately out of the operator's read scope). A missing file, or an unreadable
 * one, yields null rather than throwing — the same best-effort rule collectSalvagePatches
 * uses. Never throws. */
export function readSalvagePatch(root: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(salvageDir(root), file), "utf8");
  } catch {
    return null;
  }
}

/** One filtered salvage row: a kept patch carrying the position the unfiltered list gives it —
 * the shape `tumwater salvage --grep` keeps, each row's `position` still the whole-list one
 * so `--show <n>` keeps addressing the same patch the unfiltered list numbers. */
interface SalvagePatchRow extends SalvagePatch {
  position: number;
}

/** The kept patches with only the ones whose file name or patch text contains `pattern`
 * (case-insensitively), each kept row's `position` unchanged — the filter twin of
 * grepQuarantineRows for the salvage list, so an operator who remembers only a file a patch
 * touched, a role, or a phrase can narrow the list without shifting the numbers `--show`
 * acts on. Each patch's text is read through readSalvagePatch (a missing or unreadable patch
 * yields null text and can still match by name), reading never writes, throws or changes the
 * collected order, and the filter never throws — the same best-effort rules
 * collectSalvagePatches and readSalvagePatch use. */
export function grepSalvagePatches(
  root: string,
  patches: readonly SalvagePatch[],
  pattern: string,
): SalvagePatchRow[] {
  const needle = pattern.toLowerCase();
  const rows: SalvagePatchRow[] = [];
  patches.forEach((p, i) => {
    const text = readSalvagePatch(root, p.file);
    if (p.file.toLowerCase().includes(needle) || text?.toLowerCase().includes(needle)) {
      rows.push({ position: i + 1, file: p.file, savedAt: p.savedAt, bytes: p.bytes });
    }
  });
  return rows;
}
