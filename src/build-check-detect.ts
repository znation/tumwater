import fs from "node:fs";
import path from "node:path";
import { isJsonObject } from "./json-object.js";

/** Detection of a project's declared deterministic build check: where the check lives (the
 * installed root a walk-up from a bare worktree finds) and which npm script it names. Split
 * out of build-check.ts — which keeps running and classifying the check — because this is a
 * pure filesystem concern with no subprocess in sight, and its consumers divide the same
 * way: doctor.ts and main-baseline.ts only detect, build-stage.ts only needs the sibling
 * node_modules walk-up to resolve a toolchain binary, and none of them should import the
 * execution machinery to get it. The walk-up algorithm and its WALK_UP_LEVELS bound are
 * shared by both exported walks (and the one npm's run-script PATH walk makes). */

/** The project's declared deterministic check. Two shapes: the npm auto-detection (an npm
 * script name plus the directory whose package.json declares it — the walk-up target holding
 * both package.json and node_modules) and a configured `check.command` (plans/portability.md
 * §6/7) run through a shell, in the worktree, under its own timeout. */
export type BuildCheck =
  | {
      kind: "npm";
      /** Directory holding the qualifying package.json + node_modules. */
      rootDir: string;
      /** The npm script to run — `test` preferred, then `typecheck`, else `build`. */
      script: string;
    }
  | {
      kind: "command";
      /** The shell command verbatim (often compound: "cargo fmt --check && cargo test"). */
      command: string;
      /** Working directory for the run, resolved against the worktree the detection started
       * from (`cwd` in config, default ".") — the command verifies that tree, not main. */
      cwd: string;
      /** Hard cap on the run, in ms — `check.timeoutSeconds` × 1000, else the shared 300 s. */
      timeoutMs: number;
    };

/** Hard cap on one build check run — a hung script (watch mode) must not wedge the tick, and
 * a timeout is environmental, never fail-closed. The default `check.timeoutSeconds` resolves
 * to this (via ms in detectBuildCheck); build-check.ts re-exports it as runBuildCheck's
 * default timeout parameter so tests can shorten it. */
export const BUILD_CHECK_TIMEOUT_MS = 300_000;

/** How many ancestors a walk-up may climb before giving up. Five covers every layout the
 * harness sees — a tumwater worktree sits three levels under the install
 * (`<repo>/.tumwater/worktrees/<role>`) — while stopping a stray temp directory from wandering
 * into an unrelated project further up. Shared by both walk-ups below. */
const WALK_UP_LEVELS = 5;

/** True when `dir` holds both a package.json and a node_modules/ directory — the structural
 * signature of an installed JS project root. */
function hasInstall(dir: string): boolean {
  try {
    fs.statSync(path.join(dir, "package.json"));
    return fs.statSync(path.join(dir, "node_modules")).isDirectory();
  } catch {
    return false;
  }
}

/** Read the check script from `dir`'s package.json: prefer test — npm convention makes
 * `npm test` the canonical verify command — then typecheck, then build; null when none is
 * present or the file cannot be read/parsed (detection never throws). For tumwater itself
 * `test` subsumes `build`: its script runs `npm run build && node --test …`, so one gate run
 * verifies both. */
function buildCheckFrom(dir: string): BuildCheck | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null; // Missing/unreadable/malformed — no check.
  }
  // JSON.parse("null") SUCCEEDS and yields null, and reading `.scripts` off null throws a
  // TypeError straight out of detection — which every caller's contract (detectBuildCheck,
  // checkMainBaseline, runScopedBuildCheck) promises cannot happen. A scalar or array is the
  // same "not a package.json" case: it declares no scripts either way.
  if (!isJsonObject(pkg)) return null;
  const scripts = pkg.scripts;
  if (!isJsonObject(scripts)) return null;
  const s = scripts;
  if (isCheckScript(s, "test")) return { kind: "npm", rootDir: dir, script: "test" };
  if (isCheckScript(s, "typecheck")) return { kind: "npm", rootDir: dir, script: "typecheck" };
  if (isCheckScript(s, "build")) return { kind: "npm", rootDir: dir, script: "build" };
  return null;
}

/** True when `s[key]` names a runnable check script: a string with non-whitespace content.
 * A whitespace-only value passes a bare string check but is NOT a usable check — `npm run
 * <script>` executes it as a no-op that exits 0, so the deterministic pre-check would read
 * "passed" on a tree it never verified (a false green at both the review gate and the red-main
 * baseline). Blank values fall through to the next script, exactly like the empty-string case. */
