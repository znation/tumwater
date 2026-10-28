/** The repo-readiness gate every repo-bound command runs before its body reads state: fail
 * fast on the first unmet precondition (startup-gates.ts's repoNotReady — the repo half of
 * `tumwater start`'s startup gate). One named home beside the argument gate (cli-flag-specs.ts):
 * the dispatcher (cli.ts), the marker commands (cli-marker-commands.ts), the write commands
 * (backlog/backlog-cli.ts), and the read-only command bodies (cli-query-commands.ts) all
 * import it, so a command layer never reaches into a sibling command module for a gate. */
import { fail } from "./cli-output.js";
import { teamWorkspaceMessage } from "../gates/readiness.js";
import { repoNotReady } from "../gates/startup-gates.js";
import { owningTeamRoot } from "../paths.js";

/** Fail (exit 1) on the first unmet repo precondition, naming the fix; return once the repo is
 * ready. */
export async function requireReadyRepo(root: string): Promise<void> {
  const notReady = await repoNotReady(root);
  if (notReady !== null) fail(notReady);
}

/** The workspace half of requireReadyRepo, for the commands that deliberately skip the
 * ready-repo gate: inside a team workspace, fail (exit 1) naming the owning team root. Outside
 * one it is a no-op, so those commands keep degrading to empty output in a plain directory. */
export function refuseTeamWorkspace(root: string): void {
  const owner = owningTeamRoot(root);
  if (owner !== undefined) fail(teamWorkspaceMessage(owner));
}
