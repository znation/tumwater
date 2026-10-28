/** Building the environment for one codex run (plans/codex-backend.md "The invocation" §3,
 * findings 10, 13) — pure scrub-and-set over a base environment, with no subprocess. The caller
 * layers the run-marker, the macOS LaunchServices preload and the notes shim on first, then hands
 * the result here.
 *
 * Inherited state from a host Codex or Claude Code session breaks the team run: a Codex child
 * keeps every `CODEX_*` it was given (finding 13), and `--ignore-user-config` still reads a host
 * home whose `config.toml` a run writes into (finding 10). So every `CODEX_*`, the host Claude
 * session's `CLAUDECODE` / `CLAUDE_CODE_*`, and both API keys an operator might carry
 * (`OPENAI_API_KEY`, `CODEX_API_KEY`) are scrubbed — pi's OpenAI key must never switch Codex to
 * per-token billing behind tumwater's back (decision 5). Everything else survives, including the
 * run marker and the PATH that carries the notes shim.
 *
 * The set half points Codex at a home of the team's own (`CODEX_HOME`) when one is configured, so
 * team sessions and trust entries stay out of the operator's `~/.codex` (finding 10). Unset, runs
 * keep the operator's home. */
import { scrubEnv } from "../env-scrub.js";

export interface CodexEnvOptions {
  /** The expanded team config dir, set as `CODEX_HOME`. */
  home?: string;
}

/** Build the codex process environment from `base`. Never mutates `base`. */
export function codexEnv(base: NodeJS.ProcessEnv, opts: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  return scrubEnv(base, {
    keep: (key: string) =>
      key !== "CLAUDECODE" &&
      !key.startsWith("CODEX_") &&
      !key.startsWith("CLAUDE_CODE_") &&
      key !== "OPENAI_API_KEY" &&
      key !== "CODEX_API_KEY",
    then: (env: NodeJS.ProcessEnv) => {
      if (opts.home) env.CODEX_HOME = opts.home;
    },
  });
}
