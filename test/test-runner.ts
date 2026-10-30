import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { printCoverageTable } from "./coverage-table.js";
import { buildDepGraph, fitBudget, selectAffected } from "./affected-tests.js";
import { exitWithOwnerEnv } from "./fixtures/victim-fixture.js";
import { findOnPath } from "../src/files/files.js";
import { systemProcessProbe, type ProcessRow } from "../src/process/process-table.js";
import { readJsonFile, writeJsonAtomic } from "../src/files/json-files.js";
import { finiteNumber } from "../src/files/json-object.js";
import { realGitFromXcrun } from "../src/git/xcrun-git.js";
import { SUPERVISED_ENV, SUPERVISOR_PID_ENV } from "../src/process/supervisor.js";
import { DASHBOARD_CHILD_ENV } from "../src/redeploy/self-reload.js";
import { typoSuffix } from "../src/text/suggest.js";

/** Run the compiled unit tests with node:test — the target of package.json's `test` script.
 * With no arguments it runs every dist/test/*.test.js EXCEPT the `*.e2e.test.js` tier — the
 * live-orchestrator cases, whose wall-clock waits a loaded machine can blow and which then
 * reject whatever commit is being gated instead of the code under test (BUGS.md 2026-09-21);
 * they run via `npm run test:e2e` (and in CI) instead. With one or more name filters it runs
 * only the test files whose source-style name contains a filter as a plain substring (`npm test
 * merge` → merge-to-main.test.ts), so iterating on one module gets a few-second feedback loop
 * instead
 * of the full suite — filters match e2e files too, so `npm test orchestrator` or
 * `npm run test:e2e` deliberately brings the tier back. A filter may carry a `#name` part
 * (`npm test 'runner#resume'`), which additionally filters the individual tests inside the selected
 * files by name substring — with 2,000+ tests, running one module still runs its whole file, and
 * the failing test's name is usually known. A filter that matches nothing is an error listing what
 * exists (a `#name` that matches nothing fails the run too — a silent empty pass would look
 * exactly like a green suite), and node --test's exit code always propagates, so both humans and
 * the gate can rely on it. Files start longest-first by the durations earlier runs recorded
 * (orderByDuration), and the run gets a hermetic, git-cheap environment (suiteEnv). The
 * selection and ordering logic is pure and exported (selectTestFiles, orderByDuration) so
 * test/test-runner.test.ts pins its rules without spawning anything; the spawn lives in main()
 * behind an import guard, because this module is imported by that very test file and a
 * top-level run would recurse into node --test. A --coverage mode (npm run test:coverage) runs
 * the same selection with node's coverage table and skips the durations ledger: instrumentation
 * slows every file, and recording those skewed times would skew later runs' ordering. A pure
 * e2e selection (`npm run test:e2e`, `npm test <file>.e2e.test.js`) runs its files one at a time
 * on a node that knows `--test-concurrency` (v20.10+, the engines floor is >=20.3), so the tier's
 * wall-clock waits each run
 * against a quiet host rather than competing with sibling files. Node's table
 * flips between runs on the same tree (BUGS.md 2026-09-30), so unless the caller brought its own
 * NODE_V8_COVERAGE — docs/code-metrics/run.sh sets one around `npm run test:coverage` and maps
 * the dumps itself with coverage.cjs — the runner captures the raw V8 dumps in its scratch dir
 * and, after the run, prints a deterministic per-file table merged from them
 * (test/coverage-table.ts). The whole run sits under a hard ceiling
 * (SUITE_TIMEOUT_MS) enforced by spawnSync's own timeout, so a hung or never-exiting suite
 * fails the gate instead of holding it forever. */

/** The whole suite's hard ceiling: no green run has come near it, so only a test that hangs or
 * leaves the event loop alive (a leaked timer, socket, or worker) can reach it. */
export const SUITE_TIMEOUT_MS = 30 * 60_000;

/** Map a suite spawn that hit SUITE_TIMEOUT_MS to its failure message. spawnSync kills the
 * timed-out child itself and reports ETIMEDOUT — semantics a decade old, unlike node --test's
 * own --test-timeout and --test-force-exit flags, which postdate package.json's engines floor
 * (>= 20.3) and would need version gates that mis-gate: a supported node must never refuse to
 * start the suite over a guard flag. ETIMEDOUT alone decides: node --test traps the SIGTERM,
 * prints "Interrupted while running", and exits 1, so a timed-out suite comes back with status
 * 1 rather than the null of a signal death. Returns null for every outcome spawnSync reports
 * without a timeout kill (a green run, node --test's own failures, an externally signalled
 * child). Exported for test/test-runner.test.ts to pin against a real spawnSync kill. */
export function timedOutFailure(r: { error?: unknown }): string | null {
  if ((r.error as { code?: unknown } | undefined)?.code !== "ETIMEDOUT") return null;
  return `the test suite exceeded its ${SUITE_TIMEOUT_MS / 60_000}-minute ceiling and was killed — a test hangs or ` +
    `leaves the event loop alive; bisect with npm test '<file filter>' or a "#name" filter (npm test 'runner#resume')`;
}

/** What selectTestFiles decided: which compiled files to run (and their source-style names for
 * messages), or why nothing could be selected. */
