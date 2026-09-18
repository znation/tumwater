import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { logEvent } from "./events.js";
import { truncate } from "./text.js";

const execFileAsync = promisify(execFile);

/** The deterministic build pre-check the review gate runs before any model reviewer: detect
 * the project's declared check (an npm script — `test` preferred per npm convention, then
 * `typecheck`, then `build`) by walking up to the installed root, run it in the worktree with a
 * hard timeout, and classify the outcome. Split out of review.ts — which
 * keeps the adversarial review gate itself — because this is a self-contained concern with its
 * own data model (BuildCheck/BuildCheckOutcome), detection algorithm (walk-up to the install),
 * and execution/classification logic: deterministic process verification, distinct from the
 * model-based review. runScopedBuildCheck below is the shared detect → run → build_check
 * event → skip-warning sequence of the gate's pre-check (review.ts) and the landing path's
 * in-lock re-check (merge.ts). The red-main baseline gate (main-red.ts) reuses this same
 * detection and execution from main-baseline.ts to verify main itself once per SHA before an
 * authoring run is spent on top of it. clipReason/MAX_REASON_CHARS live here too — they bound one line of machine text, shared
 * by clipBuildTail and parseVerdict in review.ts — so that helper has a single home. */

/** Per-reason length cap with ellipsis — bounds one line of machine-generated or reviewer
 * text so it cannot bloat persisted state (shared by clipBuildTail here and parseVerdict in
 * review.ts). */
const MAX_REASON_CHARS = 300;

/** Cap one line of text to MAX_REASON_CHARS with an ellipsis (unchanged when it fits). */
export function clipReason(r: string): string {
  return truncate(r, MAX_REASON_CHARS);
}

// ── Detection ─────────────────────────────────────────────────────────────────────────────
// A check whose correctness must not depend on model compliance is run by the harness, not
// asked of the reviewer (plans/review-gate.md): the reviewer may not run state-changing
// commands, and `npm run build` is exactly that — type errors are invisible to a model that
// cannot compile.

/** The project's declared deterministic check: an npm script name plus the directory whose
 * package.json declares it (the walk-up target holding both package.json and node_modules). */
interface BuildCheck {
  /** Directory holding the qualifying package.json + node_modules. */
  rootDir: string;
  /** The npm script to run — `test` preferred, then `typecheck`, else `build`. */
  script: string;
}

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
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const s = scripts as Record<string, unknown>;
  if (typeof s.test === "string" && s.test) return { rootDir: dir, script: "test" };
  if (typeof s.typecheck === "string" && s.typecheck) return { rootDir: dir, script: "typecheck" };
  if (typeof s.build === "string" && s.build) return { rootDir: dir, script: "build" };
  return null;
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

/** Find the project's deterministic build check by walking UP from `startDir` — at most
 * `maxLevels` ancestors (default 5) — to the nearest directory containing BOTH a package.json
 * and a node_modules/ directory, then preferring scripts.test over scripts.typecheck and
 * scripts.build (npm convention: `test` is the canonical verify command). The
 * walk is required: tumwater worktrees live under `<repo>/.tumwater/worktrees/<role>` with no
 * install of their own (node_modules is gitignored — it exists only where someone ran npm
 * install), so a literal startDir check would silently disable the pre-check forever in
 * dogfood. The FIRST qualifying directory is the project: if its package.json has neither
 * script, there is no check (an unrelated ancestor further up must never be used). Returns
 * null when no ancestor qualifies or the file is missing/unreadable/malformed — detection
 * never throws into the gate. */
