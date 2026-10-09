import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { printCoverageTable } from "./coverage-table.js";
import { findOnPath } from "../src/files/files.js";
import { readJsonFile, writeJsonAtomic } from "../src/files/json-files.js";
import { finiteNumber } from "../src/files/json-object.js";
import { realGitFromXcrun } from "../src/git/xcrun-git.js";
import { SUPERVISED_ENV } from "../src/process/supervisor.js";
import { DASHBOARD_CHILD_ENV } from "../src/redeploy/self-reload.js";
import { typoSuffix } from "../src/text/suggest.js";

/** Run the compiled unit tests with node:test — the target of package.json's `test` script.
 * With no arguments it runs every dist/test/*.test.js EXCEPT the `*.e2e.test.js` tier — the
 * live-orchestrator cases, whose wall-clock waits a loaded machine can blow and which then
 * reject whatever commit is being gated instead of the code under test (BUGS.md 2026-09-21);
 * they run via `npm run test:e2e` (and in CI) instead. With one or more name filters it runs
 * only the test files whose source-style name contains a filter as a plain substring (`npm test
 * merge` → landing-merge.test.ts), so iterating on one module gets a few-second feedback loop instead
 * of the full suite — filters match e2e files too, so `npm test orchestrator` or
 * `npm run test:e2e` deliberately brings the tier back. A filter may carry a `#name` part
 * (`npm test 'loop#resume'`), which additionally filters the individual tests inside the selected
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
 * slows every file, and recording those skewed times would skew later runs' ordering. Node's table
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
 * start the suite over a guard flag. Returns null for every outcome spawnSync reports without
 * a timeout kill (a green run, node --test's own failures, an externally signalled child).
 * Exported for test/test-runner.test.ts to pin against a real spawnSync kill. */
