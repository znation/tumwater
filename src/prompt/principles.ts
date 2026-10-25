import path from "node:path";
import { readTextOrNull } from "../files/files.js";
import { truncateWithNote } from "../text/text.js";

/** Cap on the PRINCIPLES.md text injected into every prompt, so a runaway file cannot blow up
 * each run's prefill. */
export const PRINCIPLES_MAX_CHARS = 4000;

/** The project's design principles (PRINCIPLES.md), capped for injection into prompts. Empty
 * string when the file is missing or unreadable — prompt building must never throw on it.
 * (Extracted from prompt.ts, which now builds prompts on top of this reader; the truncation
 * marker format is truncateWithNote's in text.ts.) */
export function readPrinciples(root: string): string {
  const file = path.join(root, "PRINCIPLES.md");
  return truncateWithNote(readTextOrNull(file)?.trim() ?? "", PRINCIPLES_MAX_CHARS, "PRINCIPLES.md");
}

/** True when PRINCIPLES.md's trimmed text exceeds the prompt cap, so every run's <principles>
 * block carries only its head plus a truncation marker — the always-on amber twin of the doctor
 * `principles` row's over-cap warn, surfaced on `tumwater status`, the dashboard and the TUI
 * without a doctor run. Uses the doctor row's own predicate (raw.trim().length >
 * PRINCIPLES_MAX_CHARS), so the alert and the doctor row cannot disagree. Missing, unreadable
 * (the directory-in-place case readPrinciples degrades to "") and at-or-under-cap files are all
 * false. */
export function principlesBlockOverCap(root: string): boolean {
  const raw = readTextOrNull(path.join(root, "PRINCIPLES.md"));
  return raw !== null && raw.trim().length > PRINCIPLES_MAX_CHARS;
}
