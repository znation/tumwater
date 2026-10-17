import { migrateLandQueueDir } from "../landing/landing-queue.js";
import fs from "node:fs";
import { legacyLandingStatePath } from "../paths.js";
import { registerStartupMigration } from "./startup-migrations.js";

/** The one place that fixes startup-migration step order. Callers import the runners from here,
 * so the steps are registered before anything can run. Add a step by appending one
 * `registerStartupMigration(...)` call at the end. */
registerStartupMigration({ name: "mergeQueueDir", run: async (root) => migrateLandQueueDir(root) });
registerStartupMigration({
  name: "mergingMarker",
  run: async (root) => {
    try {
      fs.unlinkSync(legacyLandingStatePath(root));
      return ["removed the old landing.json marker"]; // vocabulary-ok: names the legacy file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  },
});

export { runStartupMigrations, runStartupMigrationsIfIdle } from "./startup-migrations.js";
