/** The operator's `gh` CLI as tumwater's one GitHub probe (plans/github-issues.md, part 1/5).
 * Tumwater never holds a GitHub token: every GitHub read runs `gh` under the operator's own
 * login, through the injectable `GhRunner` below, so a test swaps in a fake gh and no test
 * reaches GitHub (PRINCIPLES.md). `ghReadiness` answers the one question every GitHub-facing
 * surface asks before it reads: is `gh` installed, and is it logged in to github.com? */

import { AUTH_CHECK_MAX_OUTPUT_BYTES, AUTH_CHECK_TIMEOUT_MS, boundedProbe } from "../process/bounded-probe.js";
import { childEnv } from "../process/process.js";

/** Runs `gh <args>` and answers its exit code and stdout, or null when the probe could not
 * run or finish (a missing binary, the deadline, an output overrun) — the same shape
 * boundedProbe returns, so the default runner is boundedProbe itself. */
export type GhRunner = (args: string[]) => Promise<{ code: number | null; stdout: string } | null>;

/** The default runner: `gh` resolved on the operator's PATH, bounded by the shared probe
 * budgets (process/bounded-probe.ts), with the environment inherited apart from PATH. */
export function ghRunner(pathEnv: string): GhRunner {
  return (args) =>
    boundedProbe("gh", args, childEnv({ PATH: pathEnv }), AUTH_CHECK_TIMEOUT_MS, AUTH_CHECK_MAX_OUTPUT_BYTES);
}

/** `missing` when `gh --version` does not succeed (not installed, or unusable); `unauthenticated`
 * when it runs but `gh auth status --hostname github.com` does not succeed; `ok` otherwise.
 * Makes no GitHub API call — both probes read only the local install and its login. */
export async function ghReadiness(run: GhRunner): Promise<"ok" | "missing" | "unauthenticated"> {
  const version = await run(["--version"]);
  if (version?.code !== 0) return "missing";
  const auth = await run(["auth", "status", "--hostname", "github.com"]);
  if (auth?.code !== 0) return "unauthenticated";
  return "ok";
}

/** The sentence for a `gh` that cannot read the project's issues — the doctor `github issues`
 * row's warn text and the GUI's amber `github-gh` alert both take it here, so the two cannot
 * drift apart. */
export function ghUnreadableSentence(readiness: "missing" | "unauthenticated", repo: string): string {
  if (readiness === "missing")
    return `gh is missing — install GitHub CLI (https://cli.github.com) so tumwater can read ${repo}'s issues, or set githubIssues.enabled to false`;
  return `gh is not logged in — run \`gh auth login\` so tumwater can read ${repo}'s issues, or set githubIssues.enabled to false`;
}
