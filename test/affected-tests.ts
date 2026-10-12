import fs from "node:fs";
import path from "node:path";

/** Affected-test selection for `npm run test:gate`, the review gate's per-change pre-check
 * (`check.gateCommand`, DEVELOPMENT.md "The gate runs the affected tests"). The fleet ran the
 * whole suite before every model review, ~200 times a day, while most changes touch a handful of
 * modules. This picks the compiled test files a change can reach. The full suite still runs
 * once per landing (the in-lock and batch checks run `npm test`), so a dependency this misses
 * costs a later rejection, never a red main.
 *
 * The graph is read from the compiled tree (plus scripts/ and the docs' .cjs tools), not from
 * TypeScript, so it is always the graph of the code about to run. A module depends on what it
 * imports (static, side-effect, literal dynamic imports and `require`) and on every file it
 * names through `new URL("…", import.meta.url)`: that is how the suite reaches the fixture shim,
 * the scripts and the docs it reads. A URL naming a directory, or built from a template literal,
 * depends on everything under its static prefix, and a script that derives paths from its own
 * location depends on all of src/. Tests that read directories or derive paths from
 * `import.meta` themselves can scan the tree (layering, plan citations, exports), so they run
 * whenever any code changes.
 *
 * The CLI is the one dependency resolved per call site. src/cli.ts imports each command's module
 * only inside that command's case, and ~70 test files reach the binary through
 * test/helpers/cli-harness.ts. Depending on the binary as a whole would select all of them for
 * nearly any change in src/. So cli.ts contributes only its static imports, and a file calling
 * the harness (`cli(dir, "logs")`, `spawnCli(dir, ["run"])`, `[CLI, "status"]`) depends on the
 * modules of the commands it names. A call whose command is not a literal, and any other path to
 * the binary, depends on every command.
 *
 * What cannot be mapped is not guessed at. A changed file that is neither code, nor named by any
 * module, nor documentation or lint configuration, and every change to the build and test
 * machinery (FULL_SUITE_FILES), selects the full suite. All of it is pure over a file tree, so
 * test/affected-tests.test.ts pins the rules on a synthetic tree without git. */

/** Changes that can move any test's outcome: dependencies, compiler settings, and the runner
 * and this selector themselves. */
const FULL_SUITE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".npmrc",
  "test/test-runner.ts",
  "test/test-durations-reporter.ts",
  "test/affected-tests.ts",
]);

/** Files only the linter reads: `test:gate` lints the whole tree on every run, so a change to
 * one selects no tests. */
const LINT_ONLY_FILES = new Set(["eslint.config.js"]);

/** Documentation: a change to one that no module names cannot reach a test. */
function isDoc(file: string): boolean {
  return file.endsWith(".md") || file.startsWith("docs/");
}

/** Source code the compiled tree is built from. */
function isCode(file: string): boolean {
  return /^(?:src|test)\/.+\.tsx?$/.test(file);
}

/** A test file the gate may select: the unit tier, never `*.e2e.test.ts` (test-runner.ts keeps that
 * tier out of the gating run). */
function isGatingTest(file: string): boolean {
  return /^test\/[^/]+\.test\.tsx?$/.test(file) && !/\.e2e\.test\.tsx?$/.test(file);
}

/** Reading a directory, or resolving a path from the module's own location, is how a test scans
 * the tree instead of importing from it. */
const SCANS_TREE = /\breaddirSync\b|import\.meta\.(?:dirname|filename)|fileURLToPath\(import\.meta\.url\)/;

/** A script locating files relative to itself. */
const SELF_LOCATING = /import\.meta\.(?:url|dirname|filename)|__dirname|__filename/;

const CLI_ENTRY = "src/cli.ts";
const CLI_HARNESS = "test/helpers/cli-harness.ts";
/** The node standing for every command module the CLI can load. */
const ALL_CLI_COMMANDS = "cli:*";

interface DepGraph {
  /** Id → ids it depends on. Ids are repo-relative source paths (`src/git/git.ts`,
   * `scripts/release.mjs`) or `cli:<command>` nodes for the modules one CLI command loads. */
  deps: Map<string, Set<string>>;
  /** Id → repo-relative directory prefixes (ending "/", or "" for the whole repository) it
   * depends on wholesale. */
  prefixDeps: Map<string, Set<string>>;
  /** Gating test files that scan the tree (SCANS_TREE). */
  scanners: Set<string>;
  /** Every gating test file in the compiled tree, by source id, sorted. */
  tests: string[];
}

/** The repo-relative id of `abs`: a compiled `dist/<x>.js` maps back to the `<x>.ts` (or `.tsx`)
 * it was built from, anything else to its own repo-relative path. A directory keeps a trailing
 * "/" so it reads as a prefix, and the whole repository is "". */
function sourceId(abs: string, distRoot: string, repoRoot: string, isDir: boolean): string {
  const inDist = abs === distRoot || abs.startsWith(distRoot + path.sep);
  const rel = (inDist ? path.relative(distRoot, abs) : path.relative(repoRoot, abs)).split(path.sep).join("/");
  if (isDir) return rel === "" ? "" : `${rel}/`;
  if (inDist && rel.endsWith(".js")) {
    const stem = rel.slice(0, -".js".length);
    return fs.existsSync(path.join(repoRoot, `${stem}.tsx`)) ? `${stem}.tsx` : `${stem}.ts`;
  }
  return rel;
}

function isDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** Every file under `dir` whose name passes `keep`, recursively. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(full, keep));
    else if (keep(e.name)) out.push(full);
  }
  return out;
}

const STATIC_SPECIFIERS = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g];
const DYNAMIC_SPECIFIER = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const URL_LITERAL = /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
const URL_TEMPLATE = /new URL\(\s*`([^`$]*)\$\{[^`]*`\s*,\s*import\.meta\.url\s*\)/g;

/** The top-level argument texts of the call whose `(` is at `open` in `text`, or null when the
 * call does not close. String and template literals and nested brackets are skipped whole. */
function callArgs(text: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const last = text.slice(start, i).trim();
        if (last !== "" || args.length > 0) args.push(last);
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** The command a CLI argument names: a plain string literal's value, the first element of an
 * array literal, `null` for no argument at all (the bare binary prints its help), or undefined
 * when the text is not a literal this can read. */
function literalCommand(arg: string | undefined, inArray: boolean): string | null | undefined {
  if (arg === undefined) return null;
  let text = arg;
  if (inArray) {
    if (!text.startsWith("[")) return undefined;
    const first = callArgs(`(${text.slice(1, -1)})`, 0);
    if (first === null) return undefined;
    if (first.length === 0) return null;
    text = first[0]!;
  }
  const m = /^(["'])([^"'\\]*)\1$/.exec(text);
  return m ? m[2]! : undefined;
}

/** `text` with comments blanked and, with `blankStrings`, the contents of string and template
 * literals too, so a word inside either cannot read as code. Lengths are kept, so an index into
 * the result is an index into `text`. */
function codeOnly(text: string, blankStrings: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 2;
      const stop = end <= 0 || end - 2 < i ? text.length : end;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
      const literal = text.slice(i, j + 1);
      out += blankStrings ? c + literal.slice(1, -1).replace(/[^\n]/g, " ") + (j < text.length ? c : "") : literal;
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

/** The CLI commands `text` (a module that imports the CLI harness) runs, or undefined when one of
 * its uses names no literal command (the module then depends on every command). */
function cliCommandsUsed(text: string): Set<string> | undefined {
  const body = codeOnly(text.replace(/^import\s[^;]*;/gm, (s) => s.replace(/[^\n]/g, " ")), false);
  const identifiers = codeOnly(body, true);
  const used = new Set<string>();
  const calls: Array<[RegExp, number, boolean]> = [
    [/\b(?:cli|runCli)\(/g, 1, false],
    [/\bcliWithEnv\(/g, 2, true],
    [/\bspawnCli\(/g, 1, true],
  ];
  for (const [re, index, inArray] of calls) {
    for (const m of identifiers.matchAll(re)) {
      const args = callArgs(body, m.index + m[0].length - 1);
      if (args === null) return undefined;
      // cli and runCli take their command as a rest argument: an absent one is the bare binary.
      const command = literalCommand(args[index], inArray);
      if (command === undefined) return undefined;
      if (command !== null) used.add(command);
    }
  }
  for (const m of identifiers.matchAll(/\bCLI\b/g)) {
    const after = /^\s*,\s*(["'])([^"'\\]*)\1/.exec(body.slice(m.index + m[0].length));
    const before = body.slice(Math.max(0, m.index - 2), m.index);
    if (!after || !/\[\s*$/.test(before)) return undefined;
    used.add(after[2]!);
  }
  return used;
}

/** The modules each command of the compiled CLI dispatcher imports inside its case, keyed by
 * every label of that case (fallthrough labels share their body's imports). */
function cliCaseImports(text: string, resolve: (spec: string) => string | null): Map<string, Set<string>> {
  const byCommand = new Map<string, Set<string>>();
  const labels = [...text.matchAll(/\bcase\s+"([^"]+)"\s*:/g)];
  let pending: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    const end = i + 1 < labels.length ? labels[i + 1]!.index : text.length;
    const segment = text.slice(label.index + label[0].length, end);
    pending.push(label[1]!);
    const code = segment.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim();
    if (code === "") continue; // falls through to the next label's body
    const modules = new Set<string>();
    for (const m of segment.matchAll(DYNAMIC_SPECIFIER)) {
      const id = resolve(m[1]!);
      if (id !== null) modules.add(id);
    }
    for (const name of pending) byCommand.set(name, modules);
    pending = [];
  }
  return byCommand;
}

/** The dependency graph of the compiled tree under `distRoot` (src/ and test/) plus the
 * repository's scripts/ and docs/ tools, with ids relative to `repoRoot`. */
export function buildDepGraph(distRoot: string, repoRoot: string): DepGraph {
  const deps = new Map<string, Set<string>>();
  const prefixDeps = new Map<string, Set<string>>();
  const scanners = new Set<string>();
  const tests: string[] = [];
  const add = (map: Map<string, Set<string>>, from: string, to: string) => {
    let set = map.get(from);
    if (!set) map.set(from, (set = new Set()));
    set.add(to);
  };
  const files = [
    ...filesUnder(path.join(distRoot, "src"), (n) => n.endsWith(".js")),
    ...filesUnder(path.join(distRoot, "test"), (n) => n.endsWith(".js")),
    ...filesUnder(path.join(repoRoot, "scripts"), (n) => /\.[cm]?js$/.test(n)),
    ...filesUnder(path.join(repoRoot, "docs"), (n) => /\.[cm]?js$/.test(n)),
  ];
  const cliUsers = new Map<string, string>();
  for (const file of files) {
    const id = sourceId(file, distRoot, repoRoot, false);
    const text = fs.readFileSync(file, "utf8");
    const dir = path.dirname(file);
    const compiled = file.startsWith(distRoot + path.sep);
    if (isGatingTest(id)) {
      tests.push(id);
      if (SCANS_TREE.test(text)) scanners.add(id);
    }
    if (!compiled && SELF_LOCATING.test(text)) add(prefixDeps, id, "src/");
    const resolve = (spec: string): string | null =>
      spec.startsWith(".") ? sourceId(path.resolve(dir, spec), distRoot, repoRoot, false) : null;
    const target = (spec: string, template: boolean) => {
      if (!spec.startsWith(".")) return; // a package or node: builtin — package.json covers those
      const abs = path.resolve(dir, spec);
      if (template || spec.endsWith("/") || isDirectory(abs)) {
        const prefixDir = template && !spec.endsWith("/") ? path.dirname(abs) : abs;
        add(prefixDeps, id, sourceId(prefixDir, distRoot, repoRoot, true));
        return;
      }
      const to = sourceId(abs, distRoot, repoRoot, false);
      add(deps, id, to);
      // Any way to the binary other than the harness's call sites runs an unknown command.
      if (to === CLI_ENTRY && id !== CLI_HARNESS) add(deps, id, ALL_CLI_COMMANDS);
      if (to === CLI_HARNESS) cliUsers.set(id, text);
    };
    for (const re of STATIC_SPECIFIERS) for (const m of text.matchAll(re)) target(m[1]!, false);
    for (const m of text.matchAll(URL_LITERAL)) target(m[1]!, false);
    for (const m of text.matchAll(URL_TEMPLATE)) target(m[1]! === "" ? "./" : m[1]!, true);
    if (id === CLI_ENTRY) {
      const byCommand = cliCaseImports(text, resolve);
      for (const [command, modules] of byCommand) {
        for (const m of modules) {
          add(deps, `cli:${command}`, m);
          add(deps, ALL_CLI_COMMANDS, m);
        }
      }
    } else {
      for (const m of text.matchAll(DYNAMIC_SPECIFIER)) target(m[1]!, false);
    }
  }
  for (const [id, text] of cliUsers) {
    const commands = cliCommandsUsed(text);
    if (commands === undefined) add(deps, id, ALL_CLI_COMMANDS);
    else for (const command of commands) add(deps, id, `cli:${command}`);
  }
  tests.sort();
  return { deps, prefixDeps, scanners, tests };
}

/** What a change selects: the gating test files to run (source ids, sorted), or the full suite
 * with the reason. */
type AffectedSelection = { tests: string[]; reason?: undefined } | { tests?: undefined; reason: string };

/** The gating tests `changed` (repo-relative paths, deleted ones included) can reach in `graph`.
 * A full-suite answer names the first change that forced it. */
export function selectAffected(graph: DepGraph, changed: readonly string[]): AffectedSelection {
  const referenced = new Set<string>();
  for (const set of graph.deps.values()) for (const d of set) referenced.add(d);
  const prefixes = new Set<string>();
  for (const set of graph.prefixDeps.values()) for (const p of set) prefixes.add(p);
  const underPrefix = (file: string) => [...prefixes].some((p) => file.startsWith(p));

  const seeds: string[] = [];
  let codeChanged = false;
  for (const file of changed) {
    if (FULL_SUITE_FILES.has(file)) return { reason: `${file} changed` };
    if (isCode(file)) {
      codeChanged = true;
      seeds.push(file);
    } else if (referenced.has(file) || underPrefix(file)) {
      seeds.push(file);
    } else if (!isDoc(file) && !LINT_ONLY_FILES.has(file)) {
      return { reason: `${file} changed, and no test's dependencies name it` };
    }
  }

  const dependents = new Map<string, string[]>();
  for (const [from, set] of graph.deps) {
    for (const to of set) {
      let list = dependents.get(to);
      if (!list) dependents.set(to, (list = []));
      list.push(from);
    }
  }
  const reached = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string) => {
    if (reached.has(id)) return;
    reached.add(id);
    queue.push(id);
  };
  for (const seed of seeds) {
    visit(seed);
    for (const [from, set] of graph.prefixDeps) if ([...set].some((p) => seed.startsWith(p))) visit(from);
  }
  while (queue.length > 0) for (const from of dependents.get(queue.pop()!) ?? []) visit(from);

  return { tests: graph.tests.filter((t) => reached.has(t) || (codeChanged && graph.scanners.has(t))) };
}
