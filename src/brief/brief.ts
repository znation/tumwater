// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import { briefCandidates } from "../paths.js";
import { errorMessage, truncateWithNote } from "../text/text.js";

/** The managed sections of the project brief (TUMWATER.md, with README.md as the
 * compatibility path — plans/portability.md §7a/7): marker constants, the templates a fresh
 * repo gets, and reading the project's initial prompt back out. */

export const PROMPT_START = "<!-- tumwater:prompt:start -->";
export const PROMPT_END = "<!-- tumwater:prompt:end -->";

/** Cap on the initial prompt (see readInitialPrompt). The prompt is the project's reason to
 * exist and rides into EVERY tick and director prompt, so unbounded text would be a standing
 * per-tick prefill cost — the same budget customRoles.task and roles.<id>.instructions are
 * held to. `tumwater init` rejects an over-long prompt before it is committed (init.ts); this
 * constant is the shared bound so the read path and the init check cannot drift. */
export const INITIAL_PROMPT_MAX_CHARS = 4096;
// The status markers stay exported too: the readme role targets the resolved brief file, not
// a hardcoded README.md, and doctor's brief check reports which file holds the sections. The
// prompt markers above stay exported because init.ts names them in its error message.
export const STATUS_START = "<!-- tumwater:status:start -->";
export const STATUS_END = "<!-- tumwater:status:end -->";

/** The placeholder every fresh template seeds between the status markers. A brief still
 * carrying exactly this body (or an empty one) is "description incomplete"; once the readme
 * role replaces it with a real status the project's description is complete. Hoisted so the
 * template and the readme role's real-status replacement cannot drift on the wording. */
const EMPTY_STATUS = "_No status yet. The readme role keeps this section up to date._";

/** The two managed sections a fresh brief carries — the initial prompt in its prompt
 * markers, an empty status in its status markers — under the given H1. Both homes render
 * the identical body (README.md for a fresh repo, TUMWATER.md for an adopted one), so the
 * body lives here once and the two templates cannot drift on section wording or marker
 * placement; the H1 is the only difference between them. */
function managedSections(heading: string, initialPrompt: string): string {
  return `# ${heading}

## Brief

${PROMPT_START}
${initialPrompt.trim()}
${PROMPT_END}

## Status

${STATUS_START}
${EMPTY_STATUS}
${STATUS_END}
`;
}

/** The README.md a fresh repo starts with: the initial prompt and an empty status,
 * each in its managed section. */
export function readmeTemplate(projectName: string, initialPrompt: string): string {
  return managedSections(projectName, initialPrompt);
}

/** The TUMWATER.md an adopted repo gets (plans/portability.md §7a/7, written by 7b's adopt
 * path): the same two managed sections as the README template, under a brief heading —
 * so the resolution logic in this module is the only difference between the two homes. */
export function briefTemplate(projectName: string, initialPrompt: string): string {
  return managedSections(`${projectName} — project brief`, initialPrompt);
}

/** True when `text` carries a well-formed managed prompt block: opening marker, then a
 * closing one strictly after it (readInitialPrompt's ordering guard). */
function ownsBrief(text: string): boolean {
  const start = text.indexOf(PROMPT_START);
  if (start < 0) return false;
  return text.includes(PROMPT_END, start + PROMPT_START.length);
}

/** The first brief candidate (TUMWATER.md before README.md) that exists on disk and whose
 * text `accepts` — its basename and text, or null when none does. The one home of the
 * candidate-order scan (skip missing files, read the first present one) that readBrief runs
 * once for both the file name and the prompt; the `accepts` predicate is the seam for a
 * caller that wants a different ownership test.
 *
 * A candidate that exists but cannot be read (README.md created as a directory, a
 * permission-lost file) is an operator-visible break, not a silent skip: the brief is
 * every loop's reason to exist, read each tick, so falling through to the next candidate
 * could run the team on the wrong brief and throwing raw would crash every tick with an
 * errno that names neither the file nor the fix — the message below names both. */
