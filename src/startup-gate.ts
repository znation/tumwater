import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import type { TumwaterConfig } from "./config-schema.js";
import { findOnPath } from "./files.js";
import { GIT_MISSING_MESSAGE, branchExists, currentBranch, hasCommits, isGitRepo, listBranches } from "./git.js";
import { resolveAgentBin } from "./pi.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  NO_COMMITS_MESSAGE,
  piMissingMessage,
} from "./readiness.js";
import { errorMessage } from "./text.js";

/** The startup gate of `tumwater run` as one function: every precondition an orchestrator
 * generation checks before it starts. "Can a generation boot in this repo's current state?" has
 * three askers and they must get one answer: cmdRun (cli.ts) fails fast on it at startup, the
 * self-redeploy (redeploy.ts) asks it before it holds the fleet and again right before its swap,
 * and the supervisor (cli.ts) asks it to name why a generation died. On 2026-09-22 only the first
 * existed: a redeploy swapped onto a build whose child found tumwater.json missing, exited "not
 * initialized", and the supervisor exited with it — 4 h 44 m of a dead fleet and no event (BUGS.md
 * 2026-09-23). The operator-facing wording lives in readiness.ts, shared with doctor's per-check
 * report.
 *
 * The one startup check deliberately outside the gate is cmdRun's "an orchestrator is already
 * running": to a redeploy asking on behalf of its successor, the live orchestrator is itself —
 * gone by the time the successor boots. The gate is the ASKER's build's rule, so a redeploy
 * checks what the running build knows of startup; a precondition the new build adds is
 * invisible to it until that build runs. */

/** The repo-level preconditions every repo-bound command shares (requireReadyRepo in cli.ts): git
 * on PATH, a repository, tumwater.json present, at least one commit. The first unmet one's
 * message, or null when the repo is ready. A missing tumwater.json is "not initialized" here,
 * never "use defaults": starting a fleet is the moment an operator's config must exist. */
export async function repoNotReady(root: string): Promise<string | null> {
  // Fail fast on a missing binary: without this, the probe below reads as "not a git
  // repository" — pointing at the wrong fix for a machine with no git installed.
  if (!findOnPath("git")) return GIT_MISSING_MESSAGE;
  if (!(await isGitRepo(root))) return NOT_A_REPO_MESSAGE;
  if (!fs.existsSync(path.join(root, "tumwater.json"))) return NOT_INITIALIZED_MESSAGE;
  if (!(await hasCommits(root))) return NO_COMMITS_MESSAGE;
  return null;
}

/** A passed startup gate: the config the generation starts on and the branch it targets. */
interface RunStartupReady {
  config: TumwaterConfig;
  mainBranch: string;
}

/** Every precondition a `tumwater run` generation checks before its orchestrator starts, in the
 * order it checks them: the repo gate, a tumwater.json that loads and validates, a resolvable
 * agent binary, and a main branch it can target. Either the values the generation starts with,
 * or the first unmet precondition's message — never a throw, so a poll can ask it safely. */
export async function runStartupCheck(
  root: string,
  /** The `--branch` flag of the invocation (null when absent) — the supervisor forwards it to
   * every generation, so every asker must pass the same one. */
  branchArg: string | null,
): Promise<RunStartupReady | { problem: string }> {
  const notReady = await repoNotReady(root);
  if (notReady !== null) return { problem: notReady };
  let config: TumwaterConfig;
  try {
    config = loadConfig(root);
  } catch (err) {
    return { problem: errorMessage(err) };
  }
  // Fail fast instead of starting loops whose every tick dies with "spawn pi ENOENT". The agent
  // binary (TUMWATER_PI_BIN → agentBin → "pi", plans/portability.md §5/7) is resolved from the
  // config; resolveAgentBin normalizes path-shaped values against THIS process's cwd, which
  // every generation inherits, so what is checked here is exactly what the ticks spawn.
  const resolved = resolveAgentBin(config);
  if (resolved.bin.includes("/")) {
    try {
      fs.accessSync(resolved.bin, fs.constants.X_OK);
    } catch {
      return { problem: piMissingMessage(resolved) };
    }
  } else if (!findOnPath(resolved.bin)) {
    return { problem: piMissingMessage(resolved) };
  }
  const branch = await resolveMainBranch(root, config, branchArg);
  if ("problem" in branch) return branch;
  return { config, mainBranch: branch.mainBranch };
}

/** runStartupCheck reduced to its verdict: the message a generation would fail on right now, or
 * null when one would boot — what the redeploy and the supervisor ask. */
export async function runStartupProblem(root: string, branchArg: string | null): Promise<string | null> {
  const check = await runStartupCheck(root, branchArg);
  return "problem" in check ? check.problem : null;
}

/** The branch the fleet targets: `--branch <name>` wins, then `baseBranch` in config, then
 * whatever the primary checkout has checked out — the branch-agnostic default. An explicit
 * value must exist: failing at startup with the branches that do exist beats failing at the
 * first `git worktree add`. */
async function resolveMainBranch(
  root: string,
  config: TumwaterConfig,
  branchArg: string | null,
): Promise<{ mainBranch: string } | { problem: string }> {
  const explicit = branchArg ?? config.baseBranch ?? null;
  if (explicit !== null) {
    if (!(await branchExists(root, explicit))) {
      const existing = (await listBranches(root)).join(", ") || "none";
      return { problem: `branch ${explicit} does not exist (branches: ${existing})` };
    }
    return { mainBranch: explicit };
  }
  const branch = await currentBranch(root);
  return branch ? { mainBranch: branch } : { problem: DETACHED_HEAD_MESSAGE };
}
