/** Building the environment for one claude run (plans/agent-backends.md "The claude
 * invocation", "Findings" 2 and 4) — pure scrub-and-set over a base environment, with no
 * subprocess. The caller layers the run-marker, the macOS LaunchServices preload, and the
 * notebook on first (src/pi/pi-backend.ts's `withNotesPath` shows the pi adapter doing the
 * same), then hands the result here.
 *
 * Inherited Claude Code session variables break auth: spawned from inside a Claude Code
 * session, a child that keeps `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*` or the host's
 * `ANTHROPIC_BASE_URL` reports "Not logged in" (finding 2). Everything the host session set is
 * scrubbed, except the operator-intent allowlist; `ANTHROPIC_BASE_URL` is dropped only when
 * `CLAUDECODE` was set, so an operator's own proxy still reaches a run started outside a
 * session.
 *
 * The set half disables auto-memory, backgrounded Bash tasks (finding 4: claude refuses a long
 * foreground command, backgrounds it, and abandons it when `-p` ends, which would report work
 * never verified), the auto-updater (a mid-fleet self-update must not swap the binary under a
 * run), telemetry, and error reporting; and raises the Bash timeouts so a slow suite runs in
 * the foreground. `BASH_MAX_TIMEOUT_MS` is derived from `quietTimeoutSeconds` so claude's own
 * Bash timeout fires before tumwater's quiet kill and the model sees a tool error rather than a
 * dead run. */

/** The cloud-provider switches that make a claude run bill as API rather than a claude.ai
 * subscription: Bedrock, Vertex, and Azure Foundry. They carry operator intent, so the run
 * environment keeps them (the allowlist below); claude-account's seedBilling and this module's
 * `claudeThirdPartyProvider` classify all three as API billing. */
const THIRD_PARTY_PROVIDER_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** True when `base` carries one of the third-party provider switches. seedBilling
 * (claude-account.ts) and the run's stream translator (claude-backend.ts) both answer billing
 * through this, so a provider run agrees with the account file about its own billing even when
 * claude's `system/init` omits a usable `apiKeySource`. */
export function claudeThirdPartyProvider(base: NodeJS.ProcessEnv): boolean {
  return THIRD_PARTY_PROVIDER_VARS.some((name) => base[name] !== undefined);
}

/** The host-session variables that carry operator intent rather than the session's state, so a
 * run inherits them: which cloud provider to authenticate through (Bedrock, Vertex, or Azure
 * Foundry), an OAuth token, and an output cap. Every other `CLAUDE_CODE_*` is the session's
 * own. The three provider switches must all survive together: seeds that classify billing
 * treat any of them as API, so a run that dropped one would disagree with the account file
 * about its own provider. */
const CLAUDE_CODE_ALLOWLIST = new Set<string>([
  ...THIRD_PARTY_PROVIDER_VARS,
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
]);

/** claude's default foreground Bash ceiling, matching the design's `BASH_DEFAULT_TIMEOUT_MS`
 * (finding 4: claude's own default is 2 min, too short for a real suite). */
const BASH_DEFAULT_TIMEOUT_MS = 600_000;

/** The floor for the derived `BASH_MAX_TIMEOUT_MS`. A positive `quietTimeoutSeconds` below 60
 * would derive a non-positive cap, which claude rejects (or reads as unlimited); clamp to one
 * second so a very short quiet window still hands claude a usable, positive ceiling. */
const MIN_BASH_MAX_TIMEOUT_MS = 1_000;

/** One run's claude isolation environment. `quietTimeoutSeconds` is the resolved config value;
 * 0 disables tumwater's quiet kill, and then no `BASH_MAX_TIMEOUT_MS` is set, leaving claude's
 * own ceiling. */
export interface ClaudeEnvOptions {
  quietTimeoutSeconds: number;
}

/** Build the claude process environment from `base`. Never mutates `base`. */
export function claudeEnv(base: NodeJS.ProcessEnv, opts: ClaudeEnvOptions): NodeJS.ProcessEnv {
  const hadClaudeCode = base.CLAUDECODE !== undefined;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT") continue;
    if (key.startsWith("CLAUDE_CODE_") && !CLAUDE_CODE_ALLOWLIST.has(key)) continue;
    if (key.startsWith("CLAUDE_AGENT_SDK_")) continue;
    // The host session's proxy, not the operator's: only when CLAUDECODE says we are inside one.
    if (key === "ANTHROPIC_BASE_URL" && hadClaudeCode) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  env.BASH_DEFAULT_TIMEOUT_MS = String(BASH_DEFAULT_TIMEOUT_MS);
  if (opts.quietTimeoutSeconds > 0) {
    // 60 s under the quiet kill, so claude's tool error arrives before the run is declared hung;
    // floored so a quiet window under 60 s never derives a non-positive cap.
    const derived = opts.quietTimeoutSeconds * 1000 - 60_000;
    env.BASH_MAX_TIMEOUT_MS = String(Math.max(derived, MIN_BASH_MAX_TIMEOUT_MS));
  }
  env.DISABLE_AUTOUPDATER = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  return env;
}