function firstBriefText(
  root: string,
  accepts: (text: string) => boolean,
): { file: string; text: string } | null {
  for (const candidate of briefCandidates(root)) {
    if (!fs.existsSync(candidate)) continue;
    let text: string;
    try {
      text = fs.readFileSync(candidate, "utf8");
    } catch (err) {
      throw new Error(
        `cannot read the project brief ${JSON.stringify(path.basename(candidate))}: ${errorMessage(err)} — every role reads this file's brief on each run, so make it a readable file carrying the ${PROMPT_START}/${PROMPT_END} markers (or move it aside)`,
      );
    }
    if (accepts(text)) return { file: path.basename(candidate), text };
  }
  return null;
}

/** Which file owns the project's managed sections — the basename of the first candidate
 * that carries a well-formed prompt block, or null when none does. Callers that only need
 * the prompt use readInitialPrompt; this exists for the prompt builders (which name the
 * actual file) and doctor's brief check. */
export function briefFile(root: string): string | null {
  return readBrief(root)?.file ?? null;
}

/** The project's initial prompt, extracted from the resolved brief file's managed section —
 * TUMWATER.md when it exists with markers, else README.md (plans/portability.md §7a/7). The
 * closing marker is searched for only AFTER the opening one: an end marker mentioned in prose
 * before the real block (e.g. README docs explaining how to edit the prompt) must not make a
 * valid later block unreadable — every loop would then run without its project prompt, and
 * init's guard would reject re-init as if the section were missing. */
export function readInitialPrompt(root: string): string {
  return readBrief(root)?.prompt ?? "";
}

/** The full path of the file that owns the prompt block (the same candidate readBrief
 * resolves), or null when none does — so a writer edits the file every reader reads. */
export function briefPath(root: string): string | null {
  const found = firstBriefText(root, ownsBrief);
  return found ? path.join(root, found.file) : null;
}

/** `text` with the prompt block's content replaced by `prompt` (trimmed), every byte outside
 * the two markers kept; null when the text has no well-formed block. Finds the block by
 * extractPrompt's rule (first start marker, then the first end marker after it). */
export function replaceInitialPrompt(text: string, prompt: string): string | null {
  const start = text.indexOf(PROMPT_START);
  if (start < 0) return null;
  const bodyStart = start + PROMPT_START.length;
  const end = text.indexOf(PROMPT_END, bodyStart);
  if (end < 0) return null;
  return `${text.slice(0, bodyStart)}\n${prompt.trim()}\n${text.slice(end)}`;
}

/** The trimmed, untruncated text between the first start marker and the first end marker after
 * it; null when `text` has no well-formed block. */
export function promptBlockOf(text: string): string | null {
  const start = text.indexOf(PROMPT_START);
  if (start < 0) return null;
  const end = text.indexOf(PROMPT_END, start + PROMPT_START.length);
  if (end < 0) return null;
  return text.slice(start + PROMPT_START.length, end).trim();
}

function extractPrompt(text: string): string | null {
  const prompt = promptBlockOf(text);
  if (prompt === null) return null;
  // A hand-edited brief can carry an over-long prompt past init's length check. Truncate it
  // for every tick instead of injecting the whole thing (the same defensive cap readPrinciples
  // applies, through text.ts's truncateWithNote), with a visible note so the loss is not
  // silent. init rejects the normal path before it is committed, so this is the backstop.
  return truncateWithNote(prompt, INITIAL_PROMPT_MAX_CHARS, "brief");
}

/** The resolved brief as one value: the owning file's basename (briefFile) and its extracted
 * initial prompt (readInitialPrompt) from a SINGLE firstBriefText scan. Tick prompt assembly
 * asks for both on every tick, and briefFile + readInitialPrompt each re-ran the candidate
 * scan and re-read the file — two whole-file reads per tick for one file's worth of content.
 * readInitialPrompt and briefFile now derive from this, so there is one read path; null when
 * no candidate carries a well-formed prompt block (both derived values are then empty/null). */
export function readBrief(root: string): { file: string; prompt: string } | null {
  const found = firstBriefText(root, ownsBrief);
  return found ? { file: found.file, prompt: extractPrompt(found.text) ?? "" } : null;
}

/** The brief's plain-text form: its file name, then the initial prompt — what `tumwater brief`
 * prints and the TUI's Brief tab shows, so the two cannot drift. */
export function renderBrief(brief: { file: string; prompt: string }): string {
  return `${brief.file}\n${brief.prompt}`;
}
