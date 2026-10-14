/** The repo-readiness gate every repo-bound command runs before its body reads state: fail
 * fast on the first unmet precondition (startup-gate.ts's repoNotReady — the repo half of
 * `tumwater run`'s startup gate). One named home beside the argument gate (cli-flag-specs.ts):
 * the dispatcher (cli.ts), the marker commands (cli-marker-commands.ts), the write commands
 * (backlog/backlog-cli.ts), and the read-only command bodies (cli-query-commands.ts) all
 * import it, so a command layer never reaches into a sibling command module for a gate. */
import { fail } from "./cli-output.js";
import { repoNotReady } from "../gates/startup-gate.js";

/** Fail (exit 1) on the first unmet repo precondition, naming the fix; return once the repo is
 * ready. */
export async function requireReadyRepo(root: string): Promise<void> {
  const notReady = await repoNotReady(root);
  if (notReady !== null) fail(notReady);
}
