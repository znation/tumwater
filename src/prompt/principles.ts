import path from "node:path";
import { readRegularTextOrNull } from "../files/files.js";
import { cachedTextByStat, type StatKeyedValue } from "../files/stat-cache.js";
import { truncateWithNote } from "../text/text.js";

/** Cap on the PRINCIPLES.md text injected into every prompt, so a runaway file cannot blow up
 * each run's prefill. */
export const PRINCIPLES_MAX_CHARS = 4000;

/** The project's design principles (PRINCIPLES.md), capped for injection into prompts. Empty
 * string when the file is missing or unreadable — prompt building must never throw on it.
 * (Extracted from prompt.ts, which now builds prompts on top of this reader; the truncation
 * marker format is truncateWithNote's in text.ts.) A symlinked PRINCIPLES.md is read as empty
 * (readRegularTextOrNull never follows a symlink out of the worktree, INV-G3/G4's lstat
 * policy), so a hostile tree cannot inject an arbitrary host file into every run's prompt. */
export function readPrinciples(root: string): string {
  const file = path.join(root, "PRINCIPLES.md");
  return truncateWithNote(readRegularTextOrNull(file)?.trim() ?? "", PRINCIPLES_MAX_CHARS, "PRINCIPLES.md");
}

// Per-root stat cache (stat-cache.cachedTextByStat): the TUI and GUI call this predicate on
// every per-second snapshot() poll, but PRINCIPLES.md changes only on the rare
// director/steward edit, a fresh init, or a clone — so an unchanged file serves each poll
// from one stat instead of re-listating and re-reading it whole. Any write invalidates
// through the same dev/ino/mtime/size freshness check; keyed by root so distinct repos never
// collide. Bounded inside cachedTextByStat.
const principlesOverCapCache = new Map<string, StatKeyedValue<boolean>>();

/** True when PRINCIPLES.md's trimmed text exceeds the prompt cap, so every run's <principles>
 * block carries only its head plus a truncation marker — the always-on amber twin of the doctor
 * `principles` row's over-cap warn, surfaced on `tumwater status`, the dashboard and the TUI
 * without a doctor run. Uses the doctor row's own predicate (raw.trim().length >
 * PRINCIPLES_MAX_CHARS), so the alert and the doctor row cannot disagree. Missing, unreadable
 * (the directory-in-place case readPrinciples degrades to "") and at-or-under-cap files are all
 * false. The verdict is stat-cached per root (never per call) so the per-second snapshot polls
 * do not re-read a file that barely changes; readPrinciples stays uncached, since a run must
 * always see the file's current text. */
export function principlesBlockOverCap(root: string): boolean {
  const file = path.join(root, "PRINCIPLES.md");
  return (
    cachedTextByStat(
      principlesOverCapCache,
      file,
      file,
      (raw) => raw.trim().length > PRINCIPLES_MAX_CHARS,
      (overCap) => overCap,
    ) ?? false
  );
}
