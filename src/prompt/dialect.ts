/**
 * The only backend-specific prompt text (plans/agent-backends.md "What the pi extensions did,
 * per backend"). Everything else in the prompts already speaks in shell commands and "tool
 * calls"; what differs between pi and claude is the name of the notes tool and how each
 * backend's oversized tool output reaches the model, so those live behind a `PromptDialect`
 * that prompt.ts and prompt-followup.ts take as an optional argument.
 *
 * pi is the default dialect, and its text is byte-identical to the prompts before this module
 * existed: the pi dialect reuses the exact rule fragments, while claude's wording differs only
 * where its own tool surface does. Adding a backend means adding one dialect here, not editing
 * every prompt builder.
 */

export interface PromptDialect {
  /** The phrase naming the read tool's range parameters in the reading-budget rule. */
  readRange: string;
  /** The oversized-output rule's bullet body (the text after "- "). */
  oversizedOutput: string;
  /** Backend-specific shell/reasoning rules rendered right after the reading-budget rule's
   * oversized-output bullet (opencode's shell-timeout and foreground rules, §5). A backend
   * with none (pi, claude) keeps its prompts byte-identical. */
  backendRules?: string[];
}

/** pi's dialect: the identity of the prompts before agent backends — its `read` tool's
 * `offset`/`limit`, and its bundled head+tail marker. */
export const PI_DIALECT: PromptDialect = {
  readRange: "the read tool's offset/limit (or `sed -n 'A,Bp'`)",
  oversizedOutput: `Oversized tool results come back as head+tail around a marker that names the omitted amount
  and where the full output lives — follow the pointer (re-read with \`offset\`/\`limit\`, or open
  the full-output file path) instead of retrying the same read.`,
};

/** claude's dialect: the Read tool takes `offset`/`limit`, and Claude Code truncates
 * oversized Bash output and spills large results to a file it names (so it needs no head+tail
 * marker). */
export const CLAUDE_DIALECT: PromptDialect = {
  readRange: "the Read tool's offset/limit (or `sed -n 'A,Bp'`)",
  oversizedOutput: `Oversized tool results are truncated and saved to a file the tool names — read that file
  in ranges (the Read tool's offset/limit) instead of retrying the same read.`,
};

/** opencode's dialect (plans/opencode-backend.md §5): its read tool takes `offset`/`limit`,
 * its oversized shell output spills to a named file (finding 17), and two backend rules tell
 * the model how OpenCode's shell tool works: a 2-minute default timeout that `timeout`
 * overrides, and no `background` (a backgrounded command dies when the run ends, finding 18). */
export const OPENCODE_DIALECT: PromptDialect = {
  readRange: "the read tool's offset/limit (or `sed -n 'A,Bp'`)",
  oversizedOutput: `Oversized shell output keeps only its last lines, followed by a note naming the file with
  the full output — read that file in ranges (the read tool's offset/limit) instead of
  re-running the command.`,
  backendRules: [
    "Shell commands time out after 2 minutes unless you pass `timeout` in milliseconds; give the project's check a timeout that covers it (for example 900000).",
    "Run every shell command in the foreground: never set `background`, because a background command is killed when your run ends.",
  ],
};

/** The dialect table keyed by backend id: every backend but claude speaks pi's dialect (and
 * an unknown id falls back to pi because run-agent.ts routes an unregistered id to the pi
 * backend). Adding a backend means one row here, not another branch. */
const DIALECTS: Record<string, PromptDialect> = {
  pi: PI_DIALECT,
  claude: CLAUDE_DIALECT,
  opencode: OPENCODE_DIALECT,
};

/** The dialect for an agent id, read from the per-backend table. */
export function dialectFor(agent: string | undefined): PromptDialect {
  return DIALECTS[agent ?? "pi"] ?? PI_DIALECT;
}
