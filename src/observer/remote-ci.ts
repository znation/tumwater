/** The `ci` role's remote-CI ledger and prompt block (plans/remote-ci.md "Shape"). The ci
 * role runs the workflow's own steps on this machine and never asks GitHub whether Actions
 * passed, so it cannot see a failure that happens only on the hosted runner. When the base
 * branch's remote is on github.com and the repo has a workflow file, the harness appends a
 * Remote CI block to the ci prompt and the role checks the hosted CI's verdict on the newest
 * pushed commit with the operator's own `gh` (read-only), reporting it on a `REMOTE:` line
 * the harness records in this ledger. The harness gains no GitHub client and stores no
 * credentials: detection reads git config and the workflow directory locally, and `gh` runs
 * only in the role's shell. The ledger is gitignored runtime state under .tumwater/state/
 * and degrades to "no data" on any missing or malformed file — an observer must never fail a
 * run on bookkeeping (the same policy as ci-parity.ts). */

import * as fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../files/json-files.js";
import { isJsonObject } from "../files/json-object.js";
import { gitTry } from "../git/git-run.js";
import { currentBranchFromHeadFile, targetBranch } from "../git/git.js";
import { remoteCiPath } from "../paths.js";
import { humanAgo } from "../text/datetime.js";
import type { TumwaterConfig } from "../config/config-schema.js";

/** Parse `owner/name` out of a GitHub remote URL: the https and http forms, the scp-like
 * `git@github.com:o/r(.git)` form, and the `ssh://git@github.com[:port]/o/r` form, each with
 * or without the `.git` suffix or a trailing `/`. The host is matched case-insensitively.
 * Any other host, or a path that is not exactly two segments, returns null. */
export function githubRepoOf(url: string): string | null {
  const u = url.trim();
  let host = "";
  let rest = "";
  const https = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(u);
  if (https) {
    host = https[1]!;
    rest = (https[2] ?? "").replace(/^\/+/, "");
  } else {
    const scheme = /^[a-z]+:\/\//i.exec(u);
    if (scheme) {
      // ssh://[git@]github.com[:port]/o/r — the authority sits between the scheme and the
      // first "/"; the host is what follows the last "@", with any `:port` stripped.
      const after = u.slice(scheme[0].length);
      const slash = after.indexOf("/");
      const authority = slash === -1 ? after : after.slice(0, slash);
      const at = authority.lastIndexOf("@");
      host = (at > 0 ? authority.slice(at + 1) : authority).replace(/:\d+$/, "");
      rest = slash === -1 ? "" : after.slice(slash + 1);
    } else {
      // scp-like git@github.com:o/r — the host ends at the first ":" that follows the last "@".
      const colon = u.indexOf(":");
      const at = u.lastIndexOf("@");
      if (colon > 0 && at > 0 && colon > at) {
        host = u.slice(at + 1, colon);
        rest = u.slice(colon + 1);
      } else {
        return null;
      }
    }
  }
  if (host.toLowerCase() !== "github.com") return null;
  rest = rest.replace(/\.git$/i, "").replace(/\/+$/, "").trim();
  const segs = rest.split("/").filter((s) => s !== "");
  if (segs.length !== 2) return null;
  return `${segs[0]}/${segs[1]}`;
}

/** One recorded remote-CI verdict, as stored in the ledger. `repo` is the `owner/name` the
 * record was read for; `sha` is the pushed commit the verdict names (absent only for
 * `unavailable`, where `reason` explains why GitHub could not be read). `result` is what the
 * ci role reported on its `REMOTE:` line; `checkedAt` is when the record was written. */
export interface RemoteCiEntry {
  repo: string;
  sha?: string;
  result: "passed" | "failed" | "pending" | "unavailable";
  reason?: string;
  checkedAt: number;
}

function isRemoteCiEntry(value: unknown): value is RemoteCiEntry {
  if (!isJsonObject(value)) return false;
  if (typeof value.repo !== "string") return false;
  if (value.result !== "passed" && value.result !== "failed" && value.result !== "pending" && value.result !== "unavailable")
    return false;
  if (typeof value.checkedAt !== "number") return false;
  if (value.result !== "unavailable") {
    if (typeof value.sha !== "string") return false;
  } else if (typeof value.reason !== "string" || value.reason === "") {
    return false;
  }
  return true;
}

