import { logEvent, TUMWATER_SOURCE, warnEventBestEffort } from "../events/events.js";
import { orchestratorAlive } from "../team/orchestrator-info.js";
import { errorMessage } from "../text/text.js";

/** The registry of idempotent startup-migration steps (plans/terminology.md "State and git").
 * A step moves one persisted name to its plain-terms replacement and returns one short note per
 * thing it moved, nothing when there was nothing to do. Every step must tolerate a concurrent
 * run: a source that vanished mid-step is skipped, not an error. The step order lives in
 * startup-migration-steps.ts, which callers import so the steps are registered before they run. */
interface StartupMigration {
  name: string;
  run(root: string): Promise<string[]>;
}

const registry: StartupMigration[] = [];

/** Append one step to the registry; a duplicate name throws. */
export function registerStartupMigration(step: StartupMigration): void {
  if (registry.some((s) => s.name === step.name)) throw new Error(`startup migration "${step.name}" is already registered`);
  registry.push(step);
}

/** Run every registered step in registration order. A step that moved something logs one
 * `state_migrated` event; a step that throws logs one warning, the rest still run, and the failed
 * step retries at the next start. A second call moves and logs nothing. */
export async function runStartupMigrations(root: string): Promise<void> {
  for (const step of registry) {
    try {
      const notes = await step.run(root);
      if (notes.length > 0) {
        logEvent(root, {
          source: TUMWATER_SOURCE,
          type: "state_migrated",
          step: step.name,
          moved: notes.length,
          detail: notes.join("; "),
        });
      }
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