interface TestFileSelection {
  /** Basenames with the .js swapped for .ts — what a developer sees in test/ and types as a
   * filter. */
  names: string[];
  /** Absolute paths of the compiled files to hand to node --test, sorted by name. */
  files: string[];
  /** Set when nothing could be selected (no dist/test dir, no *.test.js in it, or no filter
   * match). */
  error?: string;
  /** The `#name` parts of the filters, escaped and ORed into one node --test
   * --test-name-pattern (regex) value; undefined when no filter carried one. */
  namePattern?: string;
  /** The `#name` parts exactly as the developer typed them, in filter order — what main()'s
   * announcement and noNameMatchReason echo back, rather than the escaped regex above, so a
   * multi-name run reads as the names typed instead of an `a|b` alternation. Undefined when
   * no filter carried a name part. */
  nameFilters?: string[];
}

/** One filter as typed: `file` selects test files by name substring; the optional part after a
 * `#` (a test's own name substring) narrows what runs inside the selected files. A bare `#`
 * with nothing after it is rejected by selectTestFiles — an empty pattern would mean "run
 * nothing", which is never what a typo'd filter intended. */
interface ParsedFilter {
  file: string;
  name: string | null;
}

/** Split one filter at its first `#`: everything before selects files (empty = no constraint,
 * the `#name`-less default set), everything after names tests. Later `#`s stay in the name —
 * test names may contain one; the split is not recursive. */
export function parseFilter(raw: string): ParsedFilter {
  const hash = raw.indexOf("#");
  return hash < 0 ? { file: raw, name: null } : { file: raw.slice(0, hash), name: raw.slice(hash + 1) };
}

/** Escape a `#name` part so node --test's pattern matcher (a regex) sees the literal substring
 * the developer typed — the same no-regex rule the file part follows, so a name like
 * "merge (2)" filters, not explodes. */
function escapeNamePattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The e2e tier: files whose name carries `.e2e.` are excluded from the unfiltered (gating)
 * run — they are the live-orchestrator cases whose fixed wall-clock budgets are not reliable
 * under machine load (BUGS.md 2026-09-21) — and are selected only by an explicit filter. */
const E2E_SUFFIX = ".e2e.test.js";

/** True when a selection is the pure e2e tier: at least one file, and every basename carries
 * the e2e suffix. Only such a selection serializes its files (one node --test worker at a
 * time), so each e2e file's wall-clock waits contend with no sibling; the unit suite and any
 * mixed selection keep node --test's own parallel workers. Exported for
 * test/test-runner.test.ts to pin the boundary. */
export function isE2eTier(files: readonly string[]): boolean {
  return files.length > 0 && files.every((file) => path.basename(file).endsWith(E2E_SUFFIX));
}

/** Pick which compiled test files under `distDir` to run. No filters → every file except the
 * `.e2e.test.js` tier (run that via `npm run test:e2e`). Otherwise a file is selected when its
 * source-style name contains at least one filter as a plain substring (no regex, case-sensitive
 * — `runner` selects both runner.test.ts and runner-2.test.ts); e2e files are filterable like any
 * other. Non-test files in the directory are ignored.
 *
 * File selection uses each filter's part before the `#`: at least one non-empty part selects
 * files by substring (e2e included, as before — naming a file is deliberate iteration); when
 * every part is empty (bare `#name` filters, or none) the run is the unfiltered gating set,
 * e2e excluded — a name-only search is a dev tool, and it must not silently pay the e2e tier's
 * wall-clock budget. Every non-null name part is ORed into one --test-name-pattern applied
 * across all selected files (node's pattern is global, so `a#x b#y` runs tests matching x or
 * y in the files a or b select — the name parts cannot be per-file, and one alternation is
 * the honest shape of that). */
export function selectTestFiles(filters: readonly string[], distDir: string): TestFileSelection {
  // A leading "-" is a flag, never a file filter: a misspelt `--covrage` would otherwise fall
  // through to "no test file matches" and read as a missing file.
  const flag = filters.find((f) => f.startsWith("-"));
  if (flag !== undefined)
    return {
      names: [],
      files: [],
      error: `unknown option ${JSON.stringify(flag)} — the runner takes --coverage, --affected[=<ref>], --budget=<seconds>, --repeat=<n>, and file or file#name filters`,
    };
  for (const raw of filters) {
    if (parseFilter(raw).name === "")
      return {
        names: [],
        files: [],
        error: `a "#" must be followed by the test name to run, as in runner#resume (got ${JSON.stringify(raw)})`,
      };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(distDir);
  } catch {
    return { names: [], files: [], error: `no compiled tests under ${distDir} — run \`npm run build\` first` };
  }
  const named = entries
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => ({ file: path.join(distDir, f), name: f.replace(/\.js$/, ".ts") }));
  if (named.length === 0)
    return { names: [], files: [], error: `no *.test.js files under ${distDir} — run \`npm run build\` first` };
  const parsed = filters.map(parseFilter);
  const namedFile = parsed.some((p) => p.file !== "");
  const picked = !namedFile
    ? named.filter((n) => !n.file.endsWith(E2E_SUFFIX))
    : named.filter((n) => parsed.some((p) => p.file !== "" && n.name.includes(p.file)));
  if (picked.length === 0) {
    // A near-miss filter gets the shared did-you-mean every other unknown-value error
    // carries, computed against each file's stem (the substring a developer usually types,
    // `runner` for runner.test.ts) as well as its full source-style name — the listing alone
    // leaves a one-letter slip like `lopp` unmatched. Only the first file filter is hinted;
    // this branch is reached only when none of them matched.
    const firstFileFilter = parsed.find((p) => p.file !== "")?.file ?? "";
    const candidates = named.flatMap((n) => [n.name.replace(/\.test\.ts$/, ""), n.name]);
    return {
      names: [],
      files: [],
      error: `no test file matches ${filters.map((f) => JSON.stringify(f)).join(" or ")} — available: ${named
        .map((n) => n.name)
        .join(", ")}${typoSuffix(firstFileFilter, candidates)}`,
    };
  }
  const nameParts = parsed.flatMap((p) => (p.name === null ? [] : [p.name]));
  return {
    names: picked.map((n) => n.name),
    files: picked.map((n) => n.file),
    ...(nameParts.length === 0
      ? {}
      : { namePattern: nameParts.map(escapeNamePattern).join("|"), nameFilters: nameParts }),
  };
}

