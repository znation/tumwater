import fs from "node:fs";
import { deleteRefIfAt, refSha } from "../git/git.js";
import { gitTry, runGit } from "../git/git-run.js";
import { branchName, landingRefName, rejectedRefName, reviewSessionDir, roleInboxDir, roleNotesPath, sessionDir, statePath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { LEGACY_ROLE_IDS } from "./legacy-role-ids.js";

/** Move each retired role id's branch, refs and files to the new id (plans/terminology.md "Role
 * names"). Returns one line per artifact moved or skipped. Nothing that exists under the new id
 * is overwritten, each artifact fails alone, and pi and native logs stay put as history. */
export async function migrateLegacyRoleIds(root: string, legacy: Readonly<Record<string, string>> = LEGACY_ROLE_IDS): Promise<string[]> {
  const notes: string[] = [];
  for (const [oldId, newId] of Object.entries(legacy)) {
    const attempt = async (what: string, move: () => Promise<string | null>) => {
      try {
        const note = await move();
        if (note !== null) notes.push(note);
      } catch (err) {
        notes.push(`could not move ${what}: ${errorMessage(err)}`);
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

    for (const refFor of [landingRefName, rejectedRefName]) {
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
