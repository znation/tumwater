import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enabledRoleIds,
  parseJsonConfig,
  loadConfig,
  loadConfigSafe,
} from "../config/config.js";
import { exampleConfigProblem, exampleDrift } from "../config/config-example.js";
import type { TumwaterConfig } from "../config/config-schema.js";
import { bootstrapStatus } from "../gates/bootstrap-gates.js";
import { envPath, findOnPath, readTextOrNull, treeBytes, xdgConfigHomeDir } from "../files/files.js";
import { readJsonFile } from "../files/json-files.js";
import { PACKAGE_JSON, belowNodeFloor, packageEnginesNode } from "../version.js";
import { GIT_MISSING_MESSAGE } from "../git/git-run.js";
import {
  branchExists,
  currentBranch,
  hasCommits,
  branchesPhrase,
  isGitRepo,
  repoToplevel,
} from "../git/git.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  teamWorkspaceMessage,
  NO_COMMITS_MESSAGE,
} from "../gates/readiness.js";
import { backendBinSourceLabelFor, backendMissingMessage, findBackendBinary, resolveBackendBin } from "../pi/pi-bin.js";
import { resolvedBackendConfig } from "../config/config-views.js";
import { CONFIG_BASENAME, EXAMPLE_CONFIG_BASENAME, configPath, owningTeamRoot } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { formatBytes } from "../text/format.js";
import { BRIEF_TEXT_MAX_CHARS, briefFile, promptBlockOf, readBrief } from "../brief/brief.js";
import { plural } from "../text/phrases.js";
import { backendsInUse, unregisteredBackendInUse } from "../gates/startup-gate.js";
import { claudeSeamsInUse, minVersionOutcome, opencodeSeamsInUse, versionFromProbe, piSeamsInUse } from "./doctor-model-checks.js";
import { claudeConfigDir } from "../agent/claude/claude-backend.js";
import { AUTH_CHECK_MAX_OUTPUT_BYTES, AUTH_CHECK_TIMEOUT_MS, boundedProbe } from "./probe.js";
import { childEnv } from "../process/process.js";
import { opencodeBackend, OPENCODE_MIN_VERSION } from "../agent/opencode/opencode-backend.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";
import { spawnSync } from "node:child_process";

/** The environment/tooling and repo-setup pre-flight checks, split out of
 * doctor.ts. The shared report contract (CheckOutcome and its constructors) lives in
 * outcome.ts so it can be imported by every check module — including this one and
 * doctor-model-checks.ts, which cannot value-import each other — and the toolchain and
 * repo-setup checks live here alongside it: the node/git/exec binaries, the repo/init/
 * config-key/brief/bootstrap setup, the agent backends' CLI versions, and the operator
 * pi-extension/funes coordination. The checks that inspect the project's own on-disk state,
 * disk and build (a writable .tumwater, a readable event feed, disk headroom, the declared
 * check, the flake memory and build provenance) live in doctor-project-checks.ts; the
 * worktree/process contention checks (the merge lock, the worktree pool, the three wait rows,
 * the instance/pin/branch audits) live in doctor-contention-checks.ts; the model-readiness
 * checks (the cap fallback, the agent binary's credential probe, the declared tiers) live in
 * doctor-model-checks.ts; the backlog-document checks (BUGS.md / PLANS.md readers) live in
 * doctor-backlog-plans.ts and doctor-backlog-bugs.ts beside
 * doctor-backlog.ts's shared helpers; the report's terminal rendering lives beside the CLI's other
 * Markdown/terminal renderers (doctor-render.ts). doctor.ts stays the composition layer only:
 * runDoctor calls each check in fixed order and folds the results into a DoctorReport. */

/** One seam in doctor's routing table: the human label naming it, the selector it runs on
 * (agent-qualified for a non-pi backend), and the backend it routes to. */
interface SeamRow {
  label: string;
  selector: string;
  backend: string;
}

