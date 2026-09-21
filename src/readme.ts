import fs from "node:fs";
import path from "node:path";

/** The managed sections of README.md: marker constants, the initial template a fresh
 * repo gets, and reading the project's initial prompt back out. */

export const PROMPT_START = "<!-- tumwater:prompt:start -->";
export const PROMPT_END = "<!-- tumwater:prompt:end -->";

/** Cap on the initial prompt (see readInitialPrompt). The prompt is the project's reason to
 * exist and rides into EVERY tick and director prompt, so unbounded text would be a standing
 * per-tick prefill cost — the same budget customLoops.task and roles.<id>.instructions are
 * held to. `tumwater init` rejects an over-long prompt before it is committed (init.ts); this
 * constant is the shared bound so the read path and the init check cannot drift. */
export const INITIAL_PROMPT_MAX_CHARS = 4096;
// The status markers are module-private (only readmeTemplate uses them); the prompt
// markers above stay exported because init.ts names them in its error message.
const STATUS_START = "<!-- tumwater:status:start -->";
const STATUS_END = "<!-- tumwater:status:end -->";

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

/** The project's initial prompt, extracted from README.md's managed section. The closing
 * marker is searched for only AFTER the opening one: an end marker mentioned in prose before
 * the real block (e.g. README docs explaining how to edit the prompt) must not make a valid
 * later block unreadable — every loop would then run without its project prompt, and init's
 * guard would reject re-init as if the section were missing. */
export function readInitialPrompt(root: string): string {
  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) return "";
  const text = fs.readFileSync(readme, "utf8");
  const start = text.indexOf(PROMPT_START);
  if (start < 0) return "";
  const end = text.indexOf(PROMPT_END, start + PROMPT_START.length);
  if (end < 0) return "";
  const prompt = text.slice(start + PROMPT_START.length, end).trim();
  if (prompt.length <= INITIAL_PROMPT_MAX_CHARS) return prompt;
  // A hand-edited README can carry an over-long prompt past init's length check. Truncate it
  // for every tick instead of injecting the whole thing (the same defensive cap readPrinciples
  // applies), with a visible note so the loss is not silent. init rejects the normal path
  // before it is committed, so this is the backstop.
  return `${prompt.slice(0, INITIAL_PROMPT_MAX_CHARS)}\n…[initial prompt truncated at ${INITIAL_PROMPT_MAX_CHARS} chars]`;
}
