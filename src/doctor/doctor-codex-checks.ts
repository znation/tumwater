import fs from "node:fs";
import path from "node:path";
import { childEnv } from "../process/process.js";
import { AUTH_CHECK_MAX_OUTPUT_BYTES, AUTH_CHECK_TIMEOUT_MS, boundedProbe } from "./probe.js";
import { codexBackend, CODEX_MIN_VERSION } from "../agent/codex/codex-backend.js";
import { codexEffort, EFFORT_BY_THINKING } from "../agent/codex/codex-args.js";
import { codexEnv } from "../agent/codex/codex-env.js";
import { codexHome, readCodexCatalog } from "../agent/codex/codex-catalog.js";
import { codexHookTrust } from "../agent/codex/codex-hook-trust.js";
import { parseCodexLoginStatus } from "../agent/codex/codex-account.js";
import { codexWriteGuardDefinition } from "../agent/codex/codex-write-guard.js";
import { resolvedBackendConfig } from "../config/config-views.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { envPath, isDirectory, readTextOrNull, statOrNull, treeBytes, walkFiles } from "../files/files.js";
import { formatBytes, tokenWindowLabel } from "../text/format.js";
import { errorMessage } from "../text/text.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";
import {
  codexSeamsInUse,
  loadConfigForCheck,
  minVersionOutcome,
  versionFromProbe,
  seamedModels,
} from "./doctor-model-checks.js";

/** The doctor's codex rows (part 9a/9, plans/codex-backend.md §4, §7, "Hand steps"): one
 * exported check per row — install/version, login, home, models, account, leaks, sessions
 * size and the write guard. These are the doctor's only checks that spawn the `codex` CLI and
 * read the team's
 * `CODEX_HOME` state (catalog, skills, hooks, sessions, rollouts) — a distinct concern from the
 * filesystem/git checks, kept together so a change to how doctor reads codex does not touch the
 * other model checks. Each returns null (omitting its row) when no seam routes to codex, so a
 * pi-only team shows no codex row and spawns nothing and reads nothing. The shared
 * report contract (CheckOutcome) and the seam/model framework (loadConfigForCheck,
 * codexSeamsInUse, seamPairs) come from doctor-model-checks.ts, the AUTH_CHECK_* probe budgets
 * from probe.ts, and the shared report contract (CheckOutcome) from outcome.ts, as the other
 * doctor-* modules share them. */

/** The config and codex home a codex readiness row reads, or the warn outcome a broken
 * `tumwater.json` earns, or null when no seam routes to codex (the row's stand-down). All
 * eight rows repeat the same three-line guard and the same home lookup
 * (`codexHome(resolvedBackendConfig(config, "codex"))`); this folds them so a change to how
 * doctor reads codex's home touches one spot instead of seven. `home` is always the team's
 * codex home, whether or not the row needs it. */
function codexCheckBase(
  root: string,
): { config: TumwaterConfig; home: string } | CheckOutcome | null {
  const config = loadConfigForCheck(root);
  if ("level" in config) return config;
  if (!codexSeamsInUse(config)) return null;
  return { config, home: codexHome(resolvedBackendConfig(config, "codex")) };
}

/** One bounded probe of the resolved `codex` binary under the scrubbed run environment a real
 * run gets: resolve the binary through the codex adapter that would spawn it, point it at the
 * run's home (`CODEX_HOME`), and run `args` with a short deadline. Null when the probe could
 * not run, the child errored, or the deadline passed. The one home of the resolveBin + codexEnv
 * pairing the version and login rows share, so neither probes a different binary or environment
 * than the other. */
function codexProbe(
  config: TumwaterConfig,
  args: string[],
  pathEnv: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string } | null> {
  const resolved = codexBackend.resolveBin(config);
  const home = codexHome(resolvedBackendConfig(config, "codex"));
  const env = codexEnv(childEnv({ PATH: pathEnv }), { home });
  return boundedProbe(resolved.bin, args, env, timeoutMs, AUTH_CHECK_MAX_OUTPUT_BYTES);
}


/** codex CLI-version readiness (plans/codex-backend.md "Hand steps", H1): the team targets
 * `CODEX_MIN_VERSION` or later, the version H1 verified live. An installed CLI below that fails
 * naming the floor and the upgrade; at or above it reads the version. Stands down when no seam
 * routes to codex. */
export async function checkCodexVersion(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const result = await codexProbe(base.config, ["--version"], pathEnv, timeoutMs);
  const found = versionFromProbe(result);
  return minVersionOutcome("codex", found, CODEX_MIN_VERSION, "upgrade the codex CLI");
}

/** codex login readiness (plans/codex-backend.md §4, §7): a ChatGPT login is subscription
 * billing and passes; an API-key login is refused (decision 5 — Codex reports no cost, so an
 * API key would spend money the cap cannot see) with the startup gate's message; a logged-out
 * home fails naming the login command under the run's `CODEX_HOME`. A probe that could not run
 * or a reply this cannot read (neither a ChatGPT login, an API key, nor an explicit
 * not-logged-in) warns rather than guesses. Stands down when no seam routes to codex. */