/** The full pre-flight report: a header carrying harness state, one entry per check in fixed
 * order, the routing table of every seam the config can spawn, and the verdict line. */
export interface DoctorReport {
  header: string;
  checks: Array<{ name: string } & CheckOutcome>;
  routing: SeamRow[];
  verdict: string;
}

/** The floor doctor falls back to when package.json — the one source of the declared
 * engines.node spec, read below — cannot be read (a broken install, the version command's
 * story). The CLI's startup gate enforces the spec itself; this check stays a warning so a
 * runtime that usually still works does not block a scripted pre-flight. */
const NODE_FLOOR_FALLBACK = ">=20";

/** Node runtime — warn when this process runs below the declared floor: package.json's
 * engines.node spec, the same one the CLI's startup gate fails on, read here so the check
 * and the gate cannot drift (the literal fallback above covers only an unreadable package).
 * The comparison is belowNodeFloor's component-wise spec match, not a major-only read, so
 * `v20.0.0` against `>=20.3` warns here exactly as the gate refuses it. Takes the version
 * string (defaulting to process.versions.node) so the below-floor branch is unit-testable
 * without swapping the runtime. A warning, not a failure: doctor reports the mismatch so the
 * operator can decide, and a runtime that usually still works does not block a scripted
 * pre-flight. */
export function checkNodeVersion(
  version: string = process.versions.node,
  floor: string = packageEnginesNode(PACKAGE_JSON) ?? NODE_FLOOR_FALLBACK,
): CheckOutcome {
  const major = Number.parseInt(version, 10);
  if (!Number.isInteger(major) || major <= 0)
    return warnOutcome(`unrecognized Node version ${JSON.stringify(version)}`);
  if (!belowNodeFloor(version, floor)) return okOutcome(`v${version}`);
  return warnOutcome(`v${version} is below the ${floor} Node floor declared in package.json engines — upgrade Node`);
}

/** git binary — fail with the shared GIT_MISSING_MESSAGE so every entry point reports the
 * same fix for a machine without git installed. Takes an explicit PATH so tests can exercise
 * the missing branch by passing "" (no PATH mutation, no spawning). The agent-binary check's
 * rule is richer (bare name vs path-shaped) and lives in pi/pi-bin.ts's findBackendBinary. */
export function checkGitBinary(pathEnv: string = envPath()): CheckOutcome {
  const found = findOnPath("git", pathEnv);
  if (!found) return failOutcome(GIT_MISSING_MESSAGE);
  return okOutcome(found);
}

/** The running team's own node binary is still on disk — a Homebrew node upgrade under the
 * team deletes the old keg while the team keeps running on it, leaving `process.execPath`
 * naming a file that no longer exists (BUGS.md 2026-10-21). Every harness spawn that does not
 * fall back to PATH's `node` errors until the operator restarts the team on the new node, so
 * doctor surfaces it as a warn. Takes an explicit path so tests exercise the missing branch
 * without touching this process. */
export function checkExecPath(execPath: string = process.execPath): CheckOutcome {
  if (fs.existsSync(execPath)) return okOutcome(execPath);
  return warnOutcome(
    `the running team's node binary ${execPath} no longer exists — node was upgraded under it; restart the team on the new node`,
  );
}

/** Repo ready — the git/git.ts predicates in requireReadyRepo's order, so doctor and the
 * readiness gate cannot drift: not a git repo → no commits yet → detached HEAD. Reports the
 * resolved toplevel (not the cwd — doctor must say where .tumwater/ lives) and the branch the
 * team would target: a configured `baseBranch` wins (`run --branch` is per-invocation), and
 * one that does not exist fails here instead of at the first run. `config` is optional so
 * the check stands alone; runDoctor passes the loaded config behind a guard. */