export function timedOutFailure(r: { status: number | null; signal: NodeJS.Signals | null; error?: unknown }): string | null {
  if (!(r.status === null && (r.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT")) return null;
  return `the test suite exceeded its ${SUITE_TIMEOUT_MS / 60_000}-minute ceiling and was killed — a test hangs or ` +
    `leaves the event loop alive; bisect with npm test '<file filter>' or a "#name" filter (npm test 'loop#resume')`;
}

/** What selectTestFiles decided: which compiled files to run (and their source-style names for
 * messages), or why nothing could be selected. */
interface TestFileSelection {
  /** Basenames with the .js swapped for .ts — what a developer sees in test/ and types as a filter. */
  names: string[];
  /** Absolute paths of the compiled files to hand to node --test, sorted by name. */
  files: string[];
  /** Set when nothing could be selected (no dist/test dir, no *.test.js in it, or no filter match). */
  error?: string;
  /** The `#name` parts of the filters, escaped and ORed into one node --test
   * --test-name-pattern (regex) value; undefined when no filter carried one. */
  namePattern?: string;
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
const E2E_PATTERN = /\.e2e\.test\.js$/;

/** Pick which compiled test files under `distDir` to run. No filters → every file except the
 * `.e2e.test.js` tier (run that via `npm run test:e2e`). Otherwise a file is selected when its
 * source-style name contains at least one filter as a plain substring (no regex, case-sensitive
 * — `loop` selects both loop.test.ts and loop-2.test.ts); e2e files are filterable like any
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
  for (const raw of filters) {
    if (parseFilter(raw).name === "")
      return {
        names: [],
        files: [],
        error: `a "#" must be followed by the test name to run, as in loop#resume (got ${JSON.stringify(raw)})`,
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
    ? named.filter((n) => !E2E_PATTERN.test(n.file))
    : named.filter((n) => parsed.some((p) => p.file !== "" && n.name.includes(p.file)));
  if (picked.length === 0) {
    // A near-miss filter gets the shared did-you-mean every other unknown-value error
    // carries, computed against each file's stem (the substring a developer usually types,
    // `loop` for loop.test.ts) as well as its full source-style name — the listing alone
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
    ...(nameParts.length === 0 ? {} : { namePattern: nameParts.map(escapeNamePattern).join("|") }),
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
 * The harness's variables: a fleet's build checks and pi tool calls run with the harness's own
 * environment, so a suite they start inherits what the operator exported, the supervisor set,
 * and the tick's own run exported, while a suite run by hand does not. Each one the harness
 * resolves out of the environment is dropped here, so a suite a tick starts exercises exactly
 * what a hand-run suite does:
 * - TUMWATER_PI_BIN outranks PATH in resolveAgentBin, so an operator's override (a wrapper
 *   around the real pi, plans/portability.md) displaced every fake pi the suite puts on PATH:
 *   the fake-pi tests ran the agent it named (BUGS.md 2026-09-28). Tests of the variable set it
 *   themselves; test/fakes/fake-pi.ts drops it too, for a file run directly with `node --test`.
 * - SUPERVISED_ENV marks the orchestrator child, so a `tumwater run` that inherits it skips its
 *   supervisor half. test/helpers/cli-harness.ts also drops it from every CLI child it starts.
 * - TUMWATER_NOTES_PATH makes the bundled role-notes extension register the `role_notes` tool,
 *   so a non-authoring run that inherited a tick's notebook path would carry a tool the run's
 *   own contract says it must not have (test/loop-pi.test.ts pins the empty env line).
 * - TUMWATER_RUN names the outer run a nested run's stamp is appended to (run-marker.ts), so an
 *   inherited mark made a spawned run's sweep read the suite's own process tree.
 * - DASHBOARD_CHILD_ENV makes reexecSelf exit its restart code instead of supervising, so an
 *   inherited mark changed the reload tests' branch through the ambient environment.
 * NODE_OPTIONS is kept: the LaunchServices preload the harness adds there only changes where
 * process.title is stored (the suite's assertions about it hold either way), and it carries the
 * operator's own Node flags. */
export function suiteEnv(scratch: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = suiteGitEnv(base);
  delete env.TUMWATER_PI_BIN;
  delete env[SUPERVISED_ENV];
  delete env.TUMWATER_NOTES_PATH;
  delete env.TUMWATER_RUN;
  delete env[DASHBOARD_CHILD_ENV];
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
  return env;
}

/** Detect a `#name` filter that matched nothing, from the TAP side-channel the run wrote to
 * `tap`: TAP records one `ok`/`not ok` line per thing the run executed, and node --test names a
 * file whose tests all miss the pattern by the file itself (`ok 1 - loop.test.js`) while matched
 * tests and their parent describes carry their own names. So when every ok line names a compiled
 * test file, nothing inside any file ran — the filter passed an empty suite, which must fail
 * loudly (a silent green run would read as verified work that never executed). Returns the
 * failure reason, or null when something matched — or when no TAP was written (a crashed run's
 * exit code already reports that; this guard only speaks for a green-but-empty run).
 * Exported for test/test-runner.test.ts to pin without spawning node --test. */
export function noNameMatchReason(tapPath: string): string | null {
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
  return 'no test name matches the "#name" filter — the selected file(s) ran empty; check the spelling after "#"';
}

/** Split the runner's argv into its filters and its coverage mode: `--coverage` selects the
 * mode wherever it appears and is removed from the filters, so it composes with every filter
 * form (`--coverage loop`, `loop --coverage`, `--coverage 'loop#resume'`). Exported for
 * test/test-runner.test.ts to pin the split without spawning the runner. */
export function splitCoverageArgv(argv: readonly string[]): { filters: string[]; coverage: boolean } {
  return { filters: argv.filter((a) => a !== "--coverage"), coverage: argv.includes("--coverage") };
}

/** Whether this node knows `--test-coverage-exclude`: the flag arrived in v22.5.0, above the
 * package's >=20.3 engines floor, so a supported node must never be handed it. Exported for
 * test/test-runner.test.ts to pin the boundary. */
export function nodeSupportsTestCoverageExclude(version: string = process.versions.node): boolean {
  const [major, minor] = version.split(".").map((p) => Number.parseInt(p, 10));
  if (major === undefined || minor === undefined) return false;
  return major > 22 || (major === 22 && minor >= 5);
}

/** The node --test argv main() spawns, built from a selection: node's default spec reporter to
 * stdout (named explicitly because a second reporter would otherwise replace it), the durations
 * reporter into `fresh`, the #name pattern and its TAP side-channel reporter when the selection
 * carries a name pattern, the files themselves in the caller's order, and — under `coverage` —
 * node's coverage flags, so the run ends with the coverage table. Exported pure so
 * test/test-runner.test.ts pins the flags without spawning a suite. */
export function buildNodeTestArgs(
  sel: { files: readonly string[]; namePattern?: string },
  opts: { reporter: string; fresh: string; tap?: string; coverage?: boolean },
): string[] {
  return [
    "--test",
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

function main(): void {
  const { filters, coverage } = splitCoverageArgv(process.argv.slice(2));
  const distDir = defaultDistDir();
  const sel = selectTestFiles(filters, distDir);
  if (sel.error) {
    process.stderr.write(`tumwater: ${sel.error}\n`);
    process.exit(1);
  }
  // One line of what is about to run — only on the filtered path; the unfiltered suite keeps
  // byte-identical output for the harness's build gate.
  if (filters.length > 0)
    console.log(
      `running ${sel.names.length} test file(s)${sel.namePattern ? ` (tests matching ${sel.namePattern})` : ""}: ${sel.names.join(", ")}`,
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
      { reporter, fresh, tap, coverage },
    );
    const env = suiteEnv(scratch);
    if (covDir) env.NODE_V8_COVERAGE = covDir;
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env, timeout: SUITE_TIMEOUT_MS });
    const killed = timedOutFailure(r);
    status = killed !== null ? 1 : (r.status ?? 1);
    if (killed !== null) process.stderr.write(`tumwater: ${killed}\n`);
    // A killed run leaves the durations file missing or partial — keep earlier runs' records.
    // A coverage run skips the ledger: instrumentation slows every file, and recording the
    // skewed times would skew later runs' ordering.
    else if (!coverage) recordDurations(distDir, fresh);
    // A pattern matching nothing exits 0 — node sees a green run of file wrappers — so the
    // guard, not the exit code, catches the typo'd filter. Only a green run needs guarding.
    if (sel.namePattern && status === 0) {
      const miss = noNameMatchReason(tap);
      if (miss !== null) {
        process.stderr.write(`tumwater: ${miss}\n`);
        status = 1;
      }
    }
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
if (invokedDirectly) main();