export async function checkCodexAuth(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const { home } = base;
  const result = await codexProbe(base.config, ["login", "status"], pathEnv, timeoutMs);
  if (result?.code !== 0)
    return warnOutcome("could not check — `codex login status` did not run or its output was unreadable");
  const status = parseCodexLoginStatus(result.stdout);
  if (status === "subscription") return okOutcome("logged in using ChatGPT — billing: subscription");
  if (status === "api")
    return failOutcome(
      `Codex is logged in with an API key; tumwater runs Codex on a ChatGPT subscription only — run \`CODEX_HOME=${home} codex login --device-auth\``,
    );
  if (/Not logged in/i.test(result.stdout ?? ""))
    return failOutcome(`codex is not logged in — run \`CODEX_HOME=${home} codex login --device-auth\``);
  return warnOutcome("could not check — `codex login status` reply was unreadable");
}

/** codex home readiness (plans/codex-backend.md §4): unset `backends.codex.configDir` warns
 * that team runs share the operator's `~/.codex` — the trust entries, team sessions in the
 * `codex resume` picker, any skills and a global `AGENTS.md`. Set, it reads the team home.
 * Stands down when no seam routes to codex. */
export async function checkCodexHome(root: string): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const configDir = resolvedBackendConfig(base.config, "codex").configDir;
  if (configDir === undefined)
    return warnOutcome(
      "backends.codex.configDir is unset — team runs share the user's ~/.codex (trust entries, team sessions in the resume picker, skills, a global AGENTS.md); set backends.codex.configDir to a home of the team's own",
    );
  return okOutcome(`team codex home: ${codexHome({ configDir })}`);
}

/** codex model readiness (plans/codex-backend.md §7): every codex-routed model must be in the
 * home's catalog (`models_cache.json`) — a missing model warns that its thinking levels and
 * window are unknown, and a thinking level the catalog does not list warns that it is dropped.
 * The cataloged models are reported with their context window. Stands down when no seam routes
 * to codex. */
export async function checkCodexModels(root: string): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const { config, home } = base;
  const catalog = readCodexCatalog(home);
  const models = seamedModels(config, "codex");
  const warns: string[] = [];
  const notes: string[] = [];
  for (const pair of models) {
    const entry = catalog.get(pair.model!);
    if (entry === undefined) {
      warns.push(`${pair.model} is not in the codex catalog (models_cache.json) — thinking levels and the window are unknown`);
      continue;
    }
    const window = tokenWindowLabel(entry.contextWindow);
    notes.push(`${pair.model} — ${window}`);
    // A level is dropped when the run path would send no effort for it: `codexEffort` maps the
    // thinking through EFFORT_BY_THINKING (off/minimal clamp to low) and yields undefined when
    // the model's catalog does not list that effort (part 5/9's codexEffort). A thinking level
    // with no mapping at all (e.g. ultra — never sent) is not a catalog gap, so it is not warned.
    if (
      pair.thinking !== undefined &&
      pair.thinking !== "" &&
      Object.hasOwn(EFFORT_BY_THINKING, pair.thinking) &&
      codexEffort(pair.thinking, entry.levels) === undefined
    ) {
      warns.push(`${pair.model} has no ${pair.thinking} thinking level in the catalog — that level is dropped`);
    }
  }
  if (warns.length > 0) {
    const extra = notes.length > 0 ? `; ${notes.join("; ")}` : "";
    return warnOutcome(`${warns.join("; ")}${extra}`);
  }
  return okOutcome(notes.length > 0 ? `codex models ready — ${notes.join("; ")}` : "no codex-routed models declared");
}

/** A `has_credits` reading from the home's rollout captures, or null when none names it.
 * `has_credits` travels in each run's `token_count.rate_limits.credits` (design §7), so the
 * account row reads the captures a finished run left rather than a live probe — the same
 * source the runtime account is fed from. The newest capture (by file mtime) wins,
 * approximating the account's current state — readdir order is filesystem order, not
 * chronological, so the captures are sorted by mtime first. A missing reading is the safe
 * direction (nothing to warn about). */
function codexSessionCredits(home: string): boolean | null {
  const sessions = path.join(home, "sessions");
  if (!isDirectory(sessions)) return null;
  const rollouts: { file: string; mtimeMs: number }[] = [];
  // The walk-and-swallow recursion is files.ts's walkFiles; each rollout file is statted so
  // the newest (by mtime) can win below.
  walkFiles(sessions, (file, entry) => {
    if (/^rollout-.*\.jsonl$/.test(entry.name)) {
      const st = statOrNull(file);
      if (st !== null) rollouts.push({ file, mtimeMs: st.mtimeMs });
    }
  });
  rollouts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const r of rollouts) {
    const text = readTextOrNull(r.file);
    if (text === null) continue;
    const m = /"has_credits"\s*:\s*(true|false)/.exec(text);
    if (m !== null) return m[1] === "true";
  }
  return null;
}

