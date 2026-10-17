import { migrateLandQueueDir } from "../landing/landing-queue.js";
import { registerStartupMigration } from "./startup-migrations.js";

/** The one place that fixes startup-migration step order. Callers import the runners from here,
 * so the steps are registered before anything can run. Add a step by appending one
 * `registerStartupMigration(...)` call at the end. */
registerStartupMigration({ name: "mergeQueueDir", run: async (root) => migrateLandQueueDir(root) });

export { runStartupMigrations, runStartupMigrationsIfIdle } from "./startup-migrations.js";