export async function checkRepo(root: string, config?: TumwaterConfig): Promise<CheckOutcome> {
  if (!(await isGitRepo(root))) return failOutcome(NOT_A_REPO_MESSAGE);
  if (!(await hasCommits(root))) return failOutcome(NO_COMMITS_MESSAGE);
  const toplevel = (await repoToplevel(root)) ?? root;
  const configured = config?.baseBranch;
  if (configured !== undefined) {
    if (!(await branchExists(root, configured))) {
      const existing = await branchesPhrase(root);
      return failOutcome(`repo at ${toplevel} — configured baseBranch ${configured} does not exist (branches: ${existing})`);
    }
    return okOutcome(`repo at ${toplevel} — targeting branch ${configured}`);
  }
  const branch = await currentBranch(root);
  if (branch === null) return failOutcome(DETACHED_HEAD_MESSAGE);
  return okOutcome(`repo at ${toplevel} — on branch ${branch}`);
}

/** Initialized + config valid — tumwater.json present and loadConfig does not throw. The fail
 * detail carries the thrown message verbatim: it already holds validateConfig's full problem
 * list, so one edit can fix them all. On a valid config it folds in template drift
 * (plans/portability.md §4a/7): when the tracked tumwater.example.json sets keys the local file
 * lacks, the check warns naming them — a warn never touches the exit code — with a remedy that
 * actually works (init skips an existing config, so reseeding means deleting it first), and the
 * no-drift detail stays the pinned "N roles enabled". A template that cannot serve as one —
 * unparseable or invalid — warns too: seedConfig silently seeds the bare defaults from it and
 * exampleDrift reports no drift, so without this the operator's template intent fails with no
 * signal anywhere (a broken template only bites fresh checkouts, which is exactly when nobody
 * is watching). The template problem outranks drift: drift is computed from a parse that has
 * already failed. */
export function checkInit(root: string): CheckOutcome {
  if (!fs.existsSync(configPath(root))) {
    const owner = owningTeamRoot(root);
    return failOutcome(owner === undefined ? NOT_INITIALIZED_MESSAGE : teamWorkspaceMessage(owner));
  }
  try {
    const config = loadConfig(root);
    const templateProblem = exampleConfigProblem(root);
    if (templateProblem !== null) {
      return warnOutcome(`broken template: ${templateProblem} — init seeds the bare defaults from it on fresh checkouts; fix the file so new clones get your roles/intervals baseline`);
    }
    const drift = exampleDrift(root);
    if (drift.length > 0) {
      return warnOutcome(`template drift: tumwater.json lacks keys ${EXAMPLE_CONFIG_BASENAME} sets (${drift.join(", ")})` +
          " — copy them in, or delete tumwater.json and re-run `tumwater init` to reseed from the " +
          "template (it omits machine keys like provider/model, so re-add those after reseeding)");
    }
    return okOutcome(`${enabledRoleIds(config).length} roles enabled`);
  } catch (err) {
    return failOutcome(errorMessage(err));
  }
}

/** Whether tumwater.json still spells keys by an old name (config-aliases.ts). Both spellings
 * load, so this only warns, naming each exact rename. Ok when the file is absent or broken
 * (checkInit reports that) or nothing in it is renamed. */
export function checkConfigKeyNames(root: string): CheckOutcome {
  const file = configPath(root);
  if (!fs.existsSync(file)) return okOutcome("no tumwater.json");
  const { renamed } = parseJsonConfig(file, CONFIG_BASENAME);
  if (renamed === undefined || renamed.length === 0) return okOutcome("current key names");
  return warnOutcome(`old key names: ${renamed.join(", ")} — rename them in tumwater.json; both spellings work until then`);
}

/** Which file holds the project brief (the managed brief text + status sections,
 * plans/portability.md §7a/7): TUMWATER.md first, README.md as the compatibility path. A repo
 * whose README carries no markers — or that has no brief at all — still boots, but every role
 * runs without its project prompt, so that state is a warning, not an error: it is exactly
 * what a repo looks like between `git clone` and `tumwater init` on purpose (e.g. 7b's
 * `--dry-run`). */
