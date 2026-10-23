/** OpenCode's half of the write guard (src/agent/write-guard.ts holds the rule): a plugin every
 * team run loads through the injected config's `plugins` entry (opencode-config.ts). It refuses a
 * write under the team root but outside the run's worktree.
 *
 * OpenCode 2.x has no hook that blocks a tool from running. It has a permission `evaluate` hook
 * that may turn a decision to `deny` with a `message`, which reaches the model as the tool's error
 * while the run goes on. Every file-writing tool asks for the `edit` action with the absolute
 * paths it writes as `resources`, and the hook runs under `--auto` too, since `--auto` only
 * answers what would otherwise be asked. Checked live on opencode 2.1.0 on 2026-10-23. A
 * configured plugin path must be a directory, which is why this is `index.js` in a directory of
 * its own.
 *
 * The plugin's context names the run's directory (`location.directory`, the worktree OpenCode
 * runs in), which is the run directory the rule reads its checkout from. A failure of its own
 * leaves the decision alone, so a broken guard cannot stop every edit of a run. */

import { strayWriteRefusal } from "../../write-guard.js";

/** The fields of OpenCode's permission `evaluate` event the guard reads and sets. */
interface EvaluateEvent {
  action?: unknown;
  resources?: unknown;
  effect?: unknown;
  message?: unknown;
}

/** The slice of OpenCode's plugin context the guard uses. */
interface PluginContext {
  location?: { directory?: unknown };
  permission: { hook(name: "evaluate", callback: (event: EvaluateEvent) => void): unknown };
}

/** Deny an `edit` decision whose resources include a stray path from a run in `runDir`, naming
 * the first such path's refusal. Every other decision is left as it is. Exported for tests. */
export function guardEvaluate(event: EvaluateEvent, runDir: string): void {
  if (event.action !== "edit" || !Array.isArray(event.resources)) return;
  for (const resource of event.resources) {
    if (typeof resource !== "string" || resource === "") continue;
    const refusal = strayWriteRefusal(resource, runDir);
    if (refusal === null) continue;
    event.effect = "deny";
    event.message = refusal;
    return;
  }
}

export default {
  id: "tumwater-write-guard",
  async setup(ctx: PluginContext): Promise<void> {
    const runDir = ctx.location?.directory;
    if (typeof runDir !== "string" || runDir === "") return;
    await ctx.permission.hook("evaluate", (event) => {
      try {
        guardEvaluate(event, runDir);
      } catch {
        // Leave the decision alone; runner-run.ts's stray-write warning still sees the write.
      }
    });
  },
};
