/** The `tumwater retire` CLI command body (cmdRetire), split out of
 * cli-operator-commands.ts (the team-control marker commands) so the one immediate-action
 * command does not share the marker-writing module: retire acts at once on the primary
 * checkout, unlike the seven control commands that write request markers the orchestrator
 * consumes. The collection, safety rails, and removal live in src/operator/operator-retire.ts;
 * this module resolves the target role and renders the preview or the committed inventory.
 * cli.ts reaches it through the same `await import()` seam every command body keeps behind,
 * and its CLI case already special-cases it as "not a marker command (it acts immediately)".
 */

import { fail, say, sayJson } from "./cli-output.js";
import { flagValue } from "./cli-args.js";
import { ROLE_VALUE_ERROR } from "./cli-flag-specs.js";
import { knownRoleIds, loadConfig } from "../config/config.js";
import { allRoleIds, unknownRoleMessage } from "../roles/roles.js";
import { errorMessage } from "../text/text.js";
import {
  artifactPhrase,
  hasRetirableLeftovers,
  previewRetire,
  retireRole,
} from "../operator/operator-retire.js";

/** The role id retire targets: a built-in or configured id as for the marker commands, or
 * else any well-formed id that still has a branch or merge ref (a role no config names). */
async function retireTargetRole(root: string, args: string[]): Promise<string> {
  const role = flagValue(args, "--role");
  if (role === null) fail("retire requires --role <id> (e.g. `--role feature`)");
  if (!role) fail(ROLE_VALUE_ERROR);
  if (allRoleIds().includes(role)) return role;
  let ids: string[];
  try {
    ids = knownRoleIds(loadConfig(root));
  } catch (err) {
    fail(errorMessage(err));
  }
  if (ids.includes(role) || (await hasRetirableLeftovers(root, role))) return role;
  fail(unknownRoleMessage(role, ids));
}

/** Render one line per artifact an inventory holds and one per skipped artifact — the same
 * wording both the `--dry-run` preview and the committed run go through, so the two cannot
 * drift on the removed / `nothing to remove` phrasing. `verb` distinguishes the preview's
 * `would remove` from the committed `removed`. The `nothing to remove for role` no-ops line
 * stays in the caller (only the committed run carries it). */
function sayRemoveInventory(removed: readonly string[], skipped: readonly string[], verb: string, role: string): void {
  for (const name of removed) say(`${verb} ${artifactPhrase(name, role)}`);
  for (const name of skipped) say(`nothing to remove: ${artifactPhrase(name, role)}`);
}

/** `tumwater retire --role <id> [--force] [--json]`: remove a disabled role's leftover worktree,
 * branch, merge ref, and paused-state marker. The collection, safety rails, and removal live in
 * src/operator/operator-retire.ts; this is the render layer — one line per removed
 * artifact, the skip lines that make a second run idempotent, or the `--json` payload. */
export async function cmdRetire(root: string, args: string[]): Promise<void> {
  // The config exists only to validate the id against built-ins plus user-defined roles, with
  // the leftover-branch gate for ids no config names; a missing --role fails before it is needed.
  const role = await retireTargetRole(root, args);
  const force = args.includes("--force");
  if (args.includes("--dry-run")) {
    const preview = await previewRetire(root, role);
    if (args.includes("--json")) {
      sayJson({
        role,
        dryRun: true,
        wouldRemove: preview.wouldRemove,
        skipped: preview.skipped,
        objections: preview.objections,
      });
      return;
    }
    sayRemoveInventory(preview.wouldRemove, preview.skipped, "would remove", role);
    for (const reason of preview.objections)
      say(force ? `--force overrides: ${reason}` : `would refuse: ${reason}`);
    say("dry run — nothing removed");
    return;
  }
  const result = await retireRole(root, role, { force });
  if (args.includes("--json")) {
    sayJson({ role, removed: result.removed, skipped: result.skipped });
    return;
  }
  sayRemoveInventory(result.removed, result.skipped, "removed", role);
  if (result.removed.length === 0 && result.skipped.length === 0)
    say(`nothing to remove for role ${role}`);
}
