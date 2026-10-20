import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enabledRoleIds,
  knownRoleIds,
  parseJsonConfig,
  loadConfig,
  loadConfigSafe,
  defaultConfig,
  slotCount,
} from "../config/config.js";
import { exampleConfigProblem, exampleDrift } from "../config/config-example.js";
import { detectBuildCheck } from "../build/build-check-detect.js";
import { isPassingFullCheck } from "../build/build-check-events.js";
import { CUSTOM_NAME_RE, type CheckConfigSlice, type TumwaterConfig } from "../config/config-schema.js";
import { bootstrapStatus } from "../gates/bootstrap-gates.js";
import { type BuildInfo, type BuildStatus, buildStaleness, isSelfHosted, readBuildInfo, STALE_INPUTS_LABEL } from "../build/build-info.js";
import { envPath, findOnPath, readTextOrNull, subdirectoryNames, treeBytes } from "../files/files.js";
import { readJsonFile } from "../files/json-files.js";
import { PACKAGE_JSON, belowNodeFloor, packageEnginesNode } from "../version.js";
import { GIT_MISSING_MESSAGE } from "../git/git-run.js";
import {
  branchExists,
  currentBranch,
  hasCommits,
  branchesPhrase,
  commitExists,
  isGitRepo,
  listBranches,
  refSha,
  refsUnder,
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
import { piModelsPath } from "../pi/pi-models.js";
import { piSettingsPath, readPiDefaultModel } from "../pi/pi-settings.js";
import { seamConcurrencyKey } from "../config/config-views.js";
import { resolvedBackendConfig } from "../config/config-views.js";
import { seamsInUse } from "../config/config-fallbacks.js";
import { enforcedKeyCaps } from "../concurrency/semaphore.js";
import { classifyLock, readLockPid } from "../concurrency/lock.js";
import { CONFIG_BASENAME, EXAMPLE_CONFIG_BASENAME, branchName, STATE_DIR, configPath, eventsLogPath, mergeLockDir, owningTeamRoot, worktreesDir } from "../paths.js";
import { BYTES_PER_GB, diskVolumePath, sampleFreeBytes } from "../gates/disk-gate.js";
import { errorMessage, textOr } from "../text/text.js";
import { lowerMedian, rankCountEntries } from "../collections.js";
import { formatBytes, formatGB, shortSha } from "../text/format.js";
import { briefFile } from "../brief/brief.js";
import { eventLogState, eventsSince, readEventsSince, type EventLogState } from "../events/event-window.js";
import { finiteNumber, stringList } from "../files/json-object.js";
import type { HarnessEvent } from "../events/events.js";
import { agree, plural, shortSpanPhrase } from "../text/phrases.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";
import { readSlotsState } from "../git/slots-state.js";
import { backendsInUse, unregisteredBackendInUse } from "../gates/startup-gate.js";
import { claudeSeamsInUse, opencodeSeamsInUse, piSeamsInUse, AUTH_CHECK_MAX_OUTPUT_BYTES, AUTH_CHECK_TIMEOUT_MS } from "./doctor-model-checks.js";
import { claudeConfigDir } from "../agent/claude/claude-backend.js";
import { boundedProbe } from "./probe.js";
import { childEnv } from "../process/process.js";
import { opencodeBackend, OPENCODE_MIN_VERSION } from "../agent/opencode/opencode-backend.js";
import { failOutcome, okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";
import { spawnSync } from "node:child_process";
import { loadRunnerState } from "../runner/runner-state-load.js";
import { INSTANCE_ROLES, runnerEnabled, runnerIds } from "../roles/runner-ids.js";
import { CLAIM_IDLE_MAX_MS, listedKeys } from "../scheduling/claims.js";
import { flakeCounts, KNOWN_FLAKE_WINDOW_MS } from "../review/known-flakes.js";

/** The environment/repo pre-flight checks, split out of
 * doctor.ts. The shared report contract (CheckOutcome and its constructors) lives in
 * outcome.ts so it can be imported by every check module — including this one and
 * doctor-model-checks.ts, which cannot value-import each other — and the environment and repo
 * checks live here alongside it. The model-readiness checks (the cap
 * fallback, the agent binary's credential probe, the declared tiers) live in
 * doctor-model-checks.ts; the backlog-document checks (BUGS.md / PLANS.md readers) live in
 * doctor-backlog.ts; the report's terminal rendering lives beside the CLI's other
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
  if (owner) return okOutcome(`brief in ${owner}`);
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
  // same rule and wording as the startup gate's. After opencode's adapter lands (part 5/7)
  // this stays the general rule for any future id.
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

/** claude transcript disk — the total size of the claude config dir's `projects/`
 * (plans/agent-backends.md "Sessions" retention): the perf adapter ages transcripts out under
 * its own cleanupPeriodDays, so an operator asking where claude's disk went gets the number
 * without `du`. Informational (ok) in every case — a large transcript tree is a fact, not a
 * misconfiguration. Stands down when no seam routes to claude: a pi-only team reads no claude
 * state, and the report must not walk a host directory that has nothing to do with the team.
 * `homeDir` and `env` are test seams. */
/** The dotted version in `opencode --version` (prints `opencode v2.0.32`), or undefined when it
 * names none. */
function parseOpencodeCliVersion(output: string): string | undefined {
  return /v(\d+\.\d+\.\d+)/.exec(output)?.[1];
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
  const found = result !== null && result.code === 0 ? parseOpencodeCliVersion(result.stdout) : undefined;
  if (found === undefined)
    return warnOutcome("could not check — `opencode --version` did not run or its output was unreadable");
  if (belowNodeFloor(found, `>=${OPENCODE_MIN_VERSION}`))
    return failOutcome(`opencode ${found} is older than ${OPENCODE_MIN_VERSION} — run \`brew install opencode\``);
  return okOutcome(`opencode ${found} (>= ${OPENCODE_MIN_VERSION})`);
}

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
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
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

/** .tumwater writable — absent is fine (created on first run); present, prove it by writing
 * and deleting a temp file inside. The probe leaves the dir's listing unchanged after the run.
 * The write is the property under test: only a write that fails is "not writable", so the
 * cleanup below — deleting the probe, sweeping stales — never vetoes a dir the write just
 * proved writable, and a probe left over is swept rather than accumulated. */
export function checkStateDir(root: string): CheckOutcome {
  const dir = path.join(root, STATE_DIR);
  if (!fs.existsSync(dir)) return okOutcome("absent — created on first run");
  const probe = path.join(dir, `.doctor-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
  } catch (err) {
    // A partial write may already have created the file — sweep it like any other leftover.
    sweepStaleProbes(dir);
    return failOutcome(`not writable: ${errorMessage(err)}`);
  }
  // The write proved writability. Deleting the probe is cleanup, not measurement: a removal
  // failure must not turn a succeeded write into a false alarm, and the stray is collected by
  // the sweep below (or a later pass's sweep).
  try {
    fs.rmSync(probe);
  } catch {
    // Best-effort — the stray is swept in a moment.
  }
  sweepStaleProbes(dir);
  return okOutcome("writable");
}

/** Best-effort removal of every `.doctor-probe-*` file in `dir` — the only artifact
 * checkStateDir creates, so any present probe is a leftover: a prior run killed between its
 * write and delete, a partial write above, or a removal that failed. Removed one at a time so
 * a single unremovable probe cannot stop the sweep. */
function sweepStaleProbes(dir: string): void {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // Unreadable dir — nothing to sweep.
  }
  for (const name of names) {
    if (!name.startsWith(".doctor-probe-")) continue;
    try {
      fs.rmSync(path.join(dir, name));
    } catch {
      // Best-effort — leave it for the next pass.
    }
  }
}

/** Event log readable — open and parse events.jsonl (and its rotated archive) so the one
 * failure the selfcheck role is chartered to catch — a feed that hid itself — is named by the
 * pre-flight too. An absent or empty log is fine: a young project writes its first event on the
 * first run. A present-but-unparseable log (a directory at the path, a permission failure, or
 * every complete line corrupt) fails, because every observer — selfcheck, the TUI/GUI feeds,
 * `logs`, `report` — reads that one feed. Read-only. */
export function checkEventLog(root: string): CheckOutcome {
  let state: EventLogState;
  try {
    state = eventLogState(root);
  } catch (err) {
    return failOutcome(`could not read ${eventsLogPath(root)}: ${errorMessage(err)}`);
  }
  if (state === "unreadable")
    return failOutcome(`unreadable: ${eventsLogPath(root)} — the team's event feed cannot be read`);
  if (state === "empty") return okOutcome("no events yet");
  return okOutcome(`readable: ${eventsLogPath(root)}`);
}

/** Disk floor (plans/disk-floor.md, parts 1/4 and 2/4) — is there room on the volume the
 * worktrees live on? Fail below `diskHoldGB`, the same floor the running team holds new work
 * at, so doctor and the gate agree on when the disk is a problem. Warn in the band between
 * `diskHoldGB` and `diskReclaimGB`: pressure reclaim will delete ignored build outputs from
 * idle worktrees but the team still runs. Ok at or above `diskReclaimGB` (or when reclaim is
 * disabled and free space is above the hold). A statfs failure is a warning, not a failure: an
 * unmeasurable volume never holds the team, so it must not fail a scripted pre-flight. The
 * detail names the measured path, the free GB to one decimal, and the floor. `holdGB` 0
 * disables the hold, so a free space above `reclaimGB`'s own band (or `reclaimGB` 0) passes.
 * After a successful sample the detail also carries `diskReclaimPhrase` (what `disk_reclaim`
 * passes freed over the last 24 h); it is informational and never changes the level. */
export function checkDiskSpace(
  root: string,
  holdGB: number,
  reclaimGB: number,
  sample: (root: string) => number | null = sampleFreeBytes,
): CheckOutcome {
  const where = diskVolumePath(root);
  const free = sample(root);
  if (free === null)
    return warnOutcome(`cannot measure free space at ${where} (statfs failed) — the disk hold is off for this process`);
  const freeGB = free / BYTES_PER_GB;
  const freeText = `${formatGB(freeGB)} free at ${where}`;
  const phrase = diskReclaimPhrase(readEventsSince(root, 24 * 60 * 60 * 1000).events);
  const withReclaim = (detail: string) => (phrase ? `${detail} · ${phrase}` : detail);
  if (holdGB > 0 && freeGB < holdGB)
    return failOutcome(withReclaim(`${freeText} — below the ${holdGB} GB diskHoldGB floor; the team waits to start new work until space recovers`));
  if (reclaimGB > 0 && freeGB < reclaimGB)
    return warnOutcome(withReclaim(`${freeText} — below the ${reclaimGB} GB diskReclaimGB threshold; a pressure reclaim pass deletes ignored build outputs from idle worktrees`));
  const floor = holdGB > 0 ? `above the ${holdGB} GB floor` : "diskHoldGB is 0 (hold disabled)";
  return okOutcome(withReclaim(`${freeText}, ${floor}`));
}

/** The `reclaim in the last 24h freed …` phrase for the `disk space` row: the summed
 * `freedGB` of the `disk_reclaim` passes, their count, and how many ran under pressure (an
 * event without a `mode` counts as pressure, like its feed line). Each pass is a point event,
 * so summing cannot straddle the window edge. Undefined when no pass ran. */
export function diskReclaimPhrase(events: readonly HarnessEvent[]): string | undefined {
  const passes = events.filter((e) => e.type === "disk_reclaim");
  if (passes.length === 0) return undefined;
  const freed = passes.reduce((sum, e) => sum + finiteNumber(e.freedGB, 0), 0);
  const pressure = passes.filter((e) => (typeof e.mode === "string" && e.mode ? e.mode : "pressure") === "pressure").length;
  const base = `reclaim in the last 24h freed ${formatGB(freed)} over ${plural(passes.length, "pass", "passes")}`;
  return pressure > 0 ? `${base}, ${pressure} under pressure` : base;
}

/** Merge lock — read-only classification via classifyLock (the same three cases the breaker
 * uses). A stale lock is a warning, not a failure: it self-heals on the next merge. */
export function checkMergeLock(root: string): CheckOutcome {
  const dir = mergeLockDir(root);
  switch (classifyLock(dir)) {
    case "absent":
      return okOutcome("not held");
    case "live": {
      const pid = readLockPid(dir);
      return okOutcome(pid !== null ? `held by running role (pid ${pid})` : "held (pid not yet written)");
    }
    case "stale":
      return warnOutcome("stale — will be broken on next merge");
  }
}

/** A pin older than a day is the doctor's stuck-pin signal: a paused or retired role is holding
 * a pooled checkout nobody will reuse (plans/worktree-pool.md, "Observability"). */
const PIN_STALE_MS = 24 * 60 * 60 * 1000;

/** Directory names under the worktrees root that the pool no longer owns: a legacy per-role
 * `<role>` checkout (the pre-pool layout) or a `_land-<role>` checkout from the merge queue. The
 * dedicated `director`, `_slot-<n>`, `_merge`, `_main`, `_gate-main` and `_build` checkouts are
 * expected and never reported. An unreadable worktrees dir means nothing to report. */
function leftoverWorktreeDirs(root: string): string[] {
  return subdirectoryNames(
    worktreesDir(root),
    (name) => name !== DIRECTOR_ROLE && !(name.startsWith("_") && !name.startsWith("_land-")),
  );
}

/** The window of `slot_wait` events the pool row sums, and the total wait inside it that warns. */
const SLOT_WAIT_CHECK_WINDOW_MS = 24 * 3600_000;
const SLOT_WAIT_WARN_TOTAL_MS = 10 * 60_000;

const PROVIDER_WAIT_CHECK_WINDOW_MS = 24 * 3600_000;
const PROVIDER_WAIT_WARN_TOTAL_MS = 10 * 60_000;

const CHECK_WAIT_CHECK_WINDOW_MS = 24 * 3600_000;
const CHECK_WAIT_WARN_TOTAL_MS = 10 * 60_000;

/** Worktree pool (plans/worktree-pool.md, part 5/5): report the pooled slots and warn on the
 * states an operator should act on — a legacy `<role>` or `_land-*` checkout the pool migration
 * left behind, a pin older than PIN_STALE_MS (a paused role holding a checkout), and the last
 * 24 h of `slot_wait` events totalling SLOT_WAIT_WARN_TOTAL_MS (the pool is too small). Read-only,
 * like every doctor check; `now` is a test seam for the pin-age arithmetic. */
export function checkWorktreePool(root: string, now = Date.now()): CheckOutcome {
  const slots = readSlotsState(root).slots;
  const leased = slots.filter((slot) => slot.lease !== null);
  const pins = slots.filter((slot) => slot.pinnedFor !== null);
  const stale = pins.filter(
    (slot) => slot.pinnedAt != null && now - slot.pinnedAt > PIN_STALE_MS,
  );
  const leftover = leftoverWorktreeDirs(root);
  const parts = [`${plural(slots.length, "workspace")}, ${leased.length} leased, ${pins.length} pinned`];
  if (leftover.length > 0) parts.push(`legacy worktrees still present: ${leftover.join(", ")}`);
  if (stale.length > 0) {
    parts.push(
      stale
        .map(
          (slot) =>
            `${textOr(slot.pinnedFor)} pinned on ${path.basename(slot.dir)} for ${Math.round(
              (now - (slot.pinnedAt ?? now)) / 3_600_000,
            )}h`,
        )
        .join("; "),
    );
  }
  let contended = false;
  try {
    const waits = eventsSince(root, SLOT_WAIT_CHECK_WINDOW_MS, now, (ev) => ev.type === "slot_wait");
    if (waits.length > 0) {
      let total = 0;
      let longest = waits[0]!;
      for (const ev of waits) {
        const waited = finiteNumber(ev.waitedMs, 0);
        total += waited;
        if (waited > finiteNumber(longest.waitedMs, 0)) longest = ev;
      }
      contended = total >= SLOT_WAIT_WARN_TOTAL_MS;
      const purpose = longest.purpose === "verify" ? "check" : "run";
      parts.push(
        `${plural(waits.length, "wait")} to start in the last 24h, ${shortSpanPhrase(total)} total, longest ${shortSpanPhrase(
          finiteNumber(longest.waitedMs, 0),
        )} (${textOr(longest.role)} ${purpose})${contended ? ` — raise worktreeSlots above ${slots.length}` : ""}`,
      );
    }
  } catch (err) {
    parts.push(`could not read the event log for waits to start: ${errorMessage(err)}`);
  }
  const warn = leftover.length > 0 || stale.length > 0 || contended;
  return (warn ? warnOutcome : okOutcome)(parts.join(" — "));
}

/** Provider-slot contention: sums the last 24 h of `provider_wait` events (each a role run
 * whose semaphore admission waited PROVIDER_WAIT_EVENT_MS or more, recorded in
 * orchestrator-launch.ts) and warns when the total reaches PROVIDER_WAIT_WARN_TOTAL_MS — the
 * provider cap is too small. Names every key that waited, busiest first (the key-less
 * bucket, which also takes every team-cap wait whatever its key, reads "the run cap") and, on
 * a warn, each key's maxConcurrentPerProvider cap to raise, plus maxConcurrent for the run cap.
 * A counterpoint to checkWorktreePool's slot-wait half; read-only, like every doctor check.
 * `now` is a test seam for the window. */
export function checkProviderContention(root: string, config: TumwaterConfig | undefined, now = Date.now()): CheckOutcome {
  let count = 0;
  let total = 0;
  let longestMs = 0;
  const perKey = new Map<string, number>();
  try {
    const waits = eventsSince(root, PROVIDER_WAIT_CHECK_WINDOW_MS, now, (ev) => ev.type === "provider_wait");
    for (const ev of waits) {
      count += 1;
      const waited = finiteNumber(ev.waitedMs, 0);
      total += waited;
      if (waited > longestMs) longestMs = waited;
      const key = ev.cap !== "team" && typeof ev.key === "string" && ev.key.length > 0 ? ev.key : "";
      perKey.set(key, (perKey.get(key) ?? 0) + waited);
    }
  } catch (err) {
    // A read error leaves the level ok, exactly like the slot-wait branch's own read: the
    // check cannot measure, so it says so rather than crying wolf.
    return okOutcome(`could not read the event log for provider waits: ${errorMessage(err)}`);
  }
  if (count === 0) return okOutcome("no provider waits");
  // Rank the buckets by wait total, ties breaking on key name so the detail is deterministic.
  // The key-less bucket reads "the run cap" — maxConcurrent, since no seam keys to a provider.
  const ranked = rankCountEntries(perKey).map(([key, total]) => ({ key, total }));
  const bucketLabel = (key: string) => (key === "" ? "the run cap" : `the ${key} slot`);
  const cells = ranked.map((b) => `${bucketLabel(b.key)} ${shortSpanPhrase(b.total)}`);
  // A single bucket keeps the pre-existing wording, a bare `(the X slot)` without the total
  // (the total is already named by the `shortSpanPhrase(total)` in the clause before it);
  // two or more name each bucket's total so the ranking reads at a glance.
  const parenthetical =
    ranked.length === 1
      ? `(${bucketLabel(ranked[0]!.key)})`
      : `(${cells[0]}, also ${cells.slice(1).join(", ")})`;
  let detail = `${plural(count, "wait")} for a provider slot in the last 24h, ${shortSpanPhrase(total)} total, longest ${shortSpanPhrase(longestMs)} ${parenthetical}`;
  const contended = total >= PROVIDER_WAIT_WARN_TOTAL_MS;
  if (contended) {
    const advice = ranked
      .filter((b) => b.key !== "" && config?.maxConcurrentPerProvider?.[b.key] !== undefined)
      .map((b) => `raise maxConcurrentPerProvider.${b.key} above ${config?.maxConcurrentPerProvider?.[b.key]}`)
      .join(" and ");
    const teamAdvice =
      perKey.has("") && config !== undefined ? [`raise maxConcurrent above ${config.maxConcurrent}`] : [];
    const all = [...(advice ? [advice] : []), ...teamAdvice].join(" and ");
    if (all) detail += ` — ${all}`;
  }
  return (contended ? warnOutcome : okOutcome)(detail);
}

/** Names the kind of check a `heldBy` label stands for, in checkCheckContention's tally. */
function checkHolderKind(label: string): string {
  if (label === "main baseline") return "the main baseline";
  const scope = label.slice(label.lastIndexOf(" ") + 1);
  return scope === "gate" || scope === "merge" || scope === "batch" ? `${scope} checks` : "other checks";
}

/** Check-slot contention: sums the last 24 h of `check_wait` events (each a scoped check whose
 * permit wait reached CHECK_WAIT_EVENT_MS, recorded in build-check-events.ts) and warns when
 * the total reaches CHECK_WAIT_WARN_TOTAL_MS — maxConcurrentChecks is too small. The third
 * sibling of checkWorktreePool's slot-wait half and checkProviderContention; read-only.
 * When events carry `heldBy` (the labels of the permit holders the check parked behind), the
 * detail gains `(behind <kind> <span>, …)` after the longest clause, kinds busiest first: a
 * wait counts once toward each distinct kind that held a slot. `now` is a test seam for the
 * window. */
export function checkCheckContention(root: string, config: TumwaterConfig | undefined, now = Date.now()): CheckOutcome {
  let count = 0;
  let total = 0;
  let longestMs = 0;
  const perKind = new Map<string, number>();
  try {
    for (const ev of eventsSince(root, CHECK_WAIT_CHECK_WINDOW_MS, now, (e) => e.type === "check_wait")) {
      count += 1;
      const waited = finiteNumber(ev.waitedMs, 0);
      total += waited;
      if (waited > longestMs) longestMs = waited;
      for (const kind of new Set(stringList(ev.heldBy).map(checkHolderKind))) {
        perKind.set(kind, (perKind.get(kind) ?? 0) + waited);
      }
    }
  } catch (err) {
    return okOutcome(`could not read the event log for check waits: ${errorMessage(err)}`);
  }
  if (count === 0) return okOutcome("no check waits");
  let detail = `${plural(count, "wait")} for a check slot in the last 24h, ${shortSpanPhrase(total)} total, longest ${shortSpanPhrase(longestMs)}`;
  if (perKind.size > 0) {
    const ranked = rankCountEntries(perKind);
    detail += ` (behind ${ranked.map(([kind, ms]) => `${kind} ${shortSpanPhrase(ms)}`).join(", ")})`;
  }
  if (total < CHECK_WAIT_WARN_TOTAL_MS) return okOutcome(detail);
  detail += ` — raise maxConcurrentChecks above ${config?.maxConcurrentChecks ?? defaultConfig().maxConcurrentChecks}`;
  return warnOutcome(detail);
}

/** The "leftover role branches" row: `tumwater/<id>` branches whose role is no longer enabled
 * (disabled in tumwater.json, or an instance above the configured count). Retirable ids are
 * the ones `tumwater retire --role <id>` accepts (knownRoleIds, or any well-formed custom-role name
 * with a leftover branch); any other id is listed by
 * full branch name with a manual-delete hint. The director and enabled roles are skipped.
 * Read-only, like every check: it only lists refs; an unreadable tumwater.json skips it. */
export async function checkLeftoverRoleBranches(root: string, config?: TumwaterConfig | null): Promise<CheckOutcome> {
  if (!config) return okOutcome("no readable tumwater.json — nothing to verify");
  const prefix = branchName("");
  const known = new Set(knownRoleIds(config));
  const retirable: string[] = [];
  const unknown: string[] = [];
  for (const branch of await listBranches(root)) {
    if (!branch.startsWith(prefix)) continue;
    const id = branch.slice(prefix.length);
    if (!id || id.includes("/") || id === DIRECTOR_ROLE || runnerEnabled(config, id)) continue;
    if (known.has(id) || CUSTOM_NAME_RE.test(id)) retirable.push(id);
    else unknown.push(branch);
  }
  const parts: string[] = [];
  if (retirable.length > 0) {
    const n = retirable.length;
    parts.push(
      `${retirable.join(", ")} ${agree(n, "is", "are")} disabled but still ${agree(n, "has", "have")} a branch — \`tumwater retire --role <id>\` removes each (\`--dry-run\` previews)`,
    );
  }
  if (unknown.length > 0) {
    parts.push(
      `${unknown.join(", ")} ${agree(unknown.length, "names", "name")} no role retire accepts — delete with \`git branch -D\` once its commits are not needed`,
    );
  }
  return parts.length === 0 ? okOutcome("no branches left by disabled roles") : warnOutcome(parts.join("; "));
}

/** The "tumwater pins" row: fails when a `refs/tumwater/` pin (merge, rejected or legacy landing)
 * names a commit that is gone. It fails rather than warns because such a pin stops `git gc`
 * (and the `gc --auto` commits trigger), and a slot reset or leftover recovery only drops one
 * when it reaches it. Read-only: it lists refs and names the `git update-ref -d` fix. */
export async function checkTumwaterPins(root: string): Promise<CheckOutcome> {
  const pins = await refsUnder(root, "refs/tumwater/");
  const broken: { ref: string; sha: string }[] = [];
  for (const pin of pins) if (!(await commitExists(root, pin.sha))) broken.push(pin);
  if (broken.length === 0) {
    return okOutcome(pins.length === 0 ? "no tumwater pins" : `${plural(pins.length, "tumwater pin")}, each naming a commit that exists`);
  }
  const n = broken.length;
  return failOutcome(
    `${broken.map((p) => `${p.ref} names ${shortSha(p.sha)}, which is gone`).join("; ")} — git gc and a detached checkout abort on ${agree(n, "it", "them")}; \`git update-ref -d <ref>\` drops each (the work ${agree(n, "it", "they")} pinned is already lost)`,
  );
}

/** The ok detail of the instance check: non-zero counts, plans first, each pluralized. */
function claimCounts(claims: Array<{ file: string }>): string {
  const bugs = claims.filter((c) => c.file === "BUGS.md").length;
  const plans = claims.length - bugs;
  const parts = [
    plans > 0 ? plural(plans, "claimed plan") : "",
    bugs > 0 ? plural(bugs, "claimed bug") : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no claimed plans or bugs";
}

/** Parallel work instances (plans/parallel-work-instances.md "Observability", part 6/7):
 * each instance's claimed plan or bug and the two states an operator should act on — a claim
 * whose key is no longer listed under its role's section (its instance is stuck on an entry
 * that moved), and a claim idle for more than CLAIM_IDLE_MAX_MS (the scheduler releases
 * these, so seeing one means the reader's view and the scheduler's disagree). An enabled
 * multi-instance role configured with fewer pooled slots than maxConcurrent also warns:
 * instances then contend for the same checkouts. A disabled role runs none of its
 * configured instances, so it never contends and
 * stays out of that warning.
 * Read-only, like every check; `now` is the claim-age test seam, and an unreadable
 * tumwater.json (config undefined) skips the walk — checkInit reports the config itself. */
export function checkWorkInstances(
  root: string,
  config?: TumwaterConfig | null,
  now = Date.now(),
): CheckOutcome {
  if (!config) return okOutcome("no readable tumwater.json — nothing to verify");
  const claims: Array<{ id: string; title: string; key: string; at: number; file: string }> = [];
  for (const id of runnerIds(config)) {
    const claim = loadRunnerState(root, id).claim;
    if (claim) claims.push({ id, title: claim.title, key: claim.key, at: claim.at, file: claim.file });
  }
  const gone = claims.filter((c) => !listedKeys(root, c.id).has(c.key));
  const stale = claims.filter((c) => !gone.includes(c) && now - c.at > CLAIM_IDLE_MAX_MS);
  const multi = Object.entries(config.roles)
    .filter(
      ([id, role]) => INSTANCE_ROLES.has(id) && role.enabled && (role.instances ?? 1) > 1,
    )
    .map(([id]) => id);
  const slots = slotCount(config);
  const smallPool = multi.length > 0 && slots < config.maxConcurrent;
  if (gone.length === 0 && stale.length === 0 && !smallPool)
    return okOutcome(claimCounts(claims));
  const noun = (c: { file: string }) => (c.file === "BUGS.md" ? "bug" : "plan");
  const parts: string[] = [
    ...gone.map((c) => `claimed ${noun(c)} "${c.title}" (${c.id}) names an entry no longer listed`),
    ...stale.map(
      (c) =>
        `claimed ${noun(c)} "${c.title}" (${c.id}) has been idle ${Math.round((now - c.at) / 3_600_000)}h`,
    ),
  ];
  if (smallPool)
    parts.push(
      `${multi.join(", ")} run instances but worktreeSlots ${slots} is below maxConcurrent ${config.maxConcurrent}`,
    );
  return warnOutcome(parts.join("; "));
}

/** Provider concurrency caps (plans/provider-concurrency.md §8): audit the
 * `maxConcurrentPerProvider` map against the seams the config can actually spawn — each role,
 * the review gate, the resolver, the director, and each tier's fallback — so the operator
 * sees whether every cap names a provider in use and whether any cap actually binds. Warns on
 * a cap key no seam resolves to (a typo, or a provider not in use), a cap at or above
 * `maxConcurrent` (which never binds — the team total is the real ceiling), and a capped
 * team whose seams include one with no key (pi's default provider is unreadable, so that
 * seam cannot be capped). A config with no per-provider map or no caps is fine, and so is a
 * well-formed map; a broken config is reported by the init check. Takes `root` to read pi's
 * own default model (piSettingsPath), the same seam the orchestrator's admission uses, so a
 * bare no-model pi seam keys exactly as the team would key it. */
export function checkProviderConcurrency(config: TumwaterConfig | undefined, root: string): CheckOutcome {
  if (!config) return okOutcome("no config to audit");
  const caps = config.maxConcurrentPerProvider;
  const capEntries = enforcedKeyCaps(caps);
  if (capEntries.length === 0) return okOutcome("no per-provider caps configured");
  // The pi default model the orchestrator's admission seam carries: a bare no-model pi seam
  // resolves its key only through it, so a team whose default is readable has keyed seams and
  // only an unreadable default leaves a key-less seam to warn about.
  const piDefault = readPiDefaultModel(piSettingsPath(piModelsPath()), root);
  const seams = seamsInUse(config);
  const keyed: string[] = [];
  for (const s of seams) {
    const k = seamConcurrencyKey(s, piDefault);
    if (k !== undefined && !keyed.includes(k)) keyed.push(k);
  }
  const keySet = new Set(keyed);
  const capKeys = capEntries.map(([k]) => k);
  const warnings: string[] = [];
  for (const key of capKeys) {
    if (!keySet.has(key)) warnings.push(`cap key "${key}" resolves to no model job (a typo, or a provider not in use)`);
  }
  for (const [key, cap] of capEntries) {
    if (cap >= config.maxConcurrent) warnings.push(`cap "${key}" ${cap} is at or above maxConcurrent ${config.maxConcurrent} — it never binds`);
  }
  const capSet = new Set(capKeys);
  const keyless = seams.filter((s) => seamConcurrencyKey(s, piDefault) === undefined);
  if (capSet.size > 0 && keyless.length > 0) {
    warnings.push(`${keyless.length} model job(s) resolve to no provider key (pi's default provider is unreadable, so they cannot be capped): ${keyless.map((s) => s.label).join(", ")}`);
  }
  if (warnings.length === 0) return okOutcome(`${plural(capEntries.length, "provider cap")} — all model jobs resolve`);
  return warnOutcome(warnings.join("; "));
}

/** The `passing merge checks …` phrase for the `check` row: median and slowest wall clock of
 * the passed full-suite runs (`merge`, `batch`, `baseline` scopes — a `gate` check can run a
 * subset, and failed or skipped runs do not measure a full pass). The lower median keeps the
 * figure a run that happened. Undefined when no event qualifies. */
export function checkDurationPhrase(events: readonly HarnessEvent[]): string | undefined {
  const durations = events
    .filter(isPassingFullCheck)
    .map((e) => finiteNumber(e.durationMs, 0))
    .filter((ms) => ms > 0);
  if (durations.length === 0) return undefined;
  const median = lowerMedian(durations);
  const slowest = Math.max(...durations);
  return `passing merge checks in the last 24h took ${shortSpanPhrase(median)} median, ${shortSpanPhrase(slowest)} slowest (${plural(durations.length, "run")})`;
}

/** Declared project check — names what the review gate's deterministic pre-check, the
 * red-main baseline, and redeploy's green check will run, without running it: a configured
 * `check.command` (plans/portability.md §6/7), else the npm auto-detection. None declared is
 * a warn, not informational (the 2026-09-05 stance predates non-npm targets being supported,
 * when a warn would have been noise no operator could act on — with `check.command` available
 * the warning is actionable): the three gates degrade to "no check" and a silently absent
 * safety layer is the failure this check exists to surface. Warn does not fail the exit code
 * (the fallback check's precedent, doctor-model-checks.ts's checkFallbackModel). */
export function checkBuildCheck(
  root: string,
  config?: CheckConfigSlice | null,
): CheckOutcome {
  const check = detectBuildCheck(root, config ?? undefined);
  if (!check)
    return warnOutcome("none declared — the review gate's build pre-check, the red-main baseline, and redeploy's green check are all off (set `check.command` in tumwater.json for a non-npm repo)");
  const phrase = checkDurationPhrase(readEventsSince(root, 24 * 60 * 60 * 1000).events);
  const withTiming = (detail: string) => okOutcome(phrase ? `${detail} · ${phrase}` : detail);
  if (check.kind === "command") {
    const where = path.relative(root, check.cwd);
    return withTiming(where ? `${check.command} (cwd ${where})` : check.command);
  }
  const where = path.relative(root, check.rootDir);
  return withTiming(where ? `npm ${check.script} in ${where}` : `npm ${check.script}`);
}

/** The review gate's flake memory surfaced read-only: names which checks the gate kept excusing as
 * flakes over its own KNOWN_FLAKE_WINDOW_MS window. The gate logs `gate check failed then passed on
 * retry — flaky: <headline>` for each failure that passed on its one immediate re-run, and the
 * in-lock merge check logs the same under MERGE_FLAKY_WARNING_PREFIX when its kept-pin retry passes
 * (src/review/known-flakes.ts); that record is internal to the gate's matching, so a genuinely
 * flaky check silently burns a re-run per merge and hides real instability — exactly the
 * information that explains intermittent rejections. This check reads the same window and folds the
 * same normalized headline the gate matches with (flakeCounts, so the prefix slice-offset and
 * cluster normalization cannot drift), and warns only when a normalized check flapped more than
 * once, so a routine one-off flake stays quiet. ok/warn only — never a fail — so a flaky suite
 * cannot fail a scripted doctor pre-flight (the checkStalledPlans precedent; the exit-code rule is
 * outcome.ts's). */
export function checkFlakyChecks(root: string): CheckOutcome {
  const { events } = readEventsSince(root, KNOWN_FLAKE_WINDOW_MS);
  const flapped = flakeCounts(events).filter(([, n]) => n >= 2);
  if (flapped.length === 0)
    return okOutcome("no check flapped more than once in the last 24h");
  const render = ([k, n]: [string, number]) => `"${k}" ×${n}`;
  const [first, ...rest] = flapped;
  const more =
    rest.length > 0 ? ` (and ${rest.length} more: ${rest.map(render).join(", ")})` : "";
  return warnOutcome(
    `${agree(flapped.length, "check", "checks")} flapped more than once in the last 24h: ${render(first!)}${more}`,
  );
}

/** Build provenance — is the harness about to run (this process's dist/) the code main
 * describes? Only meaningful when this project IS the harness (isSelfHosted); elsewhere the
 * stamp is reported as-is. A stale build is a warning, not a failure: the team runs, just not
 * the newest code, and auto-restart (or a rebuild + restart) resolves it. `info`, `head` and
 * `running` are injectable so tests can exercise every branch without compiling anything. */
export async function checkBuild(
  root: string,
  info: BuildInfo | null = readBuildInfo(),
  head: string | null | undefined = undefined,
  /** What the running orchestrator published about this build (orchestrator.json), when one is
   * up. A stale build whose restart was REFUSED must not be reported with the boilerplate
   * "auto-restart does this for a running team": nothing will happen until main moves, and
   * doctor is where an operator goes to find out why. */
  running: BuildStatus | null = null,
): Promise<CheckOutcome> {
  if (!info) return okOutcome("no build stamp — dist/ compiled without `npm run build`");
  const sha = shortSha(info.sha);
  if (!(await isSelfHosted(root, info)))
    // Not "dist/ from …": in someone else's project that names a dist/ directory the project
    // does not have — the stamp read here is the running harness install's own, so say that.
    return okOutcome(`tumwater version ${sha} (this project is not tumwater itself)`);
  const mainHead = head === undefined ? await currentHead(root) : head;
  if (!mainHead) return okOutcome(`dist/ from ${sha}`);
  const stale = await buildStaleness(root, info.sha, mainHead);
  if (!stale) return okOutcome(`dist/ from ${sha}`);
  if (stale.stale) {
    const next = running?.restartBlocked
      ? `; auto-restart is BLOCKED (${running.restartBlocked}) and will not retry until main moves or the block clears`
      : running?.restartPending
        ? "; auto-restart is under way"
        : "; run `npm run build` and restart `tumwater start` (auto-restart does this for a running team)";
    return warnOutcome(`dist/ from ${sha} is stale — main has ${stale.aheadCommits} later commit(s) touching ${STALE_INPUTS_LABEL}${next}`);
  }
  return okOutcome(`dist/ from ${sha}, matches main`);
}

/** The primary checkout's HEAD sha, or null when it cannot be resolved (no repo) —
 * git/git.ts's refSha, the one home of the rev-parse probe. */
function currentHead(root: string): Promise<string | null> {
  return refSha(root, "HEAD");
}
