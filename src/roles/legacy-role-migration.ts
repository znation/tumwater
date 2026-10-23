import fs from "node:fs";
import { deleteRefIfAt, refSha } from "../git/git.js";
import { gitTry, runGit } from "../git/git-run.js";
import { branchName, mergeRefName, rejectedRefName, reviewSessionDir, roleInboxDir, roleNotesPath, sessionDir, statePath } from "../paths.js";
import type { MigrationNotes } from "../orchestrator/startup-migrations.js";
import { errorMessage } from "../text/text.js";
import { LEGACY_ROLE_IDS } from "./legacy-role-ids.js";

/** Read the `lastRunEndedAt` stamp out of a JSON state file, or null when the file is not a
 * parseable state object (a hand edit, an older shape, or a non-JSON placeholder). Null means
 * "cannot compare". */
function stateLastRunEndedAt(file: string): number | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const v = (parsed as Record<string, unknown>).lastRunEndedAt;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Rewrite a JSON state file's `role` field to the id its file name now names; a non-JSON file
 * (or one without a `role` field) is left untouched. `role` is the one field that must match
 * the file name — saveRunnerState writes `statePath(root, state.role)` — so a file moved by
 * migration must not keep its old id inside or it would be saved back to the retired file. */
function rewriteStateRole(file: string, role: string): void {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const rec = parsed as Record<string, unknown>;
    if (rec.role === role) return;
    rec.role = role;
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  } catch {
    /* not a JSON state file — leave it alone */
  }
}

/** Move each retired role id's branch, refs and files to the new id (plans/terminology.md "Role
 * names"). Returns one line per artifact, sorted into moved, kept (both
 * ids exist) and failed. Each artifact fails alone. Nothing that exists under the new id is
 * overwritten except a state file whose old-id twin is newer by `lastRunEndedAt` (the stale-role
 * split this recorded bug caused) — that one is replaced with the newer copy. pi and native
 * logs stay put as history. */
export async function migrateLegacyRoleIds(root: string, legacy: Readonly<Record<string, string>> = LEGACY_ROLE_IDS): Promise<MigrationNotes> {
  const notes: MigrationNotes = { moved: [], kept: [], failed: [] };
  for (const [oldId, newId] of Object.entries(legacy)) {
    const attempt = async (what: string, move: () => Promise<string | null>) => {
      try {
        const note = await move();
        if (note === null) return;
        (note.startsWith("kept ") ? notes.kept : notes.moved).push(note);
      } catch (err) {
        notes.failed.push(`could not move ${what}: ${errorMessage(err)}`);
      }
    };

    await attempt("branch", async () => {
      const from = branchName(oldId);
      const to = branchName(newId);
      if ((await refSha(root, `refs/heads/${from}`)) === null) return null;
      if ((await refSha(root, `refs/heads/${to}`)) !== null) return `kept branch ${from} and ${to}: both exist`;
      await runGit(root, ["branch", "-m", from, to]);
      return `renamed branch ${from} to ${to}`;
    });

    for (const refFor of [mergeRefName, rejectedRefName]) {
      const from = refFor(oldId);
      const to = refFor(newId);
      await attempt(from, async () => {
        const sha = await refSha(root, from);
        if (sha === null) return null;
        if ((await refSha(root, to)) !== null) return `kept ${from} and ${to}: both exist`;
        if ((await gitTry(root, "update-ref", to, sha)) === null) throw new Error(`update-ref ${to} failed`);
        await deleteRefIfAt(root, from, sha);
        return `moved ${from} to ${to}`;
      });
    }

    for (const pathFor of [statePath, roleNotesPath, roleInboxDir, sessionDir, reviewSessionDir]) {
      const from = pathFor(root, oldId);
      const to = pathFor(root, newId);
      const isStateFile = pathFor === statePath;
      await attempt(from, async () => {
        if (!fs.existsSync(from)) return null;
        if (fs.existsSync(to)) {
          // Both ids hold a file (the stale-role split this bug caused). For the runner's state
          // file, heal by keeping the one with the newer lastRunEndedAt under the new id; for
          // every other artifact the new-id file wins unchanged.
          if (!isStateFile) return `kept ${from} and ${to}: both exist`;
          const oldLast = stateLastRunEndedAt(from);
          const newLast = stateLastRunEndedAt(to);
          if (oldLast === null || (newLast !== null && oldLast <= newLast)) {
            return `kept ${from} and ${to}: both exist`;
          }
          fs.renameSync(from, to); // overwrite the stale new-id copy with the newer old-id one
          rewriteStateRole(to, newId);
          return `moved ${from} to ${to}: both existed, kept the newer by lastRunEndedAt`;
        }
        fs.renameSync(from, to);
        if (isStateFile) rewriteStateRole(to, newId);
        return `moved ${from} to ${to}`;
      });
    }
  }
  return notes;
}
