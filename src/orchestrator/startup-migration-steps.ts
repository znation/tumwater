import { errCode } from "../errno.js";
import { legacyMigrateLandQueueDir } from "../merge/merge-queue.js";
import fs from "node:fs";
import { deleteRefIfAt, refSha, refsUnder, setRef } from "../git/git.js";
import { mergeRefName, legacyLandingStatePath } from "../paths.js";
import { migrateLegacyRoleIds } from "../roles/legacy-role-migration.js";
import { registerStartupMigration, type MigrationNotes } from "./startup-migrations.js";

/** The one place that fixes startup-migration step order. Callers import the runners from here,
 * so the steps are registered before anything can run. Add a step by appending one
 * `registerStartupMigration(...)` call at the end. */
registerStartupMigration({ name: "mergeQueueDir", run: async (root) => legacyMigrateLandQueueDir(root) });
registerStartupMigration({
  name: "mergingMarker",
  run: async (root) => {
    try {
      fs.unlinkSync(legacyLandingStatePath(root));
      return { moved: ["removed the old landing.json marker"], kept: [], failed: [] }; // vocabulary-ok: names the legacy file
    } catch (err) {
      if (errCode(err) === "ENOENT") return { moved: [], kept: [], failed: [] };
      throw err;
    }
  },
});
registerStartupMigration({
  name: "mergeRefs",
  run: async (root) => {
    const legacyPrefix = "refs/tumwater/landing/"; // vocabulary-ok: legacy name read from old refs or commits
    const notes: MigrationNotes = { moved: [], kept: [], failed: [] };
    for (const { ref, sha } of await refsUnder(root, legacyPrefix)) {
      const role = ref.slice(legacyPrefix.length);
      const target = mergeRefName(role);
      const existing = await refSha(root, target);
      if (existing === null) {
        if (!(await setRef(root, target, sha))) continue; // keep the legacy pin; the next start retries
        await deleteRefIfAt(root, ref, sha);
        notes.moved.push(`moved ${ref} to ${target}`);
      } else if (existing === sha) {
        await deleteRefIfAt(root, ref, sha);
        notes.moved.push(`removed ${ref}: ${target} already names the same commit`);
      } else notes.kept.push(`kept ${ref} and ${target}: they name different commits`);
    }
    return notes;
  },
});
registerStartupMigration({ name: "legacyRoleIds", run: (root) => migrateLegacyRoleIds(root) });

export { runStartupMigrations, runStartupMigrationsIfIdle } from "./startup-migrations.js";
