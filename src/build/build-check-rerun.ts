/** Re-running only named failing tests (`check.rerunCommand`, rerunCommandOf), instead of the whole
 * check: the main watch confirms a red tip with it, and the review gate asks it whether a change's
 * failing tests also fail on main. The full check runs at most once per main commit — the watch's
 * own run — and every later question about the same failures is answered in seconds by running
 * just those tests. Split out of build-check.ts, which keeps running and classifying the declared
 * check: this module only builds the narrower command and reads back which named tests still
 * fail. */

import { runBuildCheck } from "./build-check.js";
import { BUILD_CHECK_TIMEOUT_MS, detectBuildCheck, rerunCommandOf } from "./build-check-detect.js";
import { FAILING_TESTS_MAX } from "./build-check-report.js";
import { buildCheckEvent } from "./build-check-events.js";
import { CHECK_TIER, withCheckPermit } from "../concurrency/check-permit.js";
import { logEventBestEffort } from "../events/events.js";
import { shellQuote } from "../agent/write-guard.js";
import type { CheckConfigSlice } from "../config/config-schema.js";

/** The re-run's filter arguments, one per test: `<file>#<name>`, with the file's base name from
 * the failure output (BuildCheckOutcome.failingTestFiles). When any test's file is unknown every
 * argument is a bare `#<name>`: a runner that selects files by the named ones would otherwise
 * never load the unlocated test. */
function rerunFilters(tests: readonly string[], files?: Readonly<Record<string, string>>): string[] {
  const located = tests.every((t) => files?.[t] !== undefined);
  return tests.map((t) => `${located ? files?.[t] : ""}#${t}`);
}

/** The shell command that re-runs `tests`: `command` followed by each filter, single-quoted. The
 * line the harness runs, and the one a heal prompt hands an agent to reproduce the failures. */
export function rerunCommandLine(
  command: string,
  tests: readonly string[],
  files?: Readonly<Record<string, string>>,
): string {
  return [command, ...rerunFilters(tests, files).map(shellQuote)].join(" ");
}

/** What a re-run found: the named tests that failed again. The rest passed, or did not run at all
 * in this tree — a test that exists only in a change's tree never fails on main. */
interface RerunResult {
  failing: string[];
}

/** Can `tests` be re-run on their own: a re-run command is in effect at `wt` and the list is
 * complete — non-empty and short of FAILING_TESTS_MAX, which may have been cut short. */
export function canRerun(wt: string, config: CheckConfigSlice | undefined, tests: readonly string[]): boolean {
  return tests.length > 0 && tests.length < FAILING_TESTS_MAX && rerunCommandOf(wt, config) !== undefined;
}

/** Re-run only `tests` in `wt` under the process-wide check permit, logged as a `rerun`-scope
 * build_check event under `source`. Null when no verdict came of it: no re-run command, an
 * incomplete list (canRerun), a skipped run (timeout, kill, broken toolchain, a host sleep), or a
 * failure that names none of `tests` — a compile error, a test file that would not load, or a
 * filter that matched nothing. Never throws. */
export async function rerunTests(
  root: string,
  source: string,
  wt: string,
  config: CheckConfigSlice | undefined,
  tests: readonly string[],
  files?: Readonly<Record<string, string>>,
  tier: number = CHECK_TIER.other,
): Promise<RerunResult | null> {
  const command = canRerun(wt, config, tests) ? rerunCommandOf(wt, config) : undefined;
  if (command === undefined) return null;
  const check = detectBuildCheck(wt, { ...config, check: { ...config?.check, command: rerunCommandLine(command, tests, files) } });
  if (check === null) return null;
  try {
    const started = Date.now();
    const outcome = await withCheckPermit(config, tier, () => runBuildCheck(wt, check, BUILD_CHECK_TIMEOUT_MS), undefined, `${source} rerun`);
    logEventBestEffort(root, buildCheckEvent(source, "rerun", outcome, Date.now() - started));
    if (outcome.status === "passed") return { failing: [] };
    if (outcome.status !== "failed") return null;
    // A failure naming none of the tests asked about (a test file that would not load names
    // itself) says nothing about them.
    const named = outcome.failingTests ?? [];
    const failing = tests.filter((t) => named.includes(t));
    return failing.length > 0 ? { failing } : null;
  } catch {
    return null;
  }
}