function isCheckScript(s: Record<string, unknown>, key: string): boolean {
  const v = s[key];
  return typeof v === "string" && v.trim() !== "";
}

/** Walk UP from `startDir` — at most `maxLevels` ancestors, starting with `startDir`
 * itself — calling `visit` on each directory and returning the first non-null result; null
 * when no level qualifies or the filesystem root is reached. The shared climb of both
 * walk-ups in this file (and the one npm's run-script PATH walk makes). */
function walkUp<T>(startDir: string, maxLevels: number, visit: (dir: string) => T | null): T | null {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level++) {
    const found = visit(dir);
    if (found !== null) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break; // Filesystem root reached.
    dir = parent;
  }
  return null;
}

/** Find the project's deterministic check from `startDir` — at most `maxLevels` ancestors
 * (default 5) — to the nearest directory containing BOTH a package.json and a node_modules/
 * directory, then preferring scripts.test over scripts.typecheck and scripts.build (npm
 * convention: `test` is the canonical verify command). A configured `check.command`
 * (plans/portability.md §6/7) wins first: the right way to verify a repo is a property of
 * the repo, and the walk cannot know it — a Python, Rust, or Go repo has no npm install for
 * the walk to find, which silently turned every safety gate off there. `config`'s `check`
 * shape is the validated CheckConfig (src/types.ts) read structurally so detection needs no
 * import of the config machinery; a blank command (validation rejects one, but a degraded
 * default config could still carry it) falls through to the walk-up.
 * The walk is required: tumwater worktrees live under `<repo>/.tumwater/worktrees/<role>`
 * with no install of their own (node_modules is gitignored — it exists only where someone
 * ran npm install), so a literal startDir check would silently disable the pre-check forever
 * in dogfood. The FIRST qualifying directory is the project: if its package.json has neither
 * script, there is no check (an unrelated ancestor further up must never be used). Returns
 * null when no ancestor qualifies or the file is missing/unreadable/malformed — detection
 * never throws into the gate. */
export function detectBuildCheck(
  startDir: string,
  config?: { check?: { command: string; cwd?: string; timeoutSeconds?: number } },
  maxLevels = WALK_UP_LEVELS,
): BuildCheck | null {
  const c = config?.check;
  if (c && typeof c.command === "string" && c.command.trim() !== "") {
    const seconds = typeof c.timeoutSeconds === "number" && c.timeoutSeconds > 0 ? c.timeoutSeconds : BUILD_CHECK_TIMEOUT_MS / 1000;
    return {
      kind: "command",
      command: c.command,
      cwd: path.resolve(startDir, typeof c.cwd === "string" && c.cwd.trim() !== "" ? c.cwd : "."),
      timeoutMs: seconds * 1000,
    };
  }
  const root = walkUp(startDir, maxLevels, (dir) => (hasInstall(dir) ? dir : null));
  return root === null ? null : buildCheckFrom(root);
}

/** The configured per-change gate command (`check.gateCommand`, PLANS.md Land-queue speed 3e)
 * when it is a non-blank string, else undefined — off. Opt-in: a repo that sets it trades a
 * cheaper review-gate pre-check for a full check.command run that happens once per stack at
 * the batch/landing scope instead. One reading shared by runScopedBuildCheck (which runs it at
 * scope "gate") and merge.ts's verifyLanding (which must then never treat the gate's green as
 * the full check's), so the two cannot disagree about whether it is on. */
export function gateCommandOf(config?: { check?: { gateCommand?: string } }): string | undefined {
  const g = config?.check?.gateCommand;
  return typeof g === "string" && g.trim() !== "" ? g : undefined;
}

/** Resolve `node_modules/<rel>` by walking UP from `startDir` — the same climb detectBuildCheck
 * makes, and the same one npm's run-script PATH walk makes: a tumwater worktree has no install
 * of its own (node_modules is gitignored, so it exists only where someone ran npm install), and
 * neither does a project nested under an installed root. Returns the first existing path, or
 * null when no ancestor within `maxLevels` has it. Assuming a local install instead is what
 * broke the fleet's own redeploy on 2026-09-08: compileStaged looked only at
 * `<root>/node_modules/typescript`, so its test could not pass in a bare worktree, the failing
 * suite made main read red, and the blocked restart stranded the fleet on a stale build
 * (BUGS.md). Never throws. */
export function resolveFromNodeModules(startDir: string, rel: string, maxLevels = WALK_UP_LEVELS): string | null {
  return walkUp(startDir, maxLevels, (dir) => {
    const candidate = path.join(dir, "node_modules", rel);
    return fs.existsSync(candidate) ? candidate : null;
  });
}
