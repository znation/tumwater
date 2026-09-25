import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";

/** Run the compiled unit tests with node:test — the target of package.json's `test` script.
 * With no arguments it runs every dist/test/*.test.js EXCEPT the `*.e2e.test.js` tier — the
 * live-orchestrator cases, whose wall-clock waits a loaded machine can blow and which then
 * reject whatever commit is being gated instead of the code under test (BUGS.md 2026-09-21);
 * they run via `npm run test:e2e` (and in CI) instead. With one or more name filters it runs
 * only the test files whose source-style name contains a filter as a plain substring (`npm test
 * merge` → merge.test.ts), so iterating on one module gets a few-second feedback loop instead
 * of the full suite — filters match e2e files too, so `npm test orchestrator` or
 * `npm run test:e2e` deliberately brings the tier back. A filter that matches nothing is an
 * error listing what exists, and node --test's exit code always propagates, so both humans and
 * the gate can rely on it. Files start longest-first by the durations earlier runs recorded
 * (orderByDuration), and the run gets a git-cheap environment (suiteEnv). The selection and
 * ordering logic is pure and exported (selectTestFiles, orderByDuration) so
 * test/test-runner.test.ts pins its rules without spawning anything; the spawn lives in main()
 * behind an import guard, because this module is imported by that very test file and a
 * top-level run would recurse into node --test. */

/** What selectTestFiles decided: which compiled files to run (and their source-style names for
 * messages), or why nothing could be selected. */
interface TestFileSelection {
  /** Basenames with the .js swapped for .ts — what a developer sees in test/ and types as a filter. */
  names: string[];
  /** Absolute paths of the compiled files to hand to node --test, sorted by name. */
  files: string[];
  /** Set when nothing could be selected (no dist/test dir, no *.test.js in it, or no filter match). */
  error?: string;
}

/** The e2e tier: files whose name carries `.e2e.` are excluded from the unfiltered (gating)
 * run — they are the live-orchestrator cases whose fixed wall-clock budgets are not reliable
 * under machine load (BUGS.md 2026-09-21) — and are selected only by an explicit filter. */
const E2E_PATTERN = /\.e2e\.test\.js$/;

/** Pick which compiled test files under `distDir` to run. No filters → every file except the
 * `.e2e.test.js` tier (run that via `npm run test:e2e`). Otherwise a file is selected when its
 * source-style name contains at least one filter as a plain substring (no regex, case-sensitive
 * — `loop` selects both loop.test.ts and loop-2.test.ts); e2e files are filterable like any
 * other. Non-test files in the directory are ignored. */
export function selectTestFiles(filters: readonly string[], distDir: string): TestFileSelection {
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
  const picked =
    filters.length === 0
      ? named.filter((n) => !E2E_PATTERN.test(n.file))
      : named.filter((n) => filters.some((fl) => n.name.includes(fl)));
  if (picked.length === 0)
    return {
      names: [],
      files: [],
      error: `no test file matches ${filters.map((f) => JSON.stringify(f)).join(" or ")} — available: ${named
        .map((n) => n.name)
        .join(", ")}`,
    };
  return { names: picked.map((n) => n.name), files: picked.map((n) => n.file) };
}

/** The compiled test directory this build's tests live in (dist/test, sibling of dist/src). */
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
    return typeof ms === "number" && Number.isFinite(ms) ? ms : Infinity;
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

/** The first executable named `name` on `pathVar`, as execvp would pick it — or undefined. */
function whichOnPath(name: string, pathVar: string): string | undefined {
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here — keep walking.
    }
  }
  return undefined;
}

/** Build the suite's environment in `scratch` (a directory the caller removes after the run):
 * suiteGitEnv's config, an empty GIT_TEMPLATE_DIR (every `git init` otherwise copies the
 * sample hooks), and on macOS a way around the xcode-select shim. /usr/bin/git there is a
 * stub that re-resolves the developer directory on every call before exec'ing the real git —
 * ~10 ms extra per spawn, roughly tripling what each git call costs. When the first git on
 * PATH is that stub, a symlink to the real binary (`xcrun --find git`, the same file the stub
 * would exec) goes first on PATH instead. Any other git — Linux, Homebrew — is left alone. */
function suiteEnv(scratch: string): NodeJS.ProcessEnv {
  const env = suiteGitEnv(process.env);
  const templates = path.join(scratch, "git-templates");
  fs.mkdirSync(templates);
  env.GIT_TEMPLATE_DIR = templates;
  if (process.platform === "darwin" && whichOnPath("git", env.PATH ?? "") === "/usr/bin/git") {
    const found = spawnSync("xcrun", ["--find", "git"], { encoding: "utf8" });
    const real = found.status === 0 ? found.stdout.trim() : "";
    if (real && path.isAbsolute(real) && real !== "/usr/bin/git" && fs.existsSync(real)) {
      const bin = path.join(scratch, "bin");
      fs.mkdirSync(bin);
      fs.symlinkSync(real, path.join(bin, "git"));
      env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`;
    }
  }
  return env;
}

function main(): void {
  const filters = process.argv.slice(2);
  const distDir = defaultDistDir();
  const sel = selectTestFiles(filters, distDir);
  if (sel.error) {
    process.stderr.write(`tumwater: ${sel.error}\n`);
    process.exit(1);
  }
  // One line of what is about to run — only on the filtered path; the unfiltered suite keeps
  // byte-identical output for the harness's build gate.
  if (filters.length > 0) console.log(`running ${sel.names.length} test file(s): ${sel.names.join(", ")}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-suite-"));
  const fresh = path.join(scratch, "durations.json");
  const reporter = fileURLToPath(new URL("./test-durations-reporter.js", import.meta.url));
  const files = orderByDuration(sel.files, readJsonFile<Record<string, number>>(durationsPath(distDir)) ?? {});
  let status: number;
  try {
    // spec to stdout is node's default output, named explicitly because a second reporter
    // (the durations one, into scratch) would otherwise replace it.
    const args = [
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      `--test-reporter=${reporter}`,
      `--test-reporter-destination=${fresh}`,
      ...files,
    ];
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env: suiteEnv(scratch) });
    status = r.status ?? 1;
    recordDurations(distDir, fresh);
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
