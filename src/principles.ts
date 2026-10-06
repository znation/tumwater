import path from "node:path";
import { readTextOrNull } from "./files/files.js";
import { truncateWithNote } from "./text/text.js";

/** Cap on the PRINCIPLES.md text injected into every prompt, so a runaway file cannot blow up
 * each tick's prefill. */
export const PRINCIPLES_MAX_CHARS = 4000;

/** The project's design principles (PRINCIPLES.md), capped for injection into prompts. Empty
 * string when the file is missing or unreadable — prompt building must never throw on it.
 * (Extracted from prompt.ts, which now builds prompts on top of this reader; the truncation
 * marker format is truncateWithNote's in text.ts.) */
export function readPrinciples(root: string): string {
  const file = path.join(root, "PRINCIPLES.md");
  return truncateWithNote(readTextOrNull(file)?.trim() ?? "", PRINCIPLES_MAX_CHARS, "PRINCIPLES.md");
}