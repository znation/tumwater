/** The claude adapter for the agent seam (plans/agent-backends.md "The seam", "Sessions",
 * "The claude invocation"). It shapes one run's argv/stdin/env, translates claude's
 * `stream-json` into the canonical stream, and classifies the exit's stderr — everything
 * backend-specific. src/agent/run-spawn.ts spawns the run and records this run in the session
 * ledger; claude mints its own session id (a fresh UUID, or the resumed record's id), which
 * `invocation` returns so the ledger can carry it.
 *
 * Sessions resume by id from the cwd the session started in, so the adapter consults the
 * ledger's newest record of this run's kind and only passes `--resume` when that record names
 * claude, this cwd, and a transcript file that exists. Otherwise it mints a fresh id — a
 * missing transcript, a different cwd, or another kind's newer session all review fresh rather
 * than resuming the wrong conversation.
 *
 * Registration lives in src/agent/run-agent.ts beside the pi adapter, so a test can register a
 * fake under its own id; a test selects claude by setting `config.agent = "claude"` on a run. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvedBackendConfig } from "../../config/config-views.js";
import { MODEL_TIERS } from "../../config/config-schema.js";
import { routeModel } from "../../config/model-selector.js";
import { backendRunEnv } from "../../process/run-marker.js";
import { resolveBinForBackend, type ResolvedBackendBin } from "../../pi/pi-bin.js";
import { expandHomeTilde } from "../../files/files.js";
import { claudeArgs } from "./claude-args.js";
import { claudeEnv, claudeThirdPartyProvider } from "./claude-env.js";
import { claudeTranslator } from "./claude-stream.js";
import { resumableSession, type SessionRecord } from "../session-ledger.js";
import type {
  AgentBackend,
  BackendBinConfig,
  AgentExitClassification,
  AgentExitInfo,
  AgentInvocation,
  AgentRunSpec,
  StreamTranslator,
} from "../agent-backend.js";

/** claude's per-cwd project directory name under the claude config dir's `projects/`:
 * every character that is not a letter or digit becomes `-`. Exported with
 * `claudeTranscriptPath` so the PATH fake and the tests create and look for exactly the file
 * the resume check reads. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** claude's config directory: `$CLAUDE_CONFIG_DIR` when non-empty (a leading `~` expands
 * against the home dir), else `~/.claude`. A configured team `configDir` (the expanded
 * `backends.claude.configDir`) wins over any inherited env var — the team's own directory is
 * never overridden by the operator's shell. This mirrors claude's own lookup and pi's
 * `piAgentDir`; exported so doctor reads the same dir the adapter writes transcripts into. */
export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  configured?: string,
): string {
  if (configured) return expandHomeTilde(configured, homeDir);
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return path.join(homeDir, ".claude");
  return expandHomeTilde(dir, homeDir);
}

/** The transcript file claude writes for a session started in `cwd`: its resume check must find
 * a real file before passing `--resume`. claude's own layout is
 * `<config>/projects/<slug>/<sessionId>.jsonl`; exported so the fake and the resume logic
 * cannot drift. `configDir` is the configured team dir, threaded through so the resume check
 * looks where the run's own env will write. */
export function claudeTranscriptPath(
  cwd: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
  configDir?: string,
): string {
  return path.join(
    claudeConfigDir(env, homeDir, configDir),
    "projects",
    claudeProjectSlug(cwd),
    `${id}.jsonl`,
  );
}

/** The CLI version every gated claude model needs (plans/agent-backends.md finding 9): on
 * 2.1.216 Opus 5.5 is refused outright and Haiku 5.5 is mispriced about 250×, and team runs
 * set DISABLE_AUTOUPDATER so they never update themselves. The gated models are the three
 * tier defaults, derived from BACKEND_DEFAULT_MODELS through the same routing the config uses
 * rather than listed again, so this table cannot drift from the models a seam resolves. */
const CLAUDE_MIN_VERSION = "2.1.280";

const CLAUDE_GATED_MODELS = new Set(
  MODEL_TIERS.map((tier) => routeModel(undefined, undefined, "claude", tier).model).filter(
    (model): model is string => model !== undefined,
  ),
);

/** The minimum CLI version `model` needs, or undefined when this adapter gates no floor for
 * it (a model outside the three tier defaults). Doctor reads it through `claudeBackend`. */
function claudeMinVersion(model: string): string | undefined {
  return CLAUDE_GATED_MODELS.has(model) ? CLAUDE_MIN_VERSION : undefined;
}

/** Classify claude's stderr: a nonzero exit naming a login or model problem is a permanent
 * configuration error. The stream translator classifies the structured result signals; this is
 * the stderr half, for a CLI that died before emitting one. A run the harness killed has its
 * own cause and is never classified here. */
function classifyClaudeExit(info: AgentExitInfo): AgentExitClassification {
  if (info.killed) return {};
  if (
    info.code !== 0 &&
    /Not logged in|issue with the selected model|does not support this model/i.test(info.stderr)
  ) {
    return { configError: true };
  }
  return {};
}