export function checkBrief(root: string): CheckOutcome {
  // briefFile throws on a brief candidate that exists but cannot be read (a directory at
  // the README.md path, a permission-lost file) — report it as the check's failure instead
  // of crashing doctor: the team would run without its brief every run.
  let owner: string | null;
  try {
    owner = briefFile(root);
  } catch (err) {
    return failOutcome(errorMessage(err));
  }
  if (owner) {
    const prompt = readBrief(root)?.prompt ?? "";
    if (prompt === "") {
      return warnOutcome(`${owner} carries an empty tumwater:prompt block — every role would run without its project brief; add the brief text or re-run \`tumwater init\``);
    }
    const raw = readTextOrNull(path.join(root, owner));
    if (raw !== null) {
      const block = promptBlockOf(raw);
      if (block !== null && block.length > BRIEF_TEXT_MAX_CHARS) {
        return warnOutcome(`brief in ${owner} is ${block.length} characters, over the ${BRIEF_TEXT_MAX_CHARS}-character read cap every role sees (the prompt is truncated at ${BRIEF_TEXT_MAX_CHARS} chars); hand-edit ${owner} to shrink the block below ${BRIEF_TEXT_MAX_CHARS} characters, or paste a shorter brief in the dashboard's Brief card`);
      }
    }
    return okOutcome(`brief in ${owner}`);
  }
  if (fs.existsSync(path.join(root, "README.md"))) {
    return warnOutcome(`README.md carries no tumwater:prompt markers — the team would run without its project brief; add the block or re-run \`tumwater init\``);
  }
  return warnOutcome("no brief file — run `tumwater init <prompt>` to seed one");
}

/** New-project bootstrap (plans/work-ratio.md, part 2/2): while active, report its progress as
 * an ok check — a young project's deliberate hold on the maintenance roles is not a fault. A
 * missing or unreadable config, or no `bootstrap` entry, reads as not bootstrapping. Read-only,
 * like every doctor check: it never writes the latch or runs the gate's poll. */
export function checkBootstrap(
  root: string,
  config: TumwaterConfig | undefined,
): CheckOutcome {
  const status = config ? bootstrapStatus(root, config) : null;
  if (!status?.active) return okOutcome("not bootstrapping");
  return okOutcome(`bootstrapping: ${status.plansDone}/${status.untilPlansDone} plans done — plan, feature and director runs`);
}

/** Resolve and test ONE agent's binary: the ok detail names the resolved path and its source
 * whenever the value is not the PATH default, so a configured binary is never mistaken for the
 * ambient one; a missing one fails with that agent's own message, so a wrong claude path never
 * reads as a missing pi. */
function backendBinaryCheck(
  config: Parameters<typeof resolveBackendBin>[0],
  agent: string,
  pathEnv: string,
): CheckOutcome {
  const resolved = resolveBackendBin(config, agent);
  const found = findBackendBinary(resolved, pathEnv);
  if (!found) return failOutcome(backendMissingMessage(resolved, agent));
  if (resolved.source === "default") return okOutcome(found);
  const from = backendBinSourceLabelFor(agent, resolved.source);
  return okOutcome(`${found} — resolved from ${from}`);
}

/** Agent binary (plans/portability.md §5/7) — every agent an enabled seam resolves to
 * (backendsInUse, the startup gate's rule), resolved through the same resolveBackendBin the spawn
 * uses, so doctor and the harness can never disagree about which binary runs (a malformed
 * tumwater.json resolves to the pi default; checkInit reports the config problem separately).
 * Executability is pi/pi-bin.ts's shared findBackendBinary — the same bare-name PATH lookup,
 * path-shaped accessSync(X_OK) rule, and null-on-unusable verdict the startup gate asks — so
 * doctor cannot pass a binary the gate would reject. resolveBackendBin normalizes path-shaped
 * values against the process cwd at resolution time, so what doctor tests is exactly what
 * spawns. A claude-only team checks claude, not pi. The check fails on the first missing
 * binary, naming its agent; an ok detail joins each agent's resolved path and source. */
