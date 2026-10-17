// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import { loadConfigSafe } from "../config/config.js";
import { seamsInUse } from "../config/config-fallbacks.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { findOnPath } from "../files/files.js";
import { GIT_MISSING_MESSAGE } from "../git/git-run.js";
import { branchesPhrase, branchExists, currentBranch, hasCommits, isGitRepo } from "../git/git.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  NO_COMMITS_MESSAGE,
} from "./readiness.js";
import { agentMissingMessage, findAgentBinary, resolveAgentBin } from "../pi/pi-bin.js";
import { seedClaudeAccount } from "../agent/claude/claude-account.js";

/** The startup gate of `tumwater run` as one function: every precondition an orchestrator
 * generation checks before it starts. "Can a generation boot in this repo's current state?" has
 * three askers and they must get one answer: cmdRun (cli/cli-run.ts) fails fast on it at startup,
 * the self-redeploy (src/redeploy/redeployer.ts) asks it before it holds the team and again right
 * before its swap, and the supervisor (src/process/supervisor.ts) asks it to name why a generation
 * died. On 2026-09-22 only the first existed: a redeploy swapped onto a build whose child found
 * tumwater.json missing, exited "not initialized", and the supervisor exited with it — 4 h 44 m
 * of a dead team and no event (BUGS.md 2026-09-23). The operator-facing wording lives in
 * readiness.ts, shared with doctor's per-check report.
 *
 * The one startup check deliberately outside the gate is cmdRun's "an orchestrator is already
 * running": to a redeploy asking on behalf of its successor, the live orchestrator is itself —
 * gone by the time the successor boots. The gate is the ASKER's build's rule, so a redeploy checks
 * what the running build knows of startup; a precondition the new build adds is invisible to it
 * until that build runs. */

/** The repo-level preconditions every repo-bound command shares (requireReadyRepo in
 * cli/cli-repo-gate.ts): git
 * on PATH, a repository, tumwater.json present, at least one commit. The first unmet one's
 * message, or null when the repo is ready. A missing tumwater.json is "not initialized" here,
 * never "use defaults": starting a team is the moment an operator's config must exist. */
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
  const { config, error } = loadConfigSafe(root);
  if (config === undefined) return { problem: error };
  // Fail fast instead of starting loops whose every tick dies with "spawn <bin> ENOENT". Every
  // enabled seam's agent — the top-level `agent` plus each enabled loop's resolved view and the
  // reviewer — resolves through the same resolveAgentBin the spawn uses (and doctor's pi check);
  // a missing one names its own agent's binary, not pi's. resolveAgentBin normalizes path-shaped
  // values against THIS process's cwd, which every generation inherits, so what is checked here
  // is exactly what the ticks spawn.
  for (const agent of agentsInUse(config)) {
    const resolved = resolveAgentBin(config, agent);
    // The shared executability rule (pi/pi-bin.ts's findAgentBinary — the one doctor's pi check
    // asks too), so a seam's missing binary reads the same way on both surfaces.
    if (!findAgentBinary(resolved)) return { problem: agentMissingMessage(resolved, agent) };
  }
  // Seed the claude account state before the first run (plans/agent-backends.md part 6a):
  // `claude auth status` decides subscription vs API key, and an existing file is left alone.
  // Gated on a claude seam so a pi-only team spawns nothing, and attempted once per root per
  // process: runStartupCheck is also the redeploy/supervisor poll's ask (runStartupProblem),
  // and a logged-out claude would otherwise spawn a bounded probe on every poll. If the seed
  // fails, the first claude run's observation fills the file in.
  if (!claudeSeedAttempted.has(root) && agentsInUse(config).includes("claude")) {
    claudeSeedAttempted.add(root);
    seedClaudeAccount(root, config);
  }
  const branch = await resolveMainBranch(root, config, branchArg);
  if ("problem" in branch) return branch;
  return { config, mainBranch: branch.mainBranch };
}

/** Roots this process has already attempted a claude-account seed for (see runStartupCheck),
 * so the supervisor's and redeploy's repeated startup checks do not respawn `claude auth
 * status` on every poll when the probe fails. */
const claudeSeedAttempted = new Set<string>();

/** Every agent backend an enabled seam resolves to — the distinct agents of the one
 * seamsInUse list (startup-gate's consumer of it), so a claude or pi clause that exists only
 * as a fallback, the resolver, or the director is checked exactly like a primary seam.
 * One list the startup gate and doctor's binary check share, so a route the harness would
 * spawn is checked on both surfaces. */
export function agentsInUse(config: TumwaterConfig): string[] {
  return [...new Set(seamsInUse(config).map((s) => s.agent ?? "pi"))];
}

/** runStartupCheck reduced to its verdict: the message a generation would fail on right now, or
 * null when one would boot — what the redeploy and the supervisor ask. */
export async function runStartupProblem(root: string, branchArg: string | null): Promise<string | null> {
  const check = await runStartupCheck(root, branchArg);
  return "problem" in check ? check.problem : null;
}

/** The branch the team targets: `--branch <name>` wins, then `baseBranch` in config, then
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
      const existing = await branchesPhrase(root);
      return { problem: `branch ${explicit} does not exist (branches: ${existing})` };
    }
    return { mainBranch: explicit };
  }
  const branch = await currentBranch(root);
  return branch ? { mainBranch: branch } : { problem: DETACHED_HEAD_MESSAGE };
}
