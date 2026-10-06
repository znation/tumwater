import path from "node:path";
import { resolveFromNodeModules } from "./build-check-detect.js";
import { readJsonFile } from "../files/json-files.js";
import { EXEC_MAX_BUFFER } from "../process/process.js";
import { KILL_GRACE_MS, runScriptGroup } from "../process/process-group.js";
import { logEvent, warnEvent } from "../events/events.js";

/** Keeping a tree's install in step with its lockfile (BUGS.md 2026-10-01). node_modules is
 * gitignored, so a tumwater worktree has none of its own: its toolchain and every import
 * resolve by walking UP to the root checkout's install (detectBuildCheck,
 * resolveFromNodeModules). That install predates any dependency a change adds, and no loop ever
 * ran `npm install` — so a legitimate dependency-adding change failed its gate check with
 * TS2307 every time, and had it landed, every tree after it would have resolved against a root
 * install missing the package. Two callers close both halves: runBuildCheck installs into the
 * checked tree when its lockfile's direct dependencies are not what the walk-up resolves, and
 * the landing path re-syncs the root checkout after a fast-forward moves main's lockfile. */

/** Hard cap on one install run — a registry fetch of a handful of packages takes seconds; the
 * cap only bounds a hung network. Same bound as the check itself. */
const DEP_INSTALL_TIMEOUT_MS = 300_000;

/** What one install attempt concluded: `ok` when npm exited 0 AND the tree no longer drifts
 * (an exit 0 that still leaves a direct dependency unresolved is not an install), otherwise a
 * one-line `detail` for the warning. `durationMs` is the install's own wall-clock. */
interface InstallResult {
  ok: boolean;
  durationMs: number;
  detail?: string;
}

/** Runs the install in `dir` — the seam tests replace so no suite run reaches a registry. */
export type InstallRunner = (dir: string, timeoutMs: number) => Promise<{ ok: boolean; detail?: string }>;

/** The direct dependencies (dependencies + devDependencies) `dir`'s package-lock.json pins whose
 * installed copy — found by the same walk-up Node and npm make from `dir` — is missing or at a
 * different version than the lockfile records. Empty when there is no readable v2/v3 lockfile
 * (nothing pins a version, so no install is owed) or when everything resolves as pinned.
 * Optional dependencies are left out: their absence on a platform is not drift. Never throws. */
export function installDrift(dir: string): string[] {
  // The lockfile read routes through readJsonFile's tolerant no-data policy — a missing,
  // unreadable, torn, or non-object file reads as no data (nothing pinned, so no install
  // owed), never a thrower.
  const lock = readJsonFile<{
    packages?: Record<string, { version?: string; dependencies?: object; devDependencies?: object }>;
  }>(path.join(dir, "package-lock.json"));
  const packages = lock?.packages;
  const top = packages?.[""];
  if (!packages || !top) return [];
  const names = [...Object.keys(top.dependencies ?? {}), ...Object.keys(top.devDependencies ?? {})];
  const drift: string[] = [];
  for (const name of names) {
    const pinned = packages[`node_modules/${name}`]?.version;
    if (!pinned) continue; // A link or workspace entry: nothing registry-pinned to compare.
    if (installedVersion(dir, name) !== pinned) drift.push(name);
  }
  return drift;
}

function installedVersion(dir: string, name: string): string | undefined {
  const manifest = resolveFromNodeModules(dir, path.join(name, "package.json"));
  if (!manifest) return undefined;
  // Same tolerant read as the lockfile above: a torn or non-object manifest is no data.
  const version = readJsonFile<{ version?: unknown }>(manifest)?.version;
  return typeof version === "string" ? version : undefined;
}

/** The production installer: `npm install` in `dir` from its own lockfile, run as a process
 * group under the timeout. `--no-save` keeps package.json and package-lock.json byte-identical,
 * so neither a worktree nor the root checkout goes dirty. Not `npm ci`: ci deletes node_modules
 * first, and at the root that is the install every in-flight check of a live fleet resolves
 * through. `--ignore-scripts` runs no package's (or the project's own) lifecycle scripts inside
 * the harness. */
export const npmInstall: InstallRunner = async (dir, timeoutMs) => {
  const r = await runScriptGroup(
    "npm",
    ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: dir, timeoutMs, killGraceMs: KILL_GRACE_MS, maxBuffer: EXEC_MAX_BUFFER },
  );
  if (r.spawnError) return { ok: false, detail: "npm is not on PATH" };
  if (r.timedOut) return { ok: false, detail: `npm install timed out after ${timeoutMs / 1000}s` };
  if (r.signal) return { ok: false, detail: `npm install was killed by ${r.signal}` };
  if (r.code !== 0) {
    const last = `${r.stdout}${r.stderr}`.trim().split("\n").at(-1) ?? "";
    return { ok: false, detail: `npm install exited ${r.code}${last ? `: ${last}` : ""}` };
  }
  return { ok: true };
};

/** Install `dir`'s lockfile when (and only when) installDrift says it is owed. Returns null when
 * nothing drifted — no process spawned — otherwise the drifted names and how the install went.
 * Never throws. */
export async function syncInstall(
  dir: string,
  install: InstallRunner = npmInstall,
  timeoutMs = DEP_INSTALL_TIMEOUT_MS,
): Promise<({ packages: string[] } & InstallResult) | null> {
  const packages = installDrift(dir);
  if (packages.length === 0) return null;
  const startedAt = Date.now();
  const r = await install(dir, timeoutMs).catch((err: unknown) => ({ ok: false, detail: String(err) }));
  const durationMs = Date.now() - startedAt;
  if (!r.ok) return { packages, ok: false, durationMs, detail: r.detail };
  const still = installDrift(dir);
  if (still.length > 0)
    return { packages, ok: false, durationMs, detail: `still unresolved after install: ${still.join(", ")}` };
  return { packages, ok: true, durationMs };
}

/** Re-sync the root checkout's install after a fast-forward moved main's lockfile (BUGS.md
 * 2026-10-01). Every fleet worktree, the redeploy compile, and the running harness resolve
 * through `root/node_modules`, so a landed dependency the root never installed would leave each
 * of them resolving against the old tree. Called under the merge lock right after the ff, so
 * the next landing's in-lock check already sees it. A `dep_install` event prices a run; a
 * failure also warns, and is retried by the next landing's call (the drift is still there) —
 * meanwhile each check installs into its own tree, so nothing is rejected for it. No drift (the
 * common case — the landing did not touch dependencies) spawns nothing and logs nothing. */
export async function syncRootInstall(
  root: string,
  role: string,
  install: InstallRunner = npmInstall,
): Promise<void> {
  const r = await syncInstall(root, install);
  if (!r) return;
  logEvent(root, {
    loop: role,
    type: "dep_install",
    packages: r.packages,
    status: r.ok ? "passed" : "failed",
    durationMs: r.durationMs,
    ...(r.detail ? { error: r.detail } : {}),
  });
  if (!r.ok)
    warnEvent(
      root,
      role,
      `the root install did not pick up main's dependencies (${r.packages.join(", ")})${r.detail ? `: ${r.detail}` : ""}; checks install into their own trees until a later landing re-syncs it`,
    );
}
