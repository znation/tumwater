/** The seeded event logs the `history` CLI tests share: a fixed multi-role log with a usage-less
 * row, a paired run, and an unpaired run_end. test/cli-history.test.ts (the core views) and the
 * filter views split from it (cli-history-filtering.test.ts, cli-history-result.test.ts,
 * cli-history-model.test.ts) read it, so the exact rows those files assert against cannot
 * drift. A window view seeds relative to its own clock instead (seedWindowedHistory). */
import { initProject } from "../../src/init/init.js";
import { writeEvents } from "./log-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";

/** A repo holding a seeded event log: the feature role's paired run #7 (usage and detail), the
 * clean role's usage-less run #3, and the bugfix role's run #9 whose run_start was never
 * logged (its duration renders as an em dash) ending in an error. */
export async function seededHistoryRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "cli history test");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "run_start", run: 7 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1787222695956, loop: "feature", type: "run_end", run: 7, result: "changed", summary: "added a widget", tokens: 2400, costUsd: 0.02 }, // retired-name-ok: legacy event field in a fixture
    { ts: 1787222700000, loop: "clean", type: "run_end", run: 3, result: "no_change" }, // retired-name-ok: legacy event field in a fixture
    { ts: 1787222760000, loop: "bugfix", type: "run_end", run: 9, result: "error", error: "pi unreachable" }, // retired-name-ok: legacy event field in a fixture
  ]);
  return repo;
}

/** Seed run pairs at fixed ages before `now` (the pattern cli-logs-filtering.test.ts uses for
 * --since): one 2-day-old run_end outside any sane window, then a clean run (start 50m,
 * end 45m) and a feature run (start 30m, end 10m) inside a 1h window. */
export function seedWindowedHistory(repo: string, now = Date.now()): void {
  const age = (ms: number) => now - ms;
  writeEvents(repo, [
    { ts: age(2 * 86_400_000), loop: "feature", type: "run_end", run: 1, result: "changed", summary: "old work" }, // retired-name-ok: legacy event field in a fixture
    { ts: age(50 * 60_000), loop: "clean", type: "run_start", run: 2 }, // retired-name-ok: legacy event field in a fixture
    { ts: age(45 * 60_000), loop: "clean", type: "run_end", run: 2, result: "no_change", summary: "tidied" }, // retired-name-ok: legacy event field in a fixture
    { ts: age(30 * 60_000), loop: "feature", type: "run_start", run: 3 }, // retired-name-ok: legacy event field in a fixture
    { ts: age(10 * 60_000), loop: "feature", type: "run_end", run: 3, result: "changed", summary: "new work", tokens: 1200, costUsd: 0.01 }, // retired-name-ok: legacy event field in a fixture
  ]);
}