/** The compiled test directory this build's tests live in (dist/test, this module's own dir). */
function defaultDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test");
}

/** Order `files` longest-first by the per-file durations of earlier runs (compiled basename →
 * ms). node --test starts files in the order given, as many at once as its concurrency allows,
 * so a long file started last sets the run's wall time on its own while every other worker
 * idles; longest-first leaves only short files for the tail. A file with no recorded duration
 * (new, or never run) goes first — its cost is unknown, and early is the safe guess. Ties keep
 * the given (name) order. */
export function orderByDuration(files: readonly string[], durations: Readonly<Record<string, number>>): string[] {
  const cost = (file: string): number => {
    const ms = durations[path.basename(file)];
    return finiteNumber(ms, Infinity);
  };
  return files
    .map((file, index) => ({ file, index, ms: cost(file) }))
    .sort((a, b) => (a.ms === b.ms ? a.index - b.index : b.ms - a.ms))
    .map((f) => f.file);
}

/** Where a build's per-file durations live between runs: beside the compiled tests, so a fresh
 * `npm run build` (which removes dist/) starts over from name order. */
function durationsPath(distDir: string): string {
  return path.join(distDir, ".durations.json");
}

/** Fold a run's fresh per-file durations (the durations reporter's output file) into the
 * stored ones. Files this run skipped — a filtered run — keep their old entries. A run that
 * wrote nothing (it crashed before the reporter finished) changes nothing. */
function recordDurations(distDir: string, freshFile: string): void {
  const fresh = readJsonFile<Record<string, number>>(freshFile);
  if (!fresh) return;
  const stored = readJsonFile<Record<string, number>>(durationsPath(distDir)) ?? {};
  try {
    writeJsonAtomic(durationsPath(distDir), { ...stored, ...fresh });
  } catch {
    // Ordering is an optimization: a read-only dist/ just keeps name order.
  }
}

/** `base` plus git config entries for every git process the suite starts, appended through
 * git's GIT_CONFIG_COUNT/KEY/VALUE environment protocol after any entries `base` already
 * carries (so a caller's own env-injected config survives). The suite starts ~12,000 git
 * processes — its fixtures and the code under test alike — so per-spawn overhead IS its
 * runtime, and each entry here removes a cost without changing what any command does:
 * - maintenance.auto=false: commit, merge, rebase and cherry-pick otherwise each start a
 *   second process, `git maintenance run --auto`, that never has work in a throwaway repo. */
export function suiteGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const entries: [string, string][] = [["maintenance.auto", "false"]];
  const env = { ...base };
  const start = Number.parseInt(base.GIT_CONFIG_COUNT ?? "", 10);
  let n = Number.isInteger(start) && start > 0 ? start : 0;
  for (const [key, value] of entries) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

/** Wall-clock bound on the suite's own macOS `xcrun --find git` probe. The probe is the shared
 * xcrun-git.ts's `realGitFromXcrun` (also the harness's git-run probe): a synchronous spawnSync,
 * so a wedged xcrun (an Xcode license prompt, a corrupt developer directory) would block the
 * whole event loop — here it would freeze the entire test run, with no watchdog able to fire. A
 * short bound treats the unanswered case as "no real binary" and leaves PATH alone. */
const SUITE_XCRUN_TIMEOUT_MS = 10_000;

