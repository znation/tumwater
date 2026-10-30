/** The opencode adapter for the agent seam (plans/opencode-backend.md "The invocation",
 * "Sessions", §6). It shapes one run's argv/stdin/env, translates opencode's `run --format
 * json` into the canonical stream, runs the authoritative session export after the process
 * exits, and classifies the exit's stderr — everything backend-specific. src/agent/agent-spawn.ts
 * spawns the run and records this run in the session ledger; opencode mints its own session id
 * (a `ses_…` id, or the resumed record's id), which `invocation` returns so the ledger can
 * carry it.
 *
 * Sessions resume by id from the cwd the session started in, out of the run's shared database
 * (opencodeDbPath). A continue takes the ledger's newest record of this run's kind and resumes
 * only when it is opencode's, has this cwd, and `opencode session export <id> --standalone`
 * actually finds it — `--session` silently creates a missing session, so the existence check is
 * the only thing that stops a follow-up running against an empty session. Anything else mints a
 * fresh id (design §4).
 *
 * Registration lives in src/agent/agent-run.ts beside the pi and claude adapters; a test selects
 * opencode by setting `config.agent = "opencode"` on a run. A run carrying a note gets the
 * notes path in its environment (the `tumwater-notes` command on PATH reads it), as the pi and
 * claude adapters do. */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ensureParentDir } from "../../files/files.js";
import { loadConfigSafe } from "../../config/config.js";
import { resolvedBackendConfig } from "../../config/config-views.js";
import { backendRunEnv } from "../../process/run-marker.js";
import { resolveBinForBackend, type ResolvedBackendBin } from "../../pi/pi-bin.js";
import { opencodeDbPath, teamRootOf } from "../../paths.js";
import type {
  AgentBackend,
  BackendBinConfig,
  AgentExitClassification,
  AgentExitInfo,
  AgentInvocation,
  AgentRunSpec,
  StreamTranslator,
} from "../agent-backend.js";
import { resumableSession } from "../session-ledger.js";
import { opencodeArgs } from "./opencode-args.js";
import { opencodeConfigContent, operatorMcpNames } from "./opencode-config.js";
import { outputLimits } from "../../pi-extension/bounded-output.js";
import { seamContextWindow } from "../../pi/pi-models.js";
import { opencodeModelKey, readOpencodeCache } from "./opencode-catalog.js";
import { opencodeEnv } from "./opencode-env.js";
import { mintOpencodeSessionId } from "./opencode-session-id.js";
import { opencodeExportLines, opencodeTranslator, type OpencodeStreamTranslator } from "./opencode-stream.js";

/** How long a post-run `opencode session export` may take before it gives up (design §6): the
 * export measured 0.18 s live, so 10 s is a generous bound on a slow or wedged CLI. Used for
 * both the resume-existence check and the reconciling export. */
const EXPORT_TIMEOUT_MS = 10_000;

/** The minimum OpenCode CLI version this harness accepts (plans/opencode-backend.md "Which
 * OpenCode", part 7/7): 2.0.32, the version H1 verified live. V1 is maintenance-only and has
 * the git-repo hang (issue 55037), so doctor fails an installed CLI below this and names
 * `brew install opencode`. */
export const OPENCODE_MIN_VERSION = "2.0.32";

/** The repository's root (initial) commit hash, or undefined when git cannot answer (not a
 * repo, or git missing). `git rev-list --max-parents=0 HEAD` is the same read OpenCode makes
 * to key its shell spill by the tree's root commit. Read-only. */
