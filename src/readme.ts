import fs from "node:fs";
import path from "node:path";

/** The managed sections of README.md: marker constants, the initial template a fresh
 * repo gets, and reading the project's initial prompt back out. */

export const PROMPT_START = "<!-- tumwater:prompt:start -->";
export const PROMPT_END = "<!-- tumwater:prompt:end -->";
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
  return text.slice(start + PROMPT_START.length, end).trim();
}
