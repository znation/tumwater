// vocabulary: plain
/** The repo preconditions' shared wording behind the readiness gate. startup-gate.ts answers
 * with the first unmet precondition (cmdStart and requireReadyRepo fail on it, the self-redeploy
 * refuses a swap on it) and doctor.ts reports each one individually, but every surface
 * describes the same problems — so the wording lives here once and cannot drift.
 * `GIT_MISSING_MESSAGE` (git/git-run.ts) is the sibling for a machine with no git binary; the
 * agent-binary preconditions (resolveBackendBin, findBackendBinary, piMissingMessage) live beside
 * the spawn in pi/pi-bin.ts. */
export const NOT_A_REPO_MESSAGE = "not a git repository (run `git init` first)";
export const NO_COMMITS_MESSAGE =
  "the repo has no commits yet; `tumwater init` creates the first one";
export const DETACHED_HEAD_MESSAGE =
  "your checkout is detached; check out your main branch first";
export const NOT_INITIALIZED_MESSAGE =
  "not initialized (run `tumwater init <prompt>` first — or a bare `tumwater init` when the project brief (TUMWATER.md or README.md) already carries the prompt)";

/** What a command run inside a team workspace (`<root>/.tumwater/worktrees/<slot>`) says in place
 * of NOT_INITIALIZED_MESSAGE: the workspace is no project of its own, the team root is. */
export function teamWorkspaceMessage(teamRoot: string): string {
  return `this is a tumwater workspace of the team at ${teamRoot}, not a project — run tumwater from ${teamRoot} (\`cd ${teamRoot}\`)`;
}