function rootCommitOf(root: string): string | undefined {
  try {
    const res = spawnSync("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = res.stdout?.trim();
    return line !== undefined && /^[0-9a-f]{40}$/i.test(line) ? line : undefined;
  } catch {
    return undefined;
  }
}

/** The tree's shell spill dir OpenCode writes (finding 17, part 7/7):
 * `~/.local/share/opencode/shell/<root commit>/`, keyed by the repository's root commit hash and
 * OUTSIDE `.tumwater/`, so only a `session delete` or an explicit spill prune reaches it. Empty
 * string when the root commit cannot be read — callers then skip spill work (doctor reports no
 * spill dir; retention prunes no spill files). */
export function opencodeSpillDir(root: string): string {
  const commit = rootCommitOf(root);
  if (commit === undefined) return "";
  return path.join(os.homedir(), ".local", "share", "opencode", "shell", commit);
}

/** The catalog cache key for a run's resolved model id (part 6d/7): a bare gateway id gets the
 * `opencode/` provider prefix, a provider-qualified id passes as is — the same rule
 * opencodeArgs uses to build the `--model` arg and opencode-catalog.ts uses to key the cache,
 * so an invocation's lookup always matches the key a run is priced and billed by. */
function catalogModelKey(model: string): string {
  return opencodeModelKey(model);
}

/** Run the bounded `opencode session export <id> --standalone` spawn that both the resume
 * existence check and the reconciling export issue, under the same env/cwd and the shared
 * 10 s bound. Returns the spawn result with stdout captured (UTF-8), or null when the spawn
 * itself threw — a missing binary or an invalid option, resolved the same way both callers
 * treated a throw. The command line, env, cwd and timeout live here once, so the existence
 * check and the reconciling export cannot drift on what they run. */
function runSessionExport(
  id: string,
  env: NodeJS.ProcessEnv,
  bin: string,
  cwd: string,
): SpawnSyncReturns<string> | null {
  try {
    return spawnSync(bin, ["session", "export", id, "--standalone"], {
      env,
      cwd,
      timeout: EXPORT_TIMEOUT_MS,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

/** Run `opencode session export <id> --standalone` (the same database the run used, bounded at
 * 10 s) and return whether it reported success — the existence check that decides a resume.
 * Nonzero exit, a timeout, or a spawn failure all read as "no such session", which is the safe
 * direction: `--session` would otherwise silently create a missing session. */
function opencodeSessionExists(id: string, env: NodeJS.ProcessEnv, bin: string, cwd: string): boolean {
  const res = runSessionExport(id, env, bin, cwd);
  return res?.status === 0;
}

/** Run the reconciling export after a successful run and return its two canonical lines
 * (`run_cost`, `run_usage`) from the session's `info`. Anything that goes wrong — a spawn or
 * timeout, a nonzero exit, unparseable or malformed output — returns `[]`, and the caller
 * (afterRun) reports `opencode_usage_partial` so the run keeps its streamed numbers. */
function opencodeExport(result: { id: string; env: NodeJS.ProcessEnv; bin: string; cwd: string }): string[] {
  const res = runSessionExport(result.id, result.env, result.bin, result.cwd);
  if (res?.status !== 0 || !res.stdout) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  return opencodeExportLines(parsed);
}

/** The session id this run uses: for a continue, the ledger's newest record of this kind when it
 * is opencode's, has this cwd, and the export finds the session; otherwise a freshly minted id.
 * Returns the id; the runner records it in the ledger. */
function resolveOpencodeSession(
  run: AgentRunSpec,
  env: NodeJS.ProcessEnv,
): { sessionId: string } {
  if (run.continueSession) {
    const record = resumableSession(run.sessionDir, {
      kind: run.kind,
      agent: "opencode",
      cwd: run.cwd,
    });
    if (record !== null && opencodeSessionExists(record.id, env, run.agentBin, run.cwd)) {
      return { sessionId: record.id };
    }
  }
  return { sessionId: mintOpencodeSessionId() };
}

/** Classify opencode's stderr: on a nonzero exit, a free-tier refusal is a provider failure
 * (moves the job to its fallback) and an unknown model or variant is a permanent config error.
 * A run the harness killed has its own cause and is never classified here. The structured
 * signals (the stream's `error` lines) are classified by the translator; this is the stderr
 * half for a CLI that died before emitting one. */
function classifyOpencodeExit(info: AgentExitInfo): AgentExitClassification {
  if (info.killed) return {};
  if (info.code !== 0 && /FreeTierError/i.test(info.stderr)) {
    return { transientBackend: true, backendKind: "server" };
  }
  if (info.code !== 0 && /Model unavailable|Variant unavailable/i.test(info.stderr)) {
    return { configError: true };
  }
  return {};
}

/** The agent-backend seam's opencode adapter. */
export const opencodeBackend: AgentBackend = {
  id: "opencode",
  label: "OpenCode",
  defaultBin: "opencode",
  binEnv: "TUMWATER_OPENCODE_BIN",

  resolveBin(config: BackendBinConfig): ResolvedBackendBin {
    return resolveBinForBackend(config, this);
  },

  invocation(run: AgentRunSpec): AgentInvocation {
    // The shared database and injected config are per-root, built the same way for every run of
    // this team so a resume's export check reads the same OPENCODE_DB the original run wrote.
    const root = teamRootOf(run.sessionDir);
    const dbPath = opencodeDbPath(root);
    // opencode will not create the database's parent directory and its server dies without it.
    ensureParentDir(dbPath);
    // Window-scaled tool-output caps (part 6f/7): OpenCode's `tool_output` default is about
    // three times pi's tuned budgets, so every turn would re-send far more tool output than a
    // pi run — critical on the 200K free model's window. Cap it at pi's `outputLimits(window)
    // .bash` (16,000 at 128k and above, scaled down below), with the ~40 chars/line line cap
    // pi's "12k chars ≈ 300 lines" read budget implies. An unknown window (no catalog entry)
    // keeps the 128k values. The window is part 6e/7's `seamContextWindow` for this run's
    // model.
    const maxBytes = outputLimits(seamContextWindow({ agent: "opencode", model: run.config.model }, root)).bash;
    const configContent = opencodeConfigContent({
      cwd: run.cwd,
      operatorMcpNames: operatorMcpNames(process.env, os.homedir()),
      toolOutput: { maxLines: Math.round(maxBytes / 40), maxBytes },
    });
    // The notes path rides beside the run marker, as the pi and claude adapters' envs do
    // (withNotesPath); from part 2/4 the run saves its note through the `tumwater-notes` command
    // on PATH, so OpenCode configures no tumwater MCP server for notes.
    const base = backendRunEnv(run);
    const env = opencodeEnv(base, { dbPath, configContent });
    const { sessionId } = resolveOpencodeSession(run, env);
    // The thinking variant (part 6d/7): ride the catalog's effort levels for the resolved
    // model as a `#level` suffix, and drop a level the catalog does not list — an unlisted
    // variant would otherwise be a permanent config error from OpenCode (finding 9).
    const model = run.config.model ?? "";
    const thinking = run.config.thinking;
    const entry = readOpencodeCache(root).models[catalogModelKey(model)];
    const variant = thinking !== undefined && thinking !== "" && entry?.efforts?.includes(thinking) ? thinking : undefined;
    const { args, stdin } = opencodeArgs({
      model,
      ...(variant !== undefined ? { variant } : {}),
      sessionId,
      title: run.sessionName,
      args: resolvedBackendConfig(run.config, "opencode").args,
      prompt: run.prompt,
    });
    return { args, stdin, env, sessionId };
  },

  translator(): OpencodeStreamTranslator {
    return opencodeTranslator();
  },

  imageInput(model: string | undefined): boolean {
    // Answer from the catalog cache (part 6d/7): a model reads images when its catalog entry
    // says so; a model missing from the cache answers false — the safe direction, so a blind
    // image read is never silently assumed readable. The cache is per-root, found by walking up
    // from the process's working directory to its `.tumwater`, the same root the runs' shared
    // database and cache live under.
    if (model === undefined) return false;
    return readOpencodeCache(teamRootOf(process.cwd())).models[catalogModelKey(model)]?.images === true;
  },

  resumable(dir: string, opts: { kind: string; agent: string; cwd?: string }): boolean {
    const record = resumableSession(dir, { kind: opts.kind, agent: "opencode", cwd: opts.cwd });
    if (record === null) return false;
    const root = teamRootOf(dir);
    const dbPath = opencodeDbPath(root);
    ensureParentDir(dbPath);
    const env = { ...process.env, OPENCODE_DB: dbPath };
    // Resolve the binary exactly as the run's invocation does — same env → backends.opencode.bin
    // → default precedence — so a configured custom binary's resume guard agrees with the
    // `run.agentBin` the invocation runs (they must not disagree, or a follow-up is silently
    // skipped). The team's config is loaded from the root `dir` lives under.
    const { config } = loadConfigSafe(root);
    const bin = config !== undefined ? opencodeBackend.resolveBin(config).bin : "opencode";
    return opencodeSessionExists(record.id, env, bin, opts.cwd ?? path.dirname(dir));
  },

  afterRun(run: AgentRunSpec, invocation: AgentInvocation, translator: StreamTranslator): string[] {
    if (invocation.sessionId === undefined) return [];
    const lines = opencodeExport({
      id: invocation.sessionId,
      env: invocation.env,
      bin: run.agentBin,
      cwd: run.cwd,
    });
    if (lines.length === 0) {
      // The export is authoritative, so its loss is worth one warning: the run keeps its
      // streamed numbers and the caller surfaces `opencode_usage_partial` in the event feed.
      (translator as OpencodeStreamTranslator).noteOpencodeUsagePartial();
    }
    return lines;
  },

  classifyExit: classifyOpencodeExit,
};