/** Build the suite's environment from `base` in `scratch` (a directory the caller removes after
 * the run): `base` without the harness's own variables (below), suiteGitEnv's config, an empty
 * GIT_TEMPLATE_DIR (every `git init` otherwise copies the sample hooks), and on macOS a way
 * around the xcode-select shim. /usr/bin/git there is a stub that re-resolves the developer
 * directory on every call before exec'ing the real git — ~10 ms extra per spawn, roughly
 * tripling what each git call costs. When the first git on PATH is that stub, a symlink to the
 * real binary (`xcrun --find git`, the same file the stub would exec) goes first on PATH
 * instead. Any other git — Linux, Homebrew — is left alone.
 *
 * The harness's variables: a team's build checks and pi tool calls run with the harness's own
 * environment, so a suite they start inherits what the operator exported, the supervisor set,
 * and what the run itself exported, while a suite run by hand does not. Each one the harness
 * resolves out of the environment is dropped here, so a suite a run starts exercises exactly
 * what a hand-run suite does:
 * - TUMWATER_PI_BIN outranks PATH in resolveBackendBin, so an operator's override (a wrapper
 *   around the real pi, plans/portability.md) displaced every fake pi the suite puts on PATH:
 *   the fake-pi tests ran the agent it named (BUGS.md 2026-09-28). Tests of the variable set it
 *   themselves; test/fakes/fake-pi.ts drops it too, for a file run directly with `node --test`.
 * - TUMWATER_CLAUDE_BIN is claude's twin of TUMWATER_PI_BIN: a fake-claude suite run from a
 *   shell that exported it would spawn the operator's binary instead of the PATH shim.
 * - TUMWATER_OPENCODE_BIN is opencode's twin of the same: a fake-opencode suite run from a
 *   shell that exported it would spawn the operator's binary instead of the PATH shim.
 * - TUMWATER_CODEX_BIN is codex's twin of TUMWATER_PI_BIN: a fake-codex suite run from a
 *   shell that exported it would spawn the operator's binary instead of the PATH shim.
 * - CLAUDECODE and every CLAUDE_CODE_* mark a host Claude Code session. A run spawned inside
 *   one that kept them reports "Not logged in" (finding 2), and the isolation env strips them
 *   at spawn; dropping them here makes a suite started by hand and one started by a run
 *   exercise the same parent environment.
 * - OPENCODE and every OPENCODE_* mark a host OpenCode session (its client, server, config,
 *   database, and session id), which opencodeEnv scrubs at spawn; dropping them here keeps a
 *   hand-run suite from inheriting a host session's variables into the fake-driven runs.
 * - CODEX and every CODEX_* mark a host Codex session (its home, config, and state), which
 *   codexEnv scrubs at spawn; dropping them here keeps a hand-run suite from inheriting a host
 *   session's variables into the fake-driven runs.
 * - SUPERVISED_ENV marks the orchestrator child, so a `tumwater run` that inherits it skips its
 *   supervisor half. test/helpers/cli-harness.ts also drops it from every CLI child it starts.
 * - SUPERVISOR_PID_ENV carries the supervisor pid a supervised run was handed, so an inherited
 *   mark would make a spawned run's watch compare against a stale pid and stop early.
 * - TUMWATER_NOTES_PATH names the role's notes file the `tumwater-notes` command reads, so a
 *   non-authoring run that inherited a run's notes path would point that command at a file
 *   the run's own contract says it must not touch (test/runner-pi.test.ts pins the empty env line).
 * - DASHBOARD_CHILD_ENV makes reexecSelf exit its restart code instead of supervising, so an
 *   inherited mark changed the reload tests' branch through the ambient environment.
 *
 * The one variable the suite SETS outright (rather than dropping): PI_CODING_AGENT_DIR points
 * at an empty scratch subdir (not created), so a suite that reads pi's config — models.json and
 * settings.json both default there (pi-models.ts, pi-settings.ts) — sees no pi config at all
 * instead of the developer's real ~/.pi/agent. Before this, an inherited value was dropped and
 * a suite read the host's real agent dir; with a snapshot that also reads pi's own saved
 * default, that would put the host's model name into every row of a config without a `model`.
 * NODE_OPTIONS is kept: the LaunchServices preload the harness adds there only changes where
 * process.title is stored (the suite's assertions about it hold either way), and it carries the
 * operator's own Node flags.
 *
 * Two things deliberately reach the suite, so it can never outlive whoever started it:
 * - TUMWATER_RUN is kept. A suite a pi run starts carries that run's mark, and the run's exit
 *   sweep (run-marker.ts) reaps whatever of it is still alive when the run ends. A nested run
 *   inside the suite appends its own mark and sweeps only that, so the outer mark changes
 *   nothing the tests see. Dropping it (2026-10-06) hid every orphaned suite from the sweep: on
 *   2026-10-21 an agent stopped hung runs with `kill $PID`, which killed only this runner, and the
 *   orphaned workers' 5 ms repaint loops kept the host unable to start processes for 1h47m.
 * - `owner` (this runner) becomes the owner of every node process in the suite, through the
 *   exit-with-owner preload (victim-fixture.ts's exitWithOwnerEnv). main() waits in spawnSync,
 *   where no signal handler can run, so the runner cannot forward a SIGTERM to node --test. The
 *   preload is the other half: once the runner is gone, however it died, node --test and its
 *   workers exit within the preload's 250 ms poll. A test that starts its own child under
 *   exitWithOwnerEnv takes over as that child's owner, so the chain still ends at this runner. */
export function suiteEnv(
  scratch: string,
  base: NodeJS.ProcessEnv = process.env,
  owner: number = process.pid,
): NodeJS.ProcessEnv {
  const env = suiteGitEnv(base);
  delete env.TUMWATER_PI_BIN;
  delete env.TUMWATER_CLAUDE_BIN;
  delete env.TUMWATER_OPENCODE_BIN;
  delete env.TUMWATER_CODEX_BIN;
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_")) delete env[key];
    if (key === "OPENCODE" || key.startsWith("OPENCODE_")) delete env[key];
    if (key === "CODEX" || key.startsWith("CODEX_")) delete env[key];
  }
  delete env[SUPERVISED_ENV];
  delete env[SUPERVISOR_PID_ENV];
  delete env.TUMWATER_NOTES_PATH;
  delete env[DASHBOARD_CHILD_ENV];
  env.PI_CODING_AGENT_DIR = path.join(scratch, "pi-agent");
  const templates = path.join(scratch, "git-templates");
  fs.mkdirSync(templates);
  env.GIT_TEMPLATE_DIR = templates;
  if (process.platform === "darwin" && findOnPath("git", env.PATH ?? "") === "/usr/bin/git") {
    const real = realGitFromXcrun(SUITE_XCRUN_TIMEOUT_MS);
    if (real) {
      const bin = path.join(scratch, "bin");
      fs.mkdirSync(bin);
      fs.symlinkSync(real, path.join(bin, "git"));
      env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
    }
  }
  return exitWithOwnerEnv(env, owner);
}