export function detectBuildCheck(startDir: string, maxLevels = WALK_UP_LEVELS): BuildCheck | null {
  const root = walkUp(startDir, maxLevels, (dir) => (hasInstall(dir) ? dir : null));
  return root === null ? null : buildCheckFrom(root);
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

// ── Execution ─────────────────────────────────────────────────────────────────────────────

/** Hard cap on one build check run — a hung script (watch mode) must not wedge the tick, and
 * a timeout is environmental, never fail-closed. A parameter of runBuildCheck so tests can
 * shorten it. */
export const BUILD_CHECK_TIMEOUT_MS = 300_000;

/** What the deterministic build check concluded. "passed": proceed to the reviewer unchanged.
 * "failed": a started process exited nonzero — a deterministic REJECTION with the clipped
 * output tail as machine-generated reasons (no pi run consumed). "skipped": environmental
 * (timeout, no npm on PATH, or a broken toolchain) — warn and still proceed to the model
 * review; deliberately NOT fail-closed so a hung build script cannot wedge every code tick into
 * the 3-strike discard, and a toolchain broken below the project (BUGS.md 2026-09-15) cannot be
 * misread as a red build of the tree. */
export interface BuildCheckOutcome {
  status: "passed" | "failed" | "skipped";
  /** The script that was run (or attempted). */
  script: string;
  /** Clipped tail of the combined output on failure — last ≤10 meaningful lines (non-blank,
   * npm banner excluded), each clipped to MAX_REASON_CHARS. */
  outputTail?: string[];
  /** Why no verdict was reached ("skipped"). */
  skipReason?: "timeout" | "no-npm" | "toolchain";
}

/** Probe the check's environment BEFORE spending a run on it: `git --version`, unambiguous
 * and fast, and it exercises the same binary (and the same xcrun shim on macOS) a
 * git-dependent check would. "broken" — git ran and refused to work, e.g. exit 69 on an
 * invalidated Xcode license — is the environmental case: it would fail EVERY check with noise
 * unrelated to the tree, and a failure so read is a false red build (BUGS.md 2026-09-15: exactly
 * that made the harness's own suite fail and latched a false "main is red" on a green tree). It
 * must read as a skip — warn-and-proceed — like no-npm, never as a deterministic rejection.
 * "missing" (git absent from PATH) is NOT broken: a check whose script never touches git runs
 * fine without it, so the check proceeds. Never throws. */
async function probeToolchain(): Promise<"ok" | "broken" | "missing"> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 10_000 });
    return "ok";
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    // A string errno is a spawn failure (no binary at all); a numeric exit is git running and
    // failing. A probe timeout (a string signal) reads as "missing" — proceed, and the check's
    // own timeout bounds the worst case.
    return typeof code === "number" ? "broken" : "missing";
  }
}

/** Toolchain-level failure signatures in a check's output. A run that died on one of these
 * was killed by the environment, not the tree: its nonzero exit says nothing about the code
 * (BUGS.md 2026-09-15 — an invalidated Xcode license put both of these into the harness's own
 * suite output and the harness latched a false red main on a green tree). The probe above
 * catches a broken git before anything runs; this catches what it cannot — a sub-tool that
 * the probe cannot see (xcrun under a working git) or a suite whose runner reported the
 * failure in its own output. */
const TOOLCHAIN_ERROR_PATTERNS: Array<RegExp> = [
  /you have not agreed to the \S+ license/i,
  /xcrun: error/i,
];

function toolchainErrorInOutput(output: string): boolean {
  return TOOLCHAIN_ERROR_PATTERNS.some((p) => p.test(output));
}

/** Keep the TAIL of a build's combined output: last ≤10 meaningful lines, each via clipReason —
 * so a chatty build cannot bloat persisted state or the injected next-tick note. Blank lines
 * and npm's own script banner (`> pkg@1.0 script`, `> <command>`) are dropped: they name the
 * script that ran, not what broke in it. */
export function clipBuildTail(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^>\s/.test(l));
  return lines.slice(-10).map(clipReason);
}

/** Probe the toolchain (see probeToolchain), then run `npm run <script>` in the worktree
 * (cwd = wt), capturing combined output with a hard timeout. Never throws: every outcome is
 * classified per BuildCheckOutcome. Running a local
 * script needs no network.
 * No env manipulation is needed even though the worktree has no node_modules of its own
 * (gitignored): npm's run-script walks UP from the project path, adding EVERY level's
 * `node_modules/.bin` to the script's PATH (@npmcli/run-script setPATH), so the toolchain at
 * check.rootDir — an ancestor of wt by detectBuildCheck construction — is resolvable without
 * any help. The script still runs in wt, compiling the branch state — which is what this
 * check exists for; build-check.test.ts pins the no-node_modules-worktree resolution. */
