import fs from "node:fs";
import path from "node:path";
import { briefCandidates } from "./paths.js";

/** The managed sections of the project brief (TUMWATER.md, with README.md as the
 * compatibility path — plans/portability.md §7a/7): marker constants, the templates a fresh
 * repo gets, and reading the project's initial prompt back out. */

export const PROMPT_START = "<!-- tumwater:prompt:start -->";
export const PROMPT_END = "<!-- tumwater:prompt:end -->";

/** Cap on the initial prompt (see readInitialPrompt). The prompt is the project's reason to
 * exist and rides into EVERY tick and director prompt, so unbounded text would be a standing
 * per-tick prefill cost — the same budget customLoops.task and roles.<id>.instructions are
 * held to. `tumwater init` rejects an over-long prompt before it is committed (init.ts); this
 * constant is the shared bound so the read path and the init check cannot drift. */
export const INITIAL_PROMPT_MAX_CHARS = 4096;
// The status markers stay exported too: the readme role targets the resolved brief file, not
// a hardcoded README.md, and doctor's brief check reports which file holds the sections. The
// prompt markers above stay exported because init.ts names them in its error message.
export const STATUS_START = "<!-- tumwater:status:start -->";
export const STATUS_END = "<!-- tumwater:status:end -->";

/** The README.md a fresh repo starts with: the initial prompt and an empty status,
 * each in its managed section. */
export function readmeTemplate(projectName: string, initialPrompt: string): string {
  return `# ${projectName}

## Initial prompt

${PROMPT_START}
${initialPrompt.trim()}
${PROMPT_END}

## Status

${STATUS_START}
_No status yet. The readme loop keeps this section up to date._
${STATUS_END}
`;
}

/** The TUMWATER.md an adopted repo gets (plans/portability.md §7a/7, written by 7b's adopt
 * path): the same two managed sections as the README template, under a brief heading —
 * so the resolution logic in this module is the only difference between the two homes. */
export function briefTemplate(projectName: string, initialPrompt: string): string {
  return `# ${projectName} — project brief

## Initial prompt

${PROMPT_START}
${initialPrompt.trim()}
${PROMPT_END}

## Status

${STATUS_START}
_No status yet. The readme loop keeps this section up to date._
${STATUS_END}
`;
}

/** True when `text` carries a well-formed managed prompt block: opening marker, then a
 * closing one strictly after it (readInitialPrompt's ordering guard). */
function ownsBrief(text: string): boolean {
  const start = text.indexOf(PROMPT_START);
  if (start < 0) return false;
  return text.indexOf(PROMPT_END, start + PROMPT_START.length) >= 0;
}

/** Which file owns the project's managed sections — the basename of the first candidate
 * (TUMWATER.md before README.md) that carries a well-formed prompt block, or null when
 * neither does. Callers that only need the prompt use readInitialPrompt; this exists for the
 * prompt builders (which name the actual file) and doctor's brief check. */
export function briefFile(root: string): string | null {
  for (const candidate of briefCandidates(root)) {
    if (!fs.existsSync(candidate)) continue;
    if (ownsBrief(fs.readFileSync(candidate, "utf8"))) return path.basename(candidate);
  }
  return null;
}

/** The project's initial prompt, extracted from the resolved brief file's managed section —
 * TUMWATER.md when it exists with markers, else README.md (plans/portability.md §7a/7). The
 * closing marker is searched for only AFTER the opening one: an end marker mentioned in prose
 * before the real block (e.g. README docs explaining how to edit the prompt) must not make a
 * valid later block unreadable — every loop would then run without its project prompt, and
 * init's guard would reject re-init as if the section were missing. */
export function readInitialPrompt(root: string): string {
  for (const candidate of briefCandidates(root)) {
    if (!fs.existsSync(candidate)) continue;
    const prompt = extractPrompt(fs.readFileSync(candidate, "utf8"));
    if (prompt !== null) return prompt;
  }
  return "";
}

function extractPrompt(text: string): string | null {
  const start = text.indexOf(PROMPT_START);
  if (start < 0) return null;
  const end = text.indexOf(PROMPT_END, start + PROMPT_START.length);
  if (end < 0) return null;
  const prompt = text.slice(start + PROMPT_START.length, end).trim();
  if (prompt.length <= INITIAL_PROMPT_MAX_CHARS) return prompt;
  // A hand-edited brief can carry an over-long prompt past init's length check. Truncate it
  // for every tick instead of injecting the whole thing (the same defensive cap readPrinciples
  // applies), with a visible note so the loss is not silent. init rejects the normal path
  // before it is committed, so this is the backstop.
  return `${prompt.slice(0, INITIAL_PROMPT_MAX_CHARS)}\n…[initial prompt truncated at ${INITIAL_PROMPT_MAX_CHARS} chars]`;
}