/** Detect a `#name` filter that matched nothing, from the TAP side-channel the run wrote to
 * `tap`: TAP records one `ok`/`not ok` line per thing the run executed, and node --test names a
 * file whose tests all miss the pattern by the file itself (`ok 1 - runner.test.js`) while matched
 * tests and their parent describes carry their own names. So when every ok line names a compiled
 * test file, nothing inside any file ran — the filter passed an empty suite, which must fail
 * loudly (a silent green run would read as verified work that never executed). Returns the
 * failure reason, or null when something matched — or when no TAP was written (a crashed run's
 * exit code already reports that; this guard only speaks for a green-but-empty run). The
 * `nameFilters` the caller passes (the developer's typed name parts, empty when unknown) are
 * named in the reason, so a multi-name run is not left to reread its command line.
 * Exported for test/test-runner.test.ts to pin without spawning node --test. */
export function noNameMatchReason(tapPath: string, nameFilters: readonly string[] = []): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(tapPath, "utf8");
  } catch {
    return null;
  }
  const ran = [...raw.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)]
    .map((m) => (m[1] ?? "").replace(/ # .*$/, "")) // a trailing directive (# SKIP, # TODO) is not the name
    .filter((n) => n !== "");
  if (ran.length === 0 || ran.some((n) => !n.endsWith(".test.js"))) return null;
  // Name the filters the developer typed, not just the `#` syntax: the file-filter no-match
  // error already echoes its input, and a multi-name run is otherwise left to reread its own
  // command line. An empty list (a caller with no names) keeps the generic wording.
  const which =
    nameFilters.length > 0
      ? nameFilters.map((n) => JSON.stringify(n)).join(" or ")
      : 'the "#name" filter';
  return `no test name matches ${which} — the selected file(s) ran empty; check the spelling after "#"`;
}

/** Split the runner's argv into its filters and its coverage mode: `--coverage` selects the
 * mode wherever it appears and is removed from the filters, so it composes with every filter
 * form (`--coverage runner`, `runner --coverage`, `--coverage 'runner#resume'`). Exported for
 * test/test-runner.test.ts to pin the split without spawning the runner. */
export function splitCoverageArgv(argv: readonly string[]): { filters: string[]; coverage: boolean } {
  return { filters: argv.filter((a) => a !== "--coverage"), coverage: argv.includes("--coverage") };
}

/** Split `--affected` (or `--affected=<ref>`) off the runner's argv: the mode `npm run test:gate`
 * runs, which selects the test files a change can reach (test/affected-tests.ts) instead of
 * taking filters. `ref` is the branch the change is measured against, `main` when bare. The
 * last occurrence wins. Exported for test/test-runner.test.ts. */
export function splitAffectedArgv(argv: readonly string[]): { rest: string[]; ref: string | undefined } {
  let ref: string | undefined;
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg === "--affected") ref = "main";
    else if (arg.startsWith("--affected=")) ref = arg.slice("--affected=".length) || "main";
    else rest.push(arg);
  }
  return { rest, ref };
}

/** The most seconds `--budget` may give the gate's tests. */
const MAX_BUDGET_S = 3600;

/** Split `--budget=<seconds>` off the runner's argv (already stripped of --affected): the most
 * test-file time, by the durations ledger, that an `--affected` run may select
 * (affected-tests.ts's fitBudget). n must be a whole number from 1 to MAX_BUDGET_S, and the flag
 * needs `--affected`, which main() checks; a bare `--budget` is an error. The last occurrence
 * wins. Without the flag `budgetMs` is undefined. Exported for
 * test/test-runner-affected.test.ts. */
export function splitBudgetArgv(argv: readonly string[]): { rest: string[]; budgetMs?: number; error?: string } {
  const rest = argv.filter((a) => a !== "--budget" && !a.startsWith("--budget="));
  const flag = argv.filter((a) => a === "--budget" || a.startsWith("--budget=")).pop();
  if (flag === undefined) return { rest };
  const raw = flag.slice("--budget=".length);
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_BUDGET_S))
    return { rest, error: `--budget needs a whole number of seconds from 1 to ${MAX_BUDGET_S}, as --budget=<seconds>` };
  return { rest, budgetMs: n * 1000 };
}

/** What a budgeted run prices a test file the durations ledger has never timed (new, or never
 * run in this build). The suite's mean file takes about 7 s and its median 1 s, so a fresh
 * build's first gate runs a handful of files, and each run's own durations fill the ledger. */
const UNTIMED_TEST_FILE_MS = 5_000;

/** What a budgeted run adds to each file's price for the time node --test spends on it outside
 * its tests: a worker process and its imports, which the ledger (test time only) leaves out. It
 * measured ~0.14 s a file at load 24 on 18 cores and several times that at load 80, where a
 * 30 s budget of 247 small files ran 64 s; without it a budget fills with hundreds of tiny files
 * whose startup alone outruns it. */
