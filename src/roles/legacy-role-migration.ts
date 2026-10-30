import fs from "node:fs";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { deleteRefIfAt, refSha } from "../git/git.js";
import { runGit } from "../git/git-run.js";
import { branchName, mergeRefName, rejectedRefName, reviewSessionDir, roleInboxDir, roleNotesPath, sessionDir, statePath } from "../paths.js";
import type { MigrationNotes } from "../orchestrator/startup-migrations.js";
import { errorMessage } from "../text/text.js";
import { LEGACY_ROLE_IDS } from "./legacy-role-ids.js";

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
    // writeJsonAtomic, not a plain writeFileSync like every other production state writer
    // (INV-AF4): the rewritten file is a role's runner state, and a tmp+rename keeps a crash
    // mid-write (or a concurrent reader) from ever seeing a torn file. A migration that dies
    // before the rename leaves the target at its pre-rewrite bytes — retried next startup —
    // never a truncated state file the runner would read as no state.
    writeJsonAtomic(file, rec);
  } catch {
    /* not a JSON state file — leave it alone */
  }
}

/** Move each retired role id's branch, refs and files to the new id (plans/terminology.md "Role
 * names"). Returns one line per artifact, sorted into moved, kept (both
 * ids exist) and failed. State files are the one exception to "kept": when both id-named copies
 * exist and the old-id copy carries the newer end-of-run stamp (`lastRunEndedAt`, or the
 * pre-rename `lastTickEndedAt` a frozen copy carries), that copy is folded over the stale
 * new-name one under the new name (the earlier migration renamed only the file list, not the
 * `role` field inside, so the runner kept writing the old-id name and the two copies drifted —
 * BUGS.md 2026-10-23); otherwise both are left in place. Nothing other than a state file that
 * exists under the new id is overwritten, each artifact fails alone, and pi and native logs stay
 * put as history. */
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
        // runGit, not gitTry: a failure here is reported verbatim into notes.failed, and gitTry
        // would swallow the cause (git's stderr and exit code), leaving a bare `update-ref ${to}
        // failed` with no reason to act on — the sibling branch move above propagates the same
        // GitError through runGit, so this stays in family.
        await runGit(root, ["update-ref", to, sha]);
        await deleteRefIfAt(root, from, sha);
        return `moved ${from} to ${to}`;
      });
    }

    // State files get a one-time heal, not "kept": when both id-named copies exist (a state
    // object the earlier migration renamed without rewriting `role`, so the runner kept saving
    // under the old-id name and the two files drifted), fold them into one — when the old-id copy
    // is the newer one, keep it under the new name and drop the stale new-name copy. A live copy
    // carries `lastRunEndedAt`; a frozen copy (never saved since the earlier rename) carries only
    // the pre-rename `lastTickEndedAt`, so the stamp reads either. When either copy is not a state
    // object (unreadable/torn, or a non-object), their stamps tie, or the new-name copy is the
    // newer one, keep both untouched, so the heal never fabricates or destroys a file it does not
    // understand.
    await attempt(`state ${statePath(root, oldId)}`, async () => {
      const from = statePath(root, oldId);
      const to = statePath(root, newId);
      if (!fs.existsSync(from)) return null;
      if (!fs.existsSync(to)) {
        fs.renameSync(from, to);
        rewriteStateRole(to, newId);
        return `moved ${from} to ${to}`;
      }
      const stamp = (p: string): number => {
        const j = readJsonFile<Record<string, unknown>>(p);
        if (typeof j?.lastRunEndedAt === "number") return j.lastRunEndedAt;
        return typeof j?.lastTickEndedAt === "number" ? j.lastTickEndedAt : -2; // retired-name-ok: legacy state field the frozen copy carries
      };
      const oldStamp = stamp(from);
      const newStamp = stamp(to);
      if (oldStamp < 0 || newStamp < 0 || oldStamp === newStamp) return `kept ${from} and ${to}: both exist`;
      if (oldStamp < newStamp) return `kept ${from} and ${to}: both exist`;
      // The old-id file holds the newer state (the live runner kept saving under the old name
      // after the earlier migration). Fold it into the new-name path atomically: renameSync
      // replaces the destination and removes the source in one step, so a crash between the two
      // cannot leave the new-name file torn over the still-present old copy (which would read as
      // -2 next time and wedge the heal in "kept").
      fs.renameSync(from, to);
      rewriteStateRole(to, newId);
      return `healed ${from} and ${to}: kept ${from}, newer`;
    });

    for (const pathFor of [roleNotesPath, roleInboxDir, sessionDir, reviewSessionDir]) {
      const from = pathFor(root, oldId);
      const to = pathFor(root, newId);
      await attempt(from, async () => {
        if (!fs.existsSync(from)) return null;
        if (fs.existsSync(to)) return `kept ${from} and ${to}: both exist`;
        fs.renameSync(from, to);
        return `moved ${from} to ${to}`;
      });
    }
  }
  return notes;
}