/** The ledger record this run may resume, or null: the newest record of `opts.kind` for
 * claude, at `opts.cwd` when one is given, whose transcript file exists. Shared by
 * `resolveClaudeSession` and the backend's `resumable` hook, so the resume guard and the
 * invocation can never drift on what counts as resumable. */
function claudeResumableRecord(
  dir: string,
  opts: { kind: string; agent: string; cwd?: string },
  configDir?: string,
): SessionRecord | null {
  const record = resumableSession(dir, opts);
  if (record === null) return null;
  if (opts.cwd !== undefined && record.cwd !== opts.cwd) return null;
  if (!fs.existsSync(claudeTranscriptPath(record.cwd, record.id, process.env, os.homedir(), configDir)))
    return null;
  return record;
}

/** The session id this run uses: for a continue, the ledger's newest record of this kind when
 * it is claude's, this cwd's, and its transcript file exists; otherwise a fresh UUID. Returns
 * the id and the `--resume` id when resuming. `configDir` is the configured team dir, so the
 * resume check looks where the run's own env will write transcripts. */
function resolveClaudeSession(
  run: AgentRunSpec,
  configDir?: string,
): { sessionId: string; resumeSessionId?: string } {
  if (run.continueSession) {
    const record = claudeResumableRecord(
      run.sessionDir,
      { kind: run.kind, agent: "claude", cwd: run.cwd },
      configDir,
    );
    if (record !== null) return { sessionId: record.id, resumeSessionId: record.id };
  }
  return { sessionId: randomUUID() };
}

/** The agent-backend seam's claude adapter. */
export const claudeBackend: AgentBackend = {
  id: "claude",
  label: "Claude Code",
  defaultBin: "claude",
  binEnv: "TUMWATER_CLAUDE_BIN",

  minVersion: claudeMinVersion,

  resolveBin(config: BackendBinConfig): ResolvedBackendBin {
    return resolveBinForBackend(config, this);
  },

  invocation(run: AgentRunSpec): AgentInvocation {
    // Part 4b/7's config routing fills a claude tier default before the seam, so a nameless
    // run here is a caller bug (a config that named claude without going through the views).
    if (run.config.model === undefined) {
      throw new Error("claude backend: no model resolved for this run");
    }
    // The configured team config dir (plans/notes-command.md "Keeping funes out of team runs"):
    // the run's env, its resume lookup, and the account seed all follow it; unset, nothing changes.
    const claudeCfg = resolvedBackendConfig(run.config, "claude");
    const configDir = claudeCfg.configDir;
    const expandedConfigDir =
      configDir !== undefined ? claudeConfigDir(process.env, os.homedir(), configDir) : undefined;
    const { sessionId, resumeSessionId } = resolveClaudeSession(run, configDir);
    const { args, stdin } = claudeArgs({
      cwd: run.cwd,
      model: run.config.model,
      thinking: run.config.thinking,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : { sessionId }),
      // The operator's `backends.claude.args` passthrough, appended after the harness flags (the
      // builder rejects any entry that repeats a harness-managed flag). resolvedBackendConfig
      // owns the view so a caller cannot mutate the loaded config through the returned array.
      args: claudeCfg.args,
      prompt: run.prompt,
      // The caller computes the remaining daily budget for an API-billed claude run and the
      // adapter forwards it; a subscription run or the director passes none (part 7a/7).
      ...(run.maxBudgetUsd !== undefined ? { maxBudgetUsd: run.maxBudgetUsd } : {}),
    });
    // backendBaseEnv applies the run marker and the macOS preload (shared with the pi adapter);
    // claudeEnv layers the backend's own scrub-and-set on top. The notes path rides beside
    // the marker the same way pi's adapter carries it (withNotesPath); from part 2/4 the run
    // saves its note through the `tumwater-notes` command on PATH, so no MCP server reaches the
    // run and `--strict-mcp-config` (always in claude-args.ts) keeps it that way.
    const base = backendRunEnv(run);
    const env = claudeEnv(base, {
      quietTimeoutSeconds: run.config.quietTimeoutSeconds,
      ...(expandedConfigDir !== undefined ? { configDir: expandedConfigDir } : {}),
    });
    return { args, stdin, env, sessionId };
  },

  translator(): StreamTranslator {
    // A third-party provider (Bedrock/Vertex/Foundry) bills as API even when claude's
    // `system/init` omits a usable `apiKeySource`; seedBilling reads the same environment to
    // seed the account file, so both must classify it the same way.
    return claudeTranslator({ thirdPartyProvider: claudeThirdPartyProvider(process.env) });
  },

  resumable(dir: string, opts: { kind: string; agent: string; cwd?: string }, configDir?: string): boolean {
    return claudeResumableRecord(dir, opts, configDir) !== null;
  },

  // Every Claude model reads images (Claude Code's Read tool returns them as image blocks), so
  // a claude seam is always capable — the doctor probes nothing and never works around it.
  imageInput(): boolean {
    return true;
  },

  classifyExit: classifyClaudeExit,
};
