import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { truncate } from "./text.js";

const execFileAsync = promisify(execFile);

/** The deterministic build pre-check the review gate runs before any model reviewer: detect
 * the project's declared check (an npm script) by walking up to the installed root, run it in
 * the worktree with a hard timeout, and classify the outcome. Split out of review.ts — which
 * keeps the adversarial review gate itself — because this is a self-contained concern with its
 * own data model (BuildCheck/BuildCheckOutcome), detection algorithm (walk-up to the install),
 * and execution/classification logic: deterministic process verification, distinct from the
 * model-based review. The gate (review.ts) consumes detectBuildCheck + runBuildCheck; nothing
 * else does. clipReason/MAX_REASON_CHARS live here too — they bound one line of machine text,
 * shared by clipBuildTail and parseVerdict in review.ts — so that helper has a single home. */

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
export interface BuildCheck {
  /** Directory holding the qualifying package.json + node_modules. */
  rootDir: string;
  /** The npm script to run — `typecheck` preferred, else `build`. */
  script: string;
}

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

/** Read the check script from `dir`'s package.json: prefer typecheck, else build; null when
 * neither is present or the file cannot be read/parsed (detection never throws). */
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
  if (typeof s.typecheck === "string" && s.typecheck) return { rootDir: dir, script: "typecheck" };
  if (typeof s.build === "string" && s.build) return { rootDir: dir, script: "build" };
  return null;
}

/** Find the project's deterministic build check by walking UP from `startDir` — at most
 * `maxLevels` ancestors (default 5) — to the nearest directory containing BOTH a package.json
 * and a node_modules/ directory, then preferring scripts.typecheck over scripts.build. The
 * walk is required: tumwater worktrees live under `<repo>/.tumwater/worktrees/<role>` with no
 * install of their own (node_modules is gitignored — it exists only where someone ran npm
 * install), so a literal startDir check would silently disable the pre-check forever in
 * dogfood. The FIRST qualifying directory is the project: if its package.json has neither
 * script, there is no check (an unrelated ancestor further up must never be used). Returns
 * null when no ancestor qualifies or the file is missing/unreadable/malformed — detection
 * never throws into the gate. */
export function detectBuildCheck(startDir: string, maxLevels = 5): BuildCheck | null {
  let dir = startDir;
  for (let level = 0; level <= maxLevels; level++) {
    if (hasInstall(dir)) return buildCheckFrom(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // Filesystem root reached.
    dir = parent;
  }
  return null;
}

// ── Execution ─────────────────────────────────────────────────────────────────────────────

/** Hard cap on one build check run — a hung script (watch mode) must not wedge the tick, and
 * a timeout is environmental, never fail-closed. A parameter of runBuildCheck so tests can
 * shorten it. */
export const BUILD_CHECK_TIMEOUT_MS = 300_000;

/** What the deterministic build check concluded. "passed": proceed to the reviewer unchanged.
 * "failed": a started process exited nonzero — a deterministic REJECTION with the clipped
 * output tail as machine-generated reasons (no pi run consumed). "skipped": environmental
 * (timeout, or no npm on PATH) — warn and still proceed to the model review; deliberately NOT
 * fail-closed so a hung build script cannot wedge every code tick into the 3-strike discard. */
export interface BuildCheckOutcome {
  status: "passed" | "failed" | "skipped";
  /** The script that was run (or attempted). */
  script: string;
  /** Clipped tail of the combined output on failure — last ≤10 meaningful lines (non-blank,
   * npm banner excluded), each clipped to MAX_REASON_CHARS. */
  outputTail?: string[];
  /** Why no verdict was reached ("skipped"). */
  skipReason?: "timeout" | "no-npm";
}

/** Keep the TAIL of a build's combined output: last ≤10 meaningful lines, each via clipReason —
 * so a chatty build cannot bloat persisted state or the injected next-tick note. Blank lines
 * and npm's own script banner (`> pkg@1.0 script`, `> <command>`) are dropped: they name the
 * script that ran, not what broke in it. */
export function clipBuildTail(output: string): string[] {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^>\s/.test(l));
  return lines.slice(-10).map(clipReason);
}

/** Run `npm run <script>` in the worktree (cwd = wt), capturing combined output with a hard
 * timeout. Never throws: every outcome is classified per BuildCheckOutcome. Running a local
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
    // A started process that exited nonzero is a deterministic failure of the build itself.
    if (typeof e.code === "number") {
      return {
        status: "failed",
        script: check.script,
        outputTail: clipBuildTail(`${e.stdout ?? ""}${e.stderr ?? ""}`),
      };
    }
    // Spawn failed before anything ran — the npm binary is missing from PATH.
    return { status: "skipped", script: check.script, skipReason: "no-npm" };
  }
}
