/** The seeded event log the `history` CLI tests share: a fixed multi-role log with a usage-less
 * row, a paired tick, and an unpaired run_end. Both test/cli-history.test.ts (the core views)
 * and test/cli-history-filtering.test.ts (the --since/--grep views) read it, so the exact rows
 * those two files assert against cannot drift. Each test seeds relative to its own clock only
 * where the view under test is a window (that seed stays local to its file). */
import { initProject } from "../../src/init/init.js";
import { writeEvents } from "./log-fixtures.js";
import { makeRepo } from "./repo-fixtures.js";

/** A repo holding a seeded event log: the feature loop's paired tick #7 (usage and detail), the
 * clean loop's usage-less tick #3, and the bugfix loop's tick #9 whose run_start was never
 * logged (its duration renders as an em dash) ending in an error. */
export async function seededHistoryRepo(): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, "cli history test");
  writeEvents(repo, [
    { ts: 1787222691956, loop: "feature", type: "run_start", run: 7 },
    { ts: 1787222695956, loop: "feature", type: "run_end", run: 7, result: "changed", summary: "added a widget", tokens: 2400, costUsd: 0.02 },
    { ts: 1787222700000, loop: "clean", type: "run_end", run: 3, result: "no_change" },
    { ts: 1787222760000, loop: "bugfix", type: "run_end", run: 9, result: "error", error: "pi unreachable" },
  ]);
  return repo;
}