export function checkBackendBinary(
  root: string,
  pathEnv: string = envPath(),
): CheckOutcome {
  const { config } = loadConfigSafe(root);
  const agents = config !== undefined ? backendsInUse(config) : ["pi"];
  // A seam backend with no registered adapter in this build can never run; naming that beats
  // the binary check (which would pass an installed binary only to fall through to pi). The
  // same rule and wording as the startup gate's, and it generalizes the same way: opencode
  // and codex now have adapters registered, so only a future id without one trips it.
  const unregistered = config !== undefined ? unregisteredBackendInUse(config) : undefined;
  if (unregistered !== undefined)
    return failOutcome(`backend ${unregistered} is configured but this build has no adapter for it`);
  const checks = agents.map((agent) => ({
    agent,
    outcome: backendBinaryCheck(config ?? {}, agent, pathEnv),
  }));
  const failed = checks.find(({ outcome }) => outcome.level === "fail");
  if (failed) return failed.outcome;
  if (checks.length === 1) return checks[0]!.outcome;
  return okOutcome(checks.map(({ agent, outcome }) => `${agent}: ${outcome.detail}`).join("; "));
}

/** OpenCode CLI-version readiness (plans/opencode-backend.md "Which OpenCode", part 7/7): the
 * team targets V2 at 2.0.32 or later, the version H1 verified live. An installed CLI below that
 * (a 1.x binary included) fails naming `brew install opencode`; at or above it reads the
 * version. Stands down when no seam routes to opencode, so a pi-only team spawns no opencode. */
export async function checkOpencodeVersion(
  root: string,
  pathEnv: string = envPath(),
  timeoutMs: number = AUTH_CHECK_TIMEOUT_MS,
): Promise<CheckOutcome> {
  const { config } = loadConfigSafe(root);
  if (config === undefined) return okOutcome("no readable tumwater.json — nothing to verify");
  if (!opencodeSeamsInUse(config)) return okOutcome("no model jobs run on opencode");
  const resolved = opencodeBackend.resolveBin(config);
  const result = await boundedProbe(
    resolved.bin,
    ["--version"],
    childEnv({ PATH: pathEnv }),
    timeoutMs,
    AUTH_CHECK_MAX_OUTPUT_BYTES,
  );
  const found = versionFromProbe(result, true);
  return minVersionOutcome("opencode", found, OPENCODE_MIN_VERSION, "run `brew install opencode`");
}

/** claude transcript disk — the total size of the claude config dir's `projects/`
 * (plans/agent-backends.md "Sessions" retention): the perf adapter ages transcripts out under
 * its own cleanupPeriodDays, so an operator asking where claude's disk went gets the number
 * without `du`. Informational (ok) in every case — a large transcript tree is a fact, not a
 * misconfiguration. Stands down when no seam routes to claude: a pi-only team reads no claude
 * state, and the report must not walk a host directory that has nothing to do with the team.
 * `homeDir` and `env` are test seams. */
export function checkClaudeTranscripts(
  config: TumwaterConfig | undefined,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): CheckOutcome {
  if (!config) return okOutcome("no readable tumwater.json — nothing to verify");
  if (!claudeSeamsInUse(config)) return okOutcome("no model jobs run on claude");
  const configDir = resolvedBackendConfig(config, "claude").configDir;
  const dir = path.join(claudeConfigDir(env, homeDir, configDir), "projects");
  let slugs: string[];
  try {
    slugs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return okOutcome(`no transcript dir at ${dir}`);
  }
  let bytes = 0;
  for (const slug of slugs) bytes += treeBytes(path.join(dir, slug));
  const projects = plural(slugs.length, "project");
  return okOutcome(`${formatBytes(bytes)} across ${projects} in ${dir}`);
}

