import fs from "node:fs";
import path from "node:path";
import { salvageDir } from "../paths.js";

/** One operator-kept workspace patch: its position (1-based, oldest first — the number the
 * doctor `salvage patches` row and `tumwater salvage` print, which `salvage --show <n>` and
 * `--drop <n>` address), its file name, when it was saved (the file's mtime) and its byte size
 * — the fields `tumwater status --json`'s `salvagePatches` carries and the doctor
 * `salvage patches` row and the standing `salvage-patches` alert render. */
export interface SalvagePatch {
  position: number;
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
    patches.push({ position: 0, file: name, savedAt: st.mtimeMs, bytes: st.size });
  }
  patches.sort((a, b) => a.savedAt - b.savedAt);
  // Number each patch with its spot in the sorted list — the number the doctor `salvage
  // patches` row and `tumwater salvage` print for it, so `tumwater status --json`'s rows carry
  // the same number a script passes to `salvage --show <n>` / `--drop <n>`.
  patches.forEach((p, i) => {
    p.position = i + 1;
  });
  return patches;
}

/** Resolve a 1-based `position` into a kept-patch list (collectSalvagePatches's output): the
 * patch at that position when it is in range, or the standard out-of-range refusal sentence
 * when it is below 1 or past the list. The single home of the position rule every salvage
 * surface applies — `tumwater salvage --show/--drop/--apply`, the TUI Health Ctrl+G apply and
 * Ctrl+Y drop arms, and the dashboard's /api/salvage-apply and /api/salvage-drop — so the
 * out-of-range wording and the 1-based indexing cannot drift between them. `patch` and
 * `message` are mutually exclusive: a caller tests `"message" in` the result, and a branch that
 * ends in a `never`-returning fail or a plain return narrows it to `patch`. The message names
 * the position typed and how many patches the list holds, exactly as those surfaces did when
 * each spelled the range check by hand. */
export function salvagePatchAt(
  patches: readonly SalvagePatch[],
  position: number,
): { patch: SalvagePatch; message?: never } | { patch?: never; message: string } {
  if (position < 1 || position > patches.length) {
    return { message: `no salvaged workspace patch at position ${position} (salvage holds ${patches.length} patches)` };
  }
  return { patch: patches[position - 1]! };
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


/** Delete one kept patch, returning whether it was removed — the destructive twin of
 * readSalvagePatch, backing `tumwater salvage --drop <n>` (src/cli/cli-salvage-command.ts)
 * so an operator can clear a reviewed or unwanted patch without `rm` under the salvage dir.
 * Reads only a file name `collectSalvagePatches` already returned, so the name always lands
 * directly under the salvage dir and this never reaches `pending/<role>/` (whose patches
 * wait for a role's next run and are deliberately out of the operator's delete scope). A
 * missing file, or one that cannot be removed, yields false rather than throwing — the same
 * best-effort rule collectSalvagePatches and readSalvagePatch use. Never throws. */
export function dropSalvagePatch(root: string, file: string): boolean {
  try {
    fs.unlinkSync(path.join(salvageDir(root), file));
    return true;
  } catch {
    return false;
  }
}


/** The kept patches with only the ones whose file name or patch text contains `pattern`
 * (case-insensitively), each kept row carrying the patch's own `position` from the
 * unfiltered list — the filter twin of grepQuarantineRows for the salvage list, so an
 * operator who remembers only a file a patch touched, a role, or a phrase can narrow the
 * list without shifting the numbers `--show` acts on. Each patch's text is read through
 * readSalvagePatch (a missing or unreadable patch yields null text and can still match by
 * name), reading never writes, throws or changes the collected order, and the filter never
 * throws — the same best-effort rules collectSalvagePatches and readSalvagePatch use. */
export function grepSalvagePatches(
  root: string,
  patches: readonly SalvagePatch[],
  pattern: string,
): SalvagePatch[] {
  const needle = pattern.toLowerCase();
  const rows: SalvagePatch[] = [];
  for (const p of patches) {
    const text = readSalvagePatch(root, p.file);
    if (p.file.toLowerCase().includes(needle) || text?.toLowerCase().includes(needle)) {
      rows.push({ ...p });
    }
  }
  return rows;
}