/** Read the remote-CI ledger. A missing, torn, or wrong-shaped file reads as null — the
 * caller renders no block and the run proceeds as before. */
export function readRemoteCi(root: string): RemoteCiEntry | null {
  const file = remoteCiPath(root);
  const ledger = readJsonFile<{ record?: unknown }>(file);
  return ledger?.record != null && isRemoteCiEntry(ledger.record) ? ledger.record : null;
}

/** Record the verdict a `ci` run reported on its `REMOTE:` line, written atomically
 * (writeJsonAtomic) so a concurrent reader never sees a torn file. `sha` names the pushed
 * commit the verdict is about (absent only for `unavailable`, where `reason` explains why
 * GitHub could not be read); both ride the record when the line carried them. Returns the
 * previous record, or null when there was none — part 2/3's once-per-commit event reads it to
 * know when a sha has already been recorded failed. */
export function recordRemoteCi(
  root: string,
  repo: string,
  result: RemoteCiEntry["result"],
  now: number = Date.now(),
  sha?: string,
  reason?: string,
): RemoteCiEntry | null {
  const prev = readRemoteCi(root);
  const entry: RemoteCiEntry = { repo, result, checkedAt: now };
  if (sha !== undefined) entry.sha = sha;
  if (reason !== undefined) entry.reason = reason;
  writeJsonAtomic(remoteCiPath(root), { record: entry });
  return prev;
}

/** The hosted-CI target the ci role checks, or null when there is nothing to check: null
 * when `roles.ci.remote` is false, when `.github/workflows/` holds no `*.yml`/`*.yaml` file,
 * or when the base branch's remote URL is unreadable or not on GitHub. The branch is the
 * base branch (`targetBranch`, as `currentCiParityState` resolves it); the remote is
 * `branch.<branch>.remote`, defaulting to `origin`. A failed git read returns null and never
 * throws — detection runs at the start of a ci run and must not fail the run. */
export async function remoteCiTarget(
  root: string,
  config: TumwaterConfig,
): Promise<{ repo: string; branch: string } | null> {
  if (config.roles?.ci?.remote === false) return null;
  const dir = path.join(root, ".github", "workflows");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  if (!names.some((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) return null;
  const branch = targetBranch(config.baseBranch, currentBranchFromHeadFile(root));
  const remote = (await gitTry(root, "config", "--get", `branch.${branch}.remote`))?.trim() || "origin";
  const url = (await gitTry(root, "config", "--get", `remote.${remote}.url`))?.trim();
  if (!url) return null;
  const repo = githubRepoOf(url);
  return repo ? { repo, branch } : null;
}

/** Render the Remote CI block the ci prompt ends with (plans/remote-ci.md "Shape"). It holds
 * facts and one read-only `gh` command, never instructions: which repo and branch were last
 * checked, what the team's own record says, and the command to re-check them this run. */
export function renderRemoteCiBlock(
  target: { repo: string; branch: string },
  entry: RemoteCiEntry | null,
  now: number,
): string {
  const lines = [
    `Remote CI (GitHub Actions on ${target.repo}, branch ${target.branch}; from this team's own record):`,
  ];
  if (!entry) {
    lines.push("  no result recorded yet");
  } else if (entry.result === "unavailable") {
    lines.push(`  last checked — unavailable ${humanAgo(entry.checkedAt, now)}: ${entry.reason}`);
  } else {
    lines.push(`  last checked ${entry.sha!.slice(0, 7)} — ${entry.result} ${humanAgo(entry.checkedAt, now)}`);
  }
  lines.push(
    `  Check it this run with: gh run list --repo ${target.repo} --branch ${target.branch} --event push --limit 20 --json headSha,status,conclusion,workflowName,databaseId,url,createdAt`,
  );
  return lines.join("\n");
}

/** The Remote CI block for a ci prompt, or undefined when there is no hosted-CI target (no
 * GitHub remote, no workflow file, or the operator opted out with `roles.ci.remote: false`)
 * — the omission policy the parity block shares, so a prompt without a target is unchanged. */
export async function remoteCiBlockFor(
  root: string,
  config: TumwaterConfig,
  now: number = Date.now(),
): Promise<string | undefined> {
  const target = await remoteCiTarget(root, config);
  if (!target) return undefined;
  const entry = readRemoteCi(root);
  return renderRemoteCiBlock(target, entry, now);
}