/** Bounding for the `pi list` probe below: the packages a team run now skips are names, so a
 * short deadline and a small output cap keep an unlucky host from stalling doctor. */
const PI_LIST_TIMEOUT_MS = 5_000;
const PI_LIST_MAX_BYTES = 64 * 1024;

/** MCP server names in `~/.pi/agent/mcp.json` (the file pi's built-in MCP extension reads),
 * or `[]` for a missing/malformed file: the `mcpServers` keys, or `mcp.<name>`. Best-effort
 * naming so a server the operator meant for the team is surfaced even when the file is odd. */
function piMcpServerNames(file: string): string[] {
  // The tolerant read-and-parse half (missing, torn, scalar, `null`, or array file is "no
  // data", never an error) is src/files/json-files.ts's readJsonFile, the same shared
  // convention every other state/marker/info file reader uses.
  const parsed = readJsonFile<Record<string, unknown>>(file);
  if (parsed === null) return [];
  const names = new Set<string>();
  const serverMap = parsed["mcpServers"];
  if (serverMap && typeof serverMap === "object")
    for (const name of Object.keys(serverMap)) names.add(name);
  const mcp = parsed["mcp"];
  if (mcp && typeof mcp === "object")
    for (const [name, value] of Object.entries(mcp))
      if (name !== "servers" && value && typeof value === "object") names.add(name);
  return [...names];
}

/** The operator pi state a team run now skips (plans/notes-command.md "Keeping funes out of
 * team runs"): installed packages (`pi list`, bounded), files in `~/.pi/agent/extensions`, and
 * MCP servers in `~/.pi/agent/mcp.json`. Each is named, so a package, extension file, or server
 * the operator meant for the team does not vanish silently when pi loads none of it. Shown only
 * when a model job runs on pi; returns null otherwise so doctor omits the row and never reads
 * a host `~/.pi` a pi-only-install team does not use. `homeDir` and `pathEnv` are test seams. */