const PER_FILE_OVERHEAD_MS = 250;

/** The most left-out files near the change that a budgeted run's announcement names. */
const LEFT_OUT_NAMED = 5;

/** The most times `--repeat` may rerun a filtered test. */
const MAX_REPEAT = 50;

/** Split `--repeat=<n>` off the filters (already stripped of --coverage and --affected): n reruns
 * of the same node --test command so a timing flake reproduces on demand. It needs at least one
 * file or `file#name` filter and n a whole number from 1 to MAX_REPEAT; a bare `--repeat` is an
 * error. Without the flag `repeat` is undefined. Exported for test/test-runner.test.ts. */
export function splitRepeatArgv(argv: readonly string[]): { rest: string[]; repeat?: number; error?: string } {
  const rest = argv.filter((a) => a !== "--repeat" && !a.startsWith("--repeat="));
  const flag = argv.filter((a) => a === "--repeat" || a.startsWith("--repeat=")).pop();
  if (flag === undefined) return { rest };
  const raw = flag.slice("--repeat=".length);
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= MAX_REPEAT))
    return { rest, error: `--repeat needs a whole number from 1 to ${MAX_REPEAT}, as --repeat=<n>` };
  if (!rest.some((f) => !f.startsWith("-")))
    return { rest, error: "--repeat needs at least one file or file#name filter to rerun" };
  return { rest, repeat: n };
}

/** Run `once` up to `n` times back to back, stopping at the first non-zero status. `failedAt` is
 * that run's 1-based iteration (undefined when every run passed); `runs` is how many ran. */
export function repeatRuns(n: number, once: (iteration: number) => number): { status: number; runs: number; failedAt?: number } {
  for (let i = 1; i <= n; i++) {
    const status = once(i);
    if (status !== 0) return { status, runs: i, failedAt: i };
  }
  return { status: 0, runs: n };
}

/** Every repo-relative path a change touches in `repoRoot`: committed since its merge-base with
 * `ref`, plus staged, unstaged and untracked (not ignored) files, deleted paths included and a
 * rename as both its paths. An error names what git could not answer: the caller then runs the
 * full suite rather than guess. Exported for test/test-runner.test.ts to pin on a real repo. */
export function changedSinceBase(repoRoot: string, ref: string): { files: string[] } | { error: string } {
  const run = (args: string[]) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  const base = run(["merge-base", "HEAD", ref]);
  if (base.status !== 0) return { error: `no merge-base between HEAD and ${ref}` };
  const tracked = run(["diff", "--name-only", "--no-renames", "-z", base.stdout.trim()]);
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (tracked.status !== 0 || untracked.status !== 0) return { error: "git could not list the changed files" };
  const files = `${tracked.stdout}${untracked.stdout}`.split("\0").filter((f) => f !== "");
  return { files: [...new Set(files)].sort() };
}

/** Whether this node knows `--test-coverage-exclude`: the flag arrived in v22.5.0, above the
 * package's >=20.3 engines floor, so a supported node must never be handed it. Exported for
 * test/test-runner.test.ts to pin the boundary. */
export function nodeSupportsTestCoverageExclude(version: string = process.versions.node): boolean {
  const [major, minor] = version.split(".").map((p) => Number.parseInt(p, 10));
  if (major === undefined || minor === undefined) return false;
  return major > 22 || (major === 22 && minor >= 5);
}

/** Whether this node knows `--test-concurrency`: the flag arrived in v20.10.0. The package's
 * engines floor is >=20.3, so nodes 20.3 through 20.9 must never be handed it but every node at
 * or above 20.10 may. Exported for test/test-runner.test.ts to pin the boundary. */
export function nodeSupportsTestConcurrency(version: string = process.versions.node): boolean {
  const [majorStr, minorStr] = version.split(".");
  const major = Number.parseInt(majorStr ?? "", 10);
  const minor = Number.parseInt(minorStr ?? "", 10);
  if (!Number.isInteger(major) || major < 20) return false;
  if (major > 20) return true;
  // major === 20: the flag arrived at 20.10.0.
  return Number.isInteger(minor) && minor >= 10;
}

/** The project's suite runners currently in flight, read from a process table: rows whose argv
 * names this project's test runner (`dist/test/test-runner.js`). A running suite's own runner is
 * in the table, so the count is at least 1. Counting the runner processes on the host is the
 * census behind the non-e2e concurrency sizing, so N suites running at once can each take a
 * fair slice of the cores instead of every suite grabbing node's default `parallelism - 1`
 * workers. Exported pure so test/test-runner.test.ts pins the match against fixture rows. */
export function suitesInFlight(rows: readonly ProcessRow[]): number {
  return rows.filter((r) => r.command.includes("test-runner.js")).length;
}

/** How many parallel node --test workers one suite should ask for when `inFlight` suites are
 * contending for `parallelism` cores: the cores shared evenly, at least 1. With 18 cores and 9
 * suites in flight each gets 2, rather than all 9 piling onto node's default 17. */
export function sizeTestConcurrency(inFlight: number, parallelism: number): number {
  return Math.max(1, Math.floor(parallelism / inFlight));
}

/** The concurrency this non-e2e suite should run under — the host's cores shared with the suites
 * already in flight — or undefined (node's default) when node predates `--test-concurrency` or
 * the process table cannot be read: a census failure must degrade a suite, never break it. The
 * probe is a parameter so tests run it against a fake host; main() calls it with the real one. */
