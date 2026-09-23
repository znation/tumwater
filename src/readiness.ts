/** The pre-flight messages behind the readiness gate. cli.ts's requireReadyRepo/cmdRun
 * fail fast on the first unmet precondition and doctor.ts reports each one individually, but
 * both surfaces describe the same problems — so the wording lives here once and cannot drift.
 * `GIT_MISSING_MESSAGE` (git.ts) is the sibling for a machine with no git binary. */
export const NOT_A_REPO_MESSAGE = "not a git repository (run `git init` first)";
export const NO_COMMITS_MESSAGE =
  "the repo has no commits yet; `tumwater init` creates the first one";
export const DETACHED_HEAD_MESSAGE =
  "the repo's primary checkout is detached; check out your main branch first";
export const NOT_INITIALIZED_MESSAGE =
  "not initialized (run `tumwater init <prompt>` first — or a bare `tumwater init` when README.md already carries the prompt)";
const PI_MISSING_MESSAGE =
  "pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH";

/** Where a resolved agent binary's value came from (plans/portability.md §5/7): the env
 * override, the config field, or the built-in default. Shared by resolveAgentBin (pi.ts)
 * and every message that names the resolution, so the wording cannot drift between the
 * surfaces that report it. */
type AgentBinSource = "env" | "config" | "default";

export interface ResolvedAgentBin {
  bin: string;
  source: AgentBinSource;
}

/** The operator-facing name of each source, as it appears in failure text and doctor's
 * report. Exported so pi.ts's spawn errors and doctor's checks quote the same string. */
export function agentBinSourceLabel(source: AgentBinSource): string {
  switch (source) {
    case "env":
      return "TUMWATER_PI_BIN";
    case "config":
      return "agentBin in tumwater.json";
    case "default":
      return "the PATH default";
  }
}

/** The missing-binary message for a resolved agent binary. The default source keeps
 * PI_MISSING_MESSAGE byte-identical (pinned by test/cli.test.ts and test/doctor.test.ts);
 * a configured source gains the resolved value and where it came from, so a wrong
 * `agentBin` never reads as "pi is not installed" — and keeps the install hint, since a
 * wrong path and a missing install share the remedy of putting a working pi in reach. */
export function piMissingMessage(resolved: ResolvedAgentBin): string {
  if (resolved.source === "default") return PI_MISSING_MESSAGE;
  const from = agentBinSourceLabel(resolved.source);
  return `pi not found — resolved "${resolved.bin}" from ${from} is not an executable — install it (https://github.com/badlogic/pi-mono) or point ${from} at a working pi binary`;
}