/** codex account readiness (plans/codex-backend.md §7 "Credits"): a Plus account can buy
 * credits that run past the windows, and tumwater never spends them on purpose but cannot see
 * the amount, so doctor warns when the runs' captures report `has_credits: true` — the run that
 * crosses a limit may draw on them. Otherwise it reads ok with the safe direction. Stands down
 * when no seam routes to codex. */
export async function checkCodexAccount(root: string): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const { home } = base;
  const hasCredits = codexSessionCredits(home);
  if (hasCredits === true)
    return warnOutcome(
      "the codex account can buy credits (has_credits: true) — a run that crosses a limit may spend credits tumwater cannot count; clear the credit balance or accept the blind spend",
    );
  return okOutcome(hasCredits === false ? "no credits — runs stop at the subscription window" : "no credit reading yet — runs stop at the subscription window");
}

/** codex home leaks (plans/codex-backend.md §4): the operator's home `AGENTS.md`, any
 * `skills/` entry beyond `.system`, any `hooks/` entry, and the target repo's
 * `.codex/config.toml` MCP servers each still load into team runs, so each is named as one
 * warning. Stands down when no seam routes to codex. */
export async function checkCodexLeaks(root: string): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const { home } = base;
  const warns: string[] = [];
  const agentsMd = path.join(home, "AGENTS.md");
  if (statOrNull(agentsMd)?.isFile() === true) warns.push(`${agentsMd} still loads into team runs`);
  const skills = path.join(home, "skills");
  if (isDirectory(skills)) {
    for (const entry of fs.readdirSync(skills)) {
      if (entry === ".system") continue;
      warns.push(`${path.join(skills, entry)} — a skill beyond .system still loads into team runs`);
    }
  }
  const hooks = path.join(home, "hooks");
  if (isDirectory(hooks)) {
    for (const entry of fs.readdirSync(hooks)) warns.push(`${path.join(hooks, entry)} — a hook still loads into team runs`);
  }
  // The target repo's own `.codex/config.toml` MCP servers (design §4): a repo-local config
  // with an `[mcp_servers.NAME]` section loads those servers into every team run here.
  const repoConfig = path.join(root, ".codex", "config.toml");
  const text = readTextOrNull(repoConfig);
  if (text !== null) {
    const servers = [...text.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm)].map((m) => m[1]);
    for (const server of servers) warns.push(`${repoConfig} configures MCP server ${server}, which loads into team runs`);
  }
  if (warns.length === 0) return okOutcome("no codex home leaks");
  return warnOutcome(warns.join("; "));
}

/** The size of the home's `sessions/` (plans/codex-backend.md §4): the retention knob prunes
 * expired sessions, and doctor reports how much the collection holds so the operator can size
 * the knob. Stands down when no seam routes to codex. */
export async function checkCodexSessions(root: string): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const { home } = base;
  const sessions = path.join(home, "sessions");
  const size = isDirectory(sessions) ? treeBytes(sessions) : null;
  return okOutcome(size !== null ? `codex sessions: ${formatBytes(size)}` : "codex sessions: no sessions dir");
}

/** The bound on the codex write-guard row's trust lookup, matching the group's other calls. */
const CODEX_HOOK_TRUST_TIMEOUT_MS = 10_000;

/** codex write-guard readiness (plans/codex-write-guard.md "Visibility (parts 8–9)"): whether
 * codex runs the trusted write-guard hook under this team's home, so the operator sees whether
 * codex edits are guarded and why not when they are not. Asks codex's own `hooks/list` through
 * codexHookTrust for the current build's definition, bounded like the group's other Codex calls;
 * the cache file it writes is the one writable surface Doctor keeps. A trust reading gives the
 * pass row naming the hash's first 12 hex; a failed lookup warns with its reason — codex then
 * runs edits without the worktree check. Stands down when no seam routes to codex. */
export async function checkCodexWriteGuard(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = CODEX_HOOK_TRUST_TIMEOUT_MS,
): Promise<CheckOutcome | null> {
  const base = codexCheckBase(root);
  if (base === null || "level" in base) return base;
  const resolved = codexBackend.resolveBin(base.config);
  const { home } = base;
  const env = codexEnv(childEnv({ PATH: pathEnv }), { home });
  const definition = codexWriteGuardDefinition();
  try {
    const trust = await codexHookTrust(root, { bin: resolved.bin, env, cwd: root, definition, timeoutMs });
    return okOutcome(`trusted (sha256:${trust.hash.replace(/^sha256:/, "").slice(0, 12)})`);
  } catch (error) {
    return warnOutcome(`off: ${errorMessage(error)} — codex runs edit without the worktree check`);
  }
}
