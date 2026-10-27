import { logEvent, TUMWATER_SOURCE, warnEventBestEffort } from "../events/events.js";
import { orchestratorAlive } from "../team/team-orchestrator-info.js";
import { errorMessage } from "../text/text.js";

/** What one migration step did, as short notes. `moved` lists what it changed (moved, renamed or
 * removed), `kept` what it left in place because both names exist, `failed` what hit an error
 * and retries at the next start. */
export interface MigrationNotes {
  moved: string[];
  kept: string[];
  failed: string[];
}

/** The registry of idempotent startup-migration steps (plans/terminology.md "State and git").
 * A step moves one persisted name to its plain-terms replacement and returns its notes, all
 * empty when there was nothing to do. Every step must tolerate a concurrent
 * run: a source that vanished mid-step is skipped, not an error. The step order lives in
 * startup-migration-steps.ts, which callers import so the steps are registered before they run. */
interface StartupMigration {
  name: string;
  run(root: string): Promise<MigrationNotes>;
}

const registry: StartupMigration[] = [];

/** Append one step to the registry; a duplicate name throws. */
export function registerStartupMigration(step: StartupMigration): void {
  if (registry.some((s) => s.name === step.name)) throw new Error(`startup migration "${step.name}" is already registered`);
  registry.push(step);
}

/** Run every registered step in registration order. A step that changed something logs one
 * `state_migrated` event, whose detail also lists any collisions it kept; a step that only kept
 * collisions logs nothing. A step that reports failed artifacts or throws logs one warning, the
 * rest still run, and the step retries at the next start. A second call logs nothing once the
 * first moved everything it could. */
export async function runStartupMigrations(root: string): Promise<void> {
  for (const step of registry) {
    try {
      const { moved, kept, failed } = await step.run(root);
      if (moved.length > 0) {
        logEvent(root, {
          source: TUMWATER_SOURCE,
          type: "state_migrated",
          step: step.name,
          moved: moved.length,
          detail: [...moved, ...kept].join("; "),
        });
      }
      if (failed.length > 0) warnEventBestEffort(root, TUMWATER_SOURCE, `startup migration ${step.name}: ${failed.join("; ")}`);
    } catch (err) {
      warnEventBestEffort(root, TUMWATER_SOURCE, `startup migration ${step.name} failed: ${errorMessage(err)}`);
    }
  }
}

/** The CLI-reader form: runs the steps only when no orchestrator is alive for `root`, so a CLI
 * process never moves files under a running team, which may still be the old build. A live team
 * has already migrated at its own start. */
export async function runStartupMigrationsIfIdle(root: string): Promise<void> {
  if (orchestratorAlive(root)) return;
  await runStartupMigrations(root);
}
