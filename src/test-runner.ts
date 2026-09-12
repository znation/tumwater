import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Run the compiled unit tests with node:test — the target of package.json's `test` script.
 * With no arguments it runs every dist/test/*.test.js exactly as the old inline
 * `node --test 'dist/test/*.test.js'` did (the harness's build gate relies on that unchanged
 * behavior); with one or more name filters it runs only the test files whose source-style name
 * contains a filter as a plain substring (`npm test merge` → merge.test.ts), so iterating on
 * one module gets a few-second feedback loop instead of the full ~40 s suite. A filter that
 * matches nothing is an error listing what exists, and node --test's exit code always
 * propagates, so both humans and the gate can rely on it. The selection logic is pure and
 * exported (selectTestFiles) so test/test-runner.test.ts pins its matching rules without
 * spawning anything; the spawn lives in main() behind an import guard, because this module is
 * imported by that very test file and a top-level run would recurse into node --test. */

/** What selectTestFiles decided: which compiled files to run (and their source-style names for
 * messages), or why nothing could be selected. */
export interface TestFileSelection {
  /** Basenames with the .js swapped for .ts — what a developer sees in test/ and types as a filter. */
  names: string[];
  /** Absolute paths of the compiled files to hand to node --test, sorted by name. */
  files: string[];
  /** Set when nothing could be selected (no dist/test dir, no *.test.js in it, or no filter match). */
  error?: string;
}

/** Pick which compiled test files under `distDir` to run. No filters → every file. Otherwise a
 * file is selected when its source-style name contains at least one filter as a plain substring
 * (no regex, case-sensitive — `loop` selects both loop.test.ts and loop-2.test.ts). Non-test
 * files in the directory are ignored. */
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
    filters.length === 0 ? named : named.filter((n) => filters.some((fl) => n.name.includes(fl)));
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

function main(): void {
  const filters = process.argv.slice(2);
  const sel = selectTestFiles(filters, defaultDistDir());
  if (sel.error) {
    process.stderr.write(`tumwater: ${sel.error}\n`);
    process.exit(1);
  }
  // One line of what is about to run — only on the filtered path; the unfiltered suite keeps
  // byte-identical output for the harness's build gate.
  if (filters.length > 0) console.log(`running ${sel.names.length} test file(s): ${sel.names.join(", ")}`);
  const r = spawnSync(process.execPath, ["--test", ...sel.files], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// Run main() only when this file is the program node was started with — not when a test
// imports it (then argv[1] is the test file and spawning node --test here would recurse).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
