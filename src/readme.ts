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

/** The project's initial prompt, extracted from README.md's managed section. */
export function readInitialPrompt(root: string): string {
  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) return "";
  const text = fs.readFileSync(readme, "utf8");
  const start = text.indexOf(PROMPT_START);
  const end = text.indexOf(PROMPT_END);
  if (start < 0 || end < 0 || end < start) return "";
  return text.slice(start + PROMPT_START.length, end).trim();
}
