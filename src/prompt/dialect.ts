// vocabulary: plain
/**
 * The only backend-specific prompt text (plans/agent-backends.md "What the pi extensions did,
 * per backend"). Everything else in the prompts already speaks in shell commands and "tool
 * calls"; what differs between pi and claude is the name of the notebook tool and how each
 * backend's oversized tool output reaches the model, so those live behind a `PromptDialect`
 * that prompt.ts and prompt-followup.ts take as an optional argument.
 *
 * pi is the default dialect, and its text is byte-identical to the prompts before this module
 * existed: the pi dialect reuses the exact rule fragments, while claude's wording differs only
 * where its own tool surface does. Adding a backend means adding one dialect here, not editing
 * every prompt builder.
 */

export interface PromptDialect {
  /** The name of the notebook tool as the model must call it. */
  notesTool: string;
  /** The phrase naming the read tool's range parameters in the reading-budget rule. */
  readRange: string;
  /** The oversized-output rule's bullet body (the text after "- "). */
  oversizedOutput: string;
}

/** pi's dialect: the identity of the prompts before agent backends — its `role_notes` tool,
 * its `read` tool's `offset`/`limit`, and its bundled head+tail marker. */
export const PI_DIALECT: PromptDialect = {
  notesTool: "role_notes",
  readRange: "the read tool's offset/limit (or `sed -n 'A,Bp'`)",
  oversizedOutput: `Oversized tool results come back as head+tail around a marker that names the omitted amount
  and where the full output lives — follow the pointer (re-read with \`offset\`/\`limit\`, or open
  the full-output file path) instead of retrying the same read.`,
};

/** claude's dialect: the `role_notes` MCP server registers as `mcp__tumwater__role_notes`, the
 * Read tool takes `offset`/`limit`, and Claude Code truncates oversized Bash output and spills
 * large results to a file it names (so it needs no head+tail marker). */
export const CLAUDE_DIALECT: PromptDialect = {
  notesTool: "mcp__tumwater__role_notes",
  readRange: "the Read tool's offset/limit (or `sed -n 'A,Bp'`)",
  oversizedOutput: `Oversized tool results are truncated and saved to a file the tool names — read that file
  in ranges (the Read tool's offset/limit) instead of retrying the same read.`,
};

/** The dialect for an agent id; every backend but claude speaks pi's dialect (and an unknown
 * id falls back to pi because run-agent.ts routes an unregistered id to the pi backend). */
export function dialectFor(agent: string | undefined): PromptDialect {
  return agent === "claude" ? CLAUDE_DIALECT : PI_DIALECT;
}