export function checkPiExtensions(
  config: TumwaterConfig | undefined,
  homeDir: string = os.homedir(),
  pathEnv: string = envPath(),
): CheckOutcome | null {
  if (!config) return null;
  if (!piSeamsInUse(config)) return null;
  const parts: string[] = [];
  // Installed pi packages (pi list, bounded): each stdout line a package name. A probe that
  // cannot run or produces nothing contributes nothing; the rest still name what team runs skip.
  const resolved = resolveBackendBin(config, "pi");
  const piBin = findBackendBinary(resolved, pathEnv);
  if (piBin !== null) {
    try {
      const stdout = spawnSync(piBin, ["list"], {
        encoding: "utf8",
        timeout: PI_LIST_TIMEOUT_MS,
        maxBuffer: PI_LIST_MAX_BYTES,
        killSignal: "SIGKILL",
      }).stdout;
      // `pi list` is not line-per-package: each package is a two-space-indented source line
      // (optionally followed by its installed path at four spaces), under the bold `User
      // packages:` / `Project packages:` headers. Keep only the two-space source lines so the
      // headers and installed paths are not mistaken for packages.
      const packages = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.replace(/\r$/, ""))
        .map((line) => /^  (\S.*)$/.exec(line)?.[1]?.trim())
        .filter((name): name is string => name !== undefined && name.length > 0);
      if (packages.length > 0) parts.push(`packages: ${packages.join(", ")}`);
    } catch {
      // A `pi list` that could not be read just names nothing; extensions/servers below still show.
    }
  }
  // Files in ~/.pi/agent/extensions.
  try {
    const files = fs
      .readdirSync(path.join(homeDir, ".pi", "agent", "extensions"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    if (files.length > 0) parts.push(`~/.pi/agent/extensions: ${files.join(", ")}`);
  } catch {
    // Absent or unreadable; nothing to name.
  }
  // MCP servers named in ~/.pi/agent/mcp.json (the file pi's MCP built-in reads).
  const mcpNames = piMcpServerNames(path.join(homeDir, ".pi", "agent", "mcp.json"));
  if (mcpNames.length > 0) parts.push(`mcp.json servers: ${mcpNames.join(", ")}`);
  if (parts.length === 0)
    return okOutcome("team pi runs skip discovered extensions; none found on this host");
  return okOutcome(`team pi runs skip discovered extensions: ${parts.join("; ")}`);
}

/** The operator's global opencode config files, in XDG order — the same home `opencode-config.ts`
 * reads for MCP names. Home is the operator's home; `$XDG_CONFIG_HOME`, when set, wins. */
function opencodeGlobalConfigPaths(homeDir: string): string[] {
  const configHome = xdgConfigHomeDir(process.env, homeDir);
  return ["config.json", "opencode.json", "opencode.jsonc"].map((file) =>
    path.join(configHome, "opencode", file),
  );
}

/** Report the operator's global opencode config file that mentions funes, or null.
 * A best-effort note (the design's doctor `funes` row) so an operator who installed funes's
 * OpenCode integration is told it could reach an OpenCode team; a malformed file reads nothing. */
function opencodePluginNamesFunes(
  homeDir: string,
  readPath: (file: string) => string | null,
): string | null {
  for (const file of opencodeGlobalConfigPaths(homeDir)) {
    const text = readPath(file);
    if (text === null) continue;
    // A global config that mentions funes in or near a plugin reference is worth naming; the
    // exact JSON shape varies by version (array or object), so a substring scan over the text is
    // the honest check.
    if (/"plugin(s)?"\s*[:\[\{]/.test(text) && /funes/i.test(text)) return file;
  }
  return null;
}

/** The `funes` row (plans/notes-command.md "Keeping funes out of team runs"): whether the
 * transcript-recall tool you use for your own sessions can reach the team. Shows only when
 * `funes` is on PATH (else no row at all) and warns when a Claude Code team runs without a
 * `backends.claude.configDir` while funes's Claude Code hook is installed (`~/.funes/
 * integrations/claude-plugin`) — that hook indexes every session under `~/.claude/projects`,
 * which is exactly what a team config dir moves out from under. It also notes a global
 * OpenCode plugin naming funes. `pathEnv`, `homeDir`, and `readPath` are test seams. */
export function checkFunes(
  config: TumwaterConfig | undefined,
  pathEnv: string = envPath(),
  homeDir: string = os.homedir(),
  readPath: (file: string) => string | null = readTextOrNull,
): CheckOutcome | null {
  if (!config) return null;
  if (findOnPath("funes", pathEnv) === null) return null;
  const notes: string[] = [];
  if (claudeSeamsInUse(config)) {
    const configDir = resolvedBackendConfig(config, "claude").configDir;
    const plugin = path.join(homeDir, ".funes", "integrations", "claude-plugin");
    if (configDir === undefined && fs.existsSync(plugin)) {
      return warnOutcome(
        "funes's Claude Code hook indexes team transcripts into your personal memory — set backends.claude.configDir and log in there once (`CLAUDE_CONFIG_DIR=<dir> claude auth login`)",
      );
    }
    notes.push(
      configDir === undefined
        ? "Claude Code runs use the default config dir (no funes Claude Code hook installed)"
        : "Claude Code runs use their own config dir",
    );
  }
  const opencodePlugin = opencodePluginNamesFunes(homeDir, readPath);
  if (opencodePlugin !== null) notes.push(`global OpenCode config mentions funes (${opencodePlugin})`);
  const detail = notes.length > 0 ? `funes on PATH, no team reach: ${notes.join("; ")}` : "funes on PATH, no team reach";
  return okOutcome(detail);
}

