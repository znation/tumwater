/** The repo preconditions' shared wording behind the readiness gate. startup-gate.ts answers
 * with the first unmet precondition (cmdRun and requireReadyRepo fail on it, the self-redeploy
 * refuses a swap on it) and doctor.ts reports each one individually, but every surface
 * describes the same problems — so the wording lives here once and cannot drift.
 * `GIT_MISSING_MESSAGE` (git/git-run.ts) is the sibling for a machine with no git binary; the
 * agent-binary preconditions (resolveAgentBin, findAgentBinary, piMissingMessage) live beside
 * the spawn in pi/pi-bin.ts. */
export const NOT_A_REPO_MESSAGE = "not a git repository (run `git init` first)";
export const NO_COMMITS_MESSAGE =
  "the repo has no commits yet; `tumwater init` creates the first one";
export const DETACHED_HEAD_MESSAGE =
  "the repo's primary checkout is detached; check out your main branch first";
export const NOT_INITIALIZED_MESSAGE =
  "not initialized (run `tumwater init <prompt>` first — or a bare `tumwater init` when the project brief (TUMWATER.md or README.md) already carries the prompt)";
