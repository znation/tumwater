/** Building the environment for one opencode run (plans/opencode-backend.md "The invocation")
 * — pure scrub-and-set over a base environment, with no subprocess. The caller layers the
 * run-marker and the macOS preload on first (claude's adapter shows the pie pattern), then
 * hands the result here alongside the injected config and the session database path.
 *
 * Inherited OpenCode session variables are scrubbed (every `OPENCODE_*` except the operator's
 * `OPENCODE_API_KEY`, plus the bare `OPENCODE` and `AI_AGENT`): a run spawned from inside an
 * OpenCode session must not attach to that session's server, config or database, and `AI_AGENT`
 * must not leak so the shell tool sets its own (finding 16). The set half disables Claude Code
 * interop and its skills, auto-update and the file watcher, and isolates the run to its own
 * database and injected config.
 *
 * No shell-timeout variable exists in 2.0.32 (finding 16), so none is set; the dialect tells
 * the model to pass `timeout` for the check (§5). `XDG_CONFIG_HOME` and its siblings are NOT
 * set: OpenCode's shell-tool children inherit the environment, and pointing XDG at a private
 * dir would stop `git` reading `~/.config/git/config`, losing commits' author identity (§3). */

import { scrubEnv } from "../env-scrub.js";

/** One run's opencode isolation environment. */
export interface OpencodeEnvOptions {
  /** The session database file this run reads and writes (design §4). */
  dbPath: string;
  /** The injected config JSON string (opencode-config.ts), applied to the run. */
  configContent: string;
}

/** Build the opencode process environment from `base`. Never mutates `base`. */
export function opencodeEnv(base: NodeJS.ProcessEnv, opts: OpencodeEnvOptions): NodeJS.ProcessEnv {
  return scrubEnv(base, {
    // Everything an inherited OpenCode session set is scrubbed — server, config, database,
    // client and session id — except the operator's API key, which is operator intent and must
    // survive. `AI_AGENT` goes too, so the shell tool sets its own (finding 16).
    keep: (key: string) =>
      !(key === "OPENCODE" || (key.startsWith("OPENCODE_") && key !== "OPENCODE_API_KEY") || key === "AI_AGENT"),
    then: (env: NodeJS.ProcessEnv) => {
      env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
      env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
      env.OPENCODE_DISABLE_AUTOUPDATE = "1";
      env.OPENCODE_DISABLE_FILEWATCHER = "1";
      env.OPENCODE_DB = opts.dbPath;
      env.OPENCODE_CONFIG_CONTENT = opts.configContent;
    },
  });
}