export async function sharedSuiteConcurrency(
  probe: { list(): Promise<ProcessRow[]> } = systemProcessProbe,
): Promise<number | undefined> {
  if (!nodeSupportsTestConcurrency()) return undefined;
  try {
    const rows = await probe.list();
    return sizeTestConcurrency(suitesInFlight(rows), os.availableParallelism());
  } catch {
    return undefined;
  }
}

/** The node --test argv main() spawns, built from a selection: node's default spec reporter to
 * stdout (named explicitly because a second reporter would otherwise replace it), the durations
 * reporter into `fresh`, the #name pattern and its TAP side-channel reporter when the selection
 * carries a name pattern, the files themselves in the caller's order, under `coverage` node's
 * coverage flags (so the run ends with the coverage table), and — under `concurrency` — a
 * `--test-concurrency=N` right after `--test`, which caps node --test's parallel workers so a
 * pure e2e selection (`npm run test:e2e`) runs its files one at a time. Exported pure so
 * test/test-runner.test.ts pins the flags without spawning a suite. */
export function buildNodeTestArgs(
  sel: { files: readonly string[]; namePattern?: string },
  opts: { reporter: string; fresh: string; tap?: string; coverage?: boolean; concurrency?: number },
): string[] {
  return [
    "--test",
    // A pure e2e tier runs its files one at a time: `--test-concurrency` (v20.10+) caps node
    // --test's
    // parallel workers, so one file's wall-clock waits never contend with its siblings. The flag
    // must precede the positional files, so it sits right after `--test`.
    ...(opts.concurrency === undefined ? [] : [`--test-concurrency=${opts.concurrency}`]),
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${opts.reporter}`,
    `--test-reporter-destination=${opts.fresh}`,
    // Only with a #name filter: a third reporter whose TAP output backs the empty-match
    // guard in main() (the spec output cannot be read there — it streams to the developer).
    ...(sel.namePattern
      ? ["--test-name-pattern=" + sel.namePattern, "--test-reporter=tap", `--test-reporter-destination=${opts.tap}`]
      : []),
    ...(opts.coverage
      ? [
          "--experimental-test-coverage",
          // Once node can keep the table on src, the test files — most of the lines under
          // instrumentation — drop out of it.
          ...(nodeSupportsTestCoverageExclude() ? ["--test-coverage-exclude=**/test/**"] : []),
        ]
      : []),
    ...sel.files,
  ];
}

/** The `--affected` selection: the gating files test/affected-tests.ts finds the change since its
 * merge-base with `ref` can reach, announced in one line. Unbudgeted, whatever cannot be decided
 * (git cannot answer, or a change the selector will not map) announces why and selects the full
 * suite, the safe answer for a pre-check. Under `budgetMs` the run keeps the nearest files that
 * fit (fitBudget), priced by this build's durations ledger; an undecidable change makes every
 * file a candidate, cheapest first. The announcement names the left-out files nearest the
 * change, so an agent knows which to run by hand. */
function affectedTestFiles(distDir: string, ref: string, budgetMs: number | undefined): TestFileSelection {
  const full = selectTestFiles([], distDir);
  if (full.error) return full;
  const distRoot = path.dirname(distDir);
  const repoRoot = path.dirname(distRoot);
  const changed = changedSinceBase(repoRoot, ref);
  const graph = buildDepGraph(distRoot, repoRoot);
  const pick = "error" in changed ? { tests: graph.tests, distance: new Map<string, number>(), reason: changed.error } : selectAffected(graph, changed.files);
  const stem = (name: string) => path.basename(name).replace(/\.[jt]sx?$/, "");
  const keep = (tests: readonly string[]): TestFileSelection => {
    const wanted = new Set(tests.map(stem));
    const kept = full.names.map((name, i) => ({ name, file: full.files[i]! })).filter((n) => wanted.has(stem(n.name)));
    return { names: kept.map((n) => n.name), files: kept.map((n) => n.file) };
  };
  const count = "files" in changed ? changed.files.length : 0;
  if (budgetMs === undefined) {
    if (pick.reason !== undefined) {
      console.log(`affected tests: ${pick.reason}; running the full suite`);
      return full;
    }
    const kept = keep(pick.tests);
    console.log(`affected tests: ${kept.files.length} of ${full.files.length} test files reach the ${count} changed file(s) since ${ref}`);
    return kept;
  }
  const durations = readJsonFile<Record<string, number>>(durationsPath(distDir)) ?? {};
  const costMs = (test: string) =>
    finiteNumber(durations[`${stem(test)}.js`], UNTIMED_TEST_FILE_MS) + PER_FILE_OVERHEAD_MS;
  const { run, left } = fitBudget(pick, costMs, budgetMs);
  const kept = keep(run);
  const near = left.filter((t) => (pick.distance.get(t) ?? Infinity) <= 1);
  const named = near
    .slice(0, LEFT_OUT_NAMED)
    .map((t) => `${path.basename(t)} (~${Math.round(costMs(t) / 1000)}s)`)
    .join(", ");
  const more = near.length > LEFT_OUT_NAMED ? ` and ${near.length - LEFT_OUT_NAMED} more` : "";
  const scope =
    pick.reason === undefined
      ? `${kept.files.length} of the ${pick.tests.length} test files that reach the ${count} changed file(s) since ${ref}`
      : `${pick.reason}, so every test file is a candidate: ${kept.files.length} of ${pick.tests.length}`;
  console.log(
    `affected tests: ${scope} fit the ${budgetMs / 1000}s budget, nearest first; main's full check runs the rest` +
      (named === "" ? "" : `. Left out near the change: ${named}${more}`),
  );
  return kept;
}

