import { defaultConfig } from "../../src/config/config.js";
import type { TumwaterConfig } from "../../src/config/config-schema.js";
import { writeConfig } from "../fixtures/repo-fixtures.js";
import { spawnCli } from "./cli-harness.js";

/** Write the config every full-run lifecycle test shares: only the clean role enabled. One
 * enabled role keeps the startup burst small; a no-op pi ends every run as no_change so
 * nothing is committed while the test observes the harness. `mutate` adjusts the config
 * before it is written (the agentBin test sets the agent binary there). */
export function onlyCleanRole(repo: string, mutate?: (cfg: TumwaterConfig) => void): void {
  const cfg = defaultConfig();
  for (const [id, role] of Object.entries(cfg.roles)) if (id !== "clean") role.enabled = false;
  mutate?.(cfg);
  writeConfig(repo, cfg);
}

/** The shape every spawned `run` lifecycle test shares: start the team against `restore`'s
 * environment (fakePi, pathReplace), wait for the banner + orchestrator-started event, run
 * the body, then always kill() the whole tree and undo the environment — in that order, so a
 * thrown assertion still reaps the generation its pipes are holding (BUGS.md 2026-09-30). */
export async function withRunningTeam(
  repo: string,
  restore: () => void,
  body: (s: ReturnType<typeof spawnCli>) => Promise<void>,
): Promise<void> {
  const s = spawnCli(repo, ["run"]);
  try {
    await s.waitFor(
      (out) => out.includes("tumwater running on branch main") && out.includes("tumwater started (pid"),
      "the run banner and orchestrator event",
    );
    await body(s);
  } finally {
    s.kill();
    restore();
  }
}
