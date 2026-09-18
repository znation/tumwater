/** The pre-flight messages behind the readiness gate. cli.ts's requireReadyRepo/cmdRun
 * fail fast on the first unmet precondition and doctor.ts reports each one individually, but
 * both surfaces describe the same problems — so the wording lives here once and cannot drift.
 * `GIT_MISSING_MESSAGE` (git.ts) is the sibling for a machine with no git binary. */
export const NOT_A_REPO_MESSAGE = "not a git repository (run `git init` first)";
export const NO_COMMITS_MESSAGE =
  "the repo has no commits yet; `tumwater init` creates the first one";
export const DETACHED_HEAD_MESSAGE =
  "the repo's primary checkout is detached; check out your main branch first";
export const NOT_INITIALIZED_MESSAGE = "not initialized (run `tumwater init <prompt>` first)";
export const PI_MISSING_MESSAGE =
  "pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH";