async function main(): Promise<void> {
  const { rest: unbudgeted, ref } = splitAffectedArgv(process.argv.slice(2));
  const { rest, budgetMs, error: budgetError } = splitBudgetArgv(unbudgeted);
  const { filters: allFilters, coverage } = splitCoverageArgv(rest);
  const { rest: filters, repeat, error: repeatError } = splitRepeatArgv(allFilters);
  for (const error of [budgetError, repeatError]) {
    if (error === undefined) continue;
    process.stderr.write(`tumwater: ${error}\n`);
    process.exit(1);
  }
  const distDir = defaultDistDir();
  if (ref !== undefined && (filters.length > 0 || coverage || repeat !== undefined)) {
    process.stderr.write(
      "tumwater: --affected picks its own test files; it takes no filters, no --coverage and no --repeat\n",
    );
    process.exit(1);
  }
  if (ref === undefined && budgetMs !== undefined) {
    process.stderr.write("tumwater: --budget applies to an --affected run only\n");
    process.exit(1);
  }
  const sel = ref === undefined ? selectTestFiles(filters, distDir) : affectedTestFiles(distDir, ref, budgetMs);
  if (sel.error) {
    process.stderr.write(`tumwater: ${sel.error}\n`);
    process.exit(1);
  }
  // node --test with no files would discover tests on its own, so an empty selection stops here.
  if (sel.files.length === 0) {
    console.log("affected tests: none to run");
    process.exit(0);
  }
  // One line of what is about to run — only on the filtered path; the unfiltered suite keeps
  // byte-identical output for the harness's build gate.
  const nameEcho = (sel.nameFilters ?? []).join(" or ");
  if (filters.length > 0)
    console.log(
      `running ${sel.names.length} test file(s)${nameEcho ? ` (tests matching ${nameEcho})` : ""}: ${sel.names.join(", ")}`,
    );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-suite-"));
  const fresh = path.join(scratch, "durations.json");
  const tap = path.join(scratch, "tap.out");
  // The deterministic coverage table needs the suite's raw V8 dumps; capture them in the scratch
  // dir — but only when the caller brought no NODE_V8_COVERAGE of its own, whose dumps belong to
  // the caller's pipeline (docs/code-metrics/run.sh maps them with coverage.cjs after the run).
  const covDir = coverage && !process.env.NODE_V8_COVERAGE ? path.join(scratch, "v8cov") : undefined;
  const reporter = fileURLToPath(new URL("./test-durations-reporter.js", import.meta.url));
  let status: number;
  try {
    const args = buildNodeTestArgs(
      { ...sel, files: orderByDuration(sel.files, readJsonFile<Record<string, number>>(durationsPath(distDir)) ?? {}) },
      // A pure e2e tier serializes its files (one worker at a time) on a node that knows
      // --test-concurrency, so a loaded host cannot stretch one file's waits against its siblings;
      // the unit suite and a mixed selection keep today's argv.
      {
        reporter,
        fresh,
        tap,
        coverage,
        concurrency: isE2eTier(sel.files)
          ? nodeSupportsTestConcurrency()
            ? 1
            : undefined
          : await sharedSuiteConcurrency(),
      },
    );
    const runOnce = (): number => {
      const env = suiteEnv(scratch);
      if (covDir) env.NODE_V8_COVERAGE = covDir;
      const r = spawnSync(process.execPath, args, { stdio: "inherit", env, timeout: SUITE_TIMEOUT_MS });
      const killed = timedOutFailure(r);
      let status = killed !== null ? 1 : (r.status ?? 1);
      if (killed !== null) process.stderr.write(`tumwater: ${killed}\n`);
      // A killed run leaves the durations file missing or partial — keep earlier runs' records.
      // A coverage run skips the ledger: instrumentation slows every file, and recording the
      // skewed times would skew later runs' ordering.
      else if (!coverage && repeat === undefined) recordDurations(distDir, fresh);
      // A pattern matching nothing exits 0 — node sees a green run of file wrappers — so the
      // guard, not the exit code, catches the typo'd filter. Only a green run needs guarding.
      if (sel.namePattern && status === 0) {
        const miss = noNameMatchReason(tap, sel.nameFilters ?? []);
        if (miss !== null) {
          process.stderr.write(`tumwater: ${miss}\n`);
          status = 1;
        }
      }
      return status;
    };
    const result = repeatRuns(repeat ?? 1, runOnce);
    status = result.status;
    if (repeat !== undefined)
      console.log(
        result.failedAt === undefined
          ? `repeat: ${result.runs} of ${repeat} runs passed`
          : `repeat: run ${result.failedAt} of ${repeat} failed`,
      );
    // After node's own (flaky) table: the deterministic reading, from the dumps the run wrote.
    if (covDir) printCoverageTable(covDir, path.dirname(distDir));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(status);
}

// Run main() only when this file is the program node was started with — not when a test
// imports it (then argv[1] is the test file and spawning node --test here would recurse).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void main();