export async function runBuildCheck(
  wt: string,
  check: BuildCheck,
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
): Promise<BuildCheckOutcome> {
  // Environmental probe first: a toolchain broken below the project (git exiting 69 on an
  // invalidated Xcode license) would fail the check with noise unrelated to the tree and the
  // failure would be misread as a red build — run nothing, read it as a skip (BUGS.md 2026-09-15).
  if ((await probeToolchain()) === "broken") {
    return { status: "skipped", script: check.script, skipReason: "toolchain" };
  }
  try {
    await execFileAsync("npm", ["run", check.script], {
      cwd: wt,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { status: "passed", script: check.script };
  } catch (err) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
    };
    // Killed by the timeout (or an output overflow): environmental — warn and proceed.
    if (e.killed || e.signal) return { status: "skipped", script: check.script, skipReason: "timeout" };
    // A started process that exited nonzero is a deterministic failure of the build itself —
    // unless its output names a broken toolchain: then the environment, not the tree, killed it,
    // and the same skip semantics apply (never a deterministic rejection, never a red baseline).
    if (typeof e.code === "number") {
      const output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (toolchainErrorInOutput(output)) {
        return { status: "skipped", script: check.script, skipReason: "toolchain" };
      }
      return {
        status: "failed",
        script: check.script,
        outputTail: clipBuildTail(output),
      };
    }
    // Spawn failed before anything ran — the npm binary is missing from PATH.
    return { status: "skipped", script: check.script, skipReason: "no-npm" };
  }
}

/** The scopes named in a build_check event logged from this helper. The red-main baseline
 * names its own ("baseline") from main-red.ts, because the one-run-per-SHA cache and in-flight
 * dedup live in checkMainBaseline — the event there is logged by the paying role via the onRun
 * hook. */
type BuildCheckScope = "gate" | "landing" | "batch";

/** Per-scope wording for the environmental-skip warning. The call sites' current messages
 * are identical apart from these words, so keying them on the scope keeps each surface's feed
 * line byte-for-byte what it is today. */
const SCOPE_WORDS: Record<BuildCheckScope, { label: string; proceeding: string }> = {
  gate: { label: "build check", proceeding: "proceeding to model review" },
  landing: { label: "landing build check", proceeding: "proceeding to merge" },
  // The batch's next step after the check is the fast-forward — the same phrase the landing
  // scope uses (gate says "proceeding to model review" because its next step is the reviewer).
  batch: { label: "batch build check", proceeding: "proceeding to merge" },
};

/** Run the project's declared check for a named scope — the detect → run → build_check
 * event → skip-warning sequence the review gate's pre-check (scope "gate"), the landing
 * path's in-lock re-check (scope "landing"), and the batch lander's one check over the whole
 * stacked tree (scope "batch") previously each ran inline, kept in one place so
 * the event's shape and the skip warning cannot drift between the two surfaces. Every run is
 * an event with its cost: the deterministic checks are where the fleet's compute goes after
 * the authoring run, and "how long does npm test take per merge" must be answerable from the
 * feed, not by timing it by hand. Returns null when no check is declared (nothing to run —
 * the caller passes, exactly as before this split), otherwise the declared check plus its
 * classified outcome. A "skipped" outcome also logs its standard warning here (wording keyed
 * on the scope, the timeout as actually set); "failed" and "passed" are the caller's to decide
 * (deterministic reject vs. verifiedHead / baseline seeding). Never throws. */
export async function runScopedBuildCheck(
  root: string,
  role: string,
  scope: BuildCheckScope,
  wt: string,
  timeoutMs = BUILD_CHECK_TIMEOUT_MS,
): Promise<{ check: BuildCheck; outcome: BuildCheckOutcome } | null> {
  const check = detectBuildCheck(wt);
  if (!check) return null;
  const startedAt = Date.now();
  const outcome = await runBuildCheck(wt, check, timeoutMs);
  logEvent(root, {
    loop: role,
    type: "build_check",
    scope,
    status: outcome.status,
    script: check.script,
    durationMs: Date.now() - startedAt,
  });
  if (outcome.status === "skipped") {
    // Environmental — deliberately NOT fail-closed, so a hung build script cannot wedge every
    // code tick into the 3-strike discard (gate) or every landing behind the merge lock.
    const w = SCOPE_WORDS[scope];
    logEvent(root, {
      loop: role,
      type: "warning",
      message:
        outcome.skipReason === "no-npm"
          ? `no npm on PATH; skipping ${w.label}`
          : outcome.skipReason === "toolchain"
            ? `the toolchain is broken; skipping ${w.label}; ${w.proceeding}`
            : `${w.label} timed out after ${timeoutMs / 1000}s; ${w.proceeding}`,
    });
  }
  return { check, outcome };
}

