/** The claude adapter for the agent seam (plans/agent-backends.md "The seam", "Sessions",
 * "The claude invocation"). It shapes one run's argv/stdin/env, translates claude's
 * `stream-json` into the canonical stream, and classifies the exit's stderr — everything
 * backend-specific. src/agent/run-agent.ts owns the spawn and records this run in the session
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
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolvedAgentConfig } from "../../config/config-views.js";
import { MODEL_TIERS } from "../../config/config-schema.js";
import { routeModel } from "../../config/model-selector.js";
import { agentBaseEnv } from "../../process/run-marker.js";
import { resolveBackendBin, type ResolvedAgentBin } from "../../pi/pi-bin.js";
import { claudeArgs } from "./claude-args.js";
import { claudeEnv, claudeThirdPartyProvider } from "./claude-env.js";
import { claudeTranslator } from "./claude-stream.js";
import { resumableSession, type SessionRecord } from "../session-ledger.js";
import type {
  AgentBackend,
  AgentBinConfig,
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
 * against the home dir), else `~/.claude`. This mirrors claude's own lookup and pi's
 * `piAgentDir`; exported so doctor reads the same dir the adapter writes transcripts into. */
export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return path.join(homeDir, ".claude");
  if (dir === "~") return homeDir;
  if (dir.startsWith("~/")) return path.join(homeDir, dir.slice(2));
  return dir;
}

/** The transcript file claude writes for a session started in `cwd`: its resume check must find
 * a real file before passing `--resume`. claude's own layout is
 * `<config>/projects/<slug>/<sessionId>.jsonl`; exported so the fake and the resume logic
 * cannot drift. */
export function claudeTranscriptPath(
  cwd: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  return path.join(
    claudeConfigDir(env, homeDir),
    "projects",
    claudeProjectSlug(cwd),
    `${id}.jsonl`,
  );
}

/** The CLI version every gated claude model needs (plans/agent-backends.md finding 9): on
 * 2.1.216 Opus 5.5 is refused outright and Haiku 5.5 is mispriced about 250×, and fleet runs
 * set DISABLE_AUTOUPDATER so they never update themselves. The gated models are the three
 * tier defaults, derived from AGENT_DEFAULT_MODELS through the same routing the config uses
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

/** The inline `--mcp-config` JSON that runs the bundled role-notes server (part 5/7): the
 * same dist module pi's extension resolves to, spawned by the same node running this harness
 * so it needs no PATH lookup. */
function roleNotesMcpConfig(): string {
  const server = fileURLToPath(new URL("../mcp/role-notes-server.js", import.meta.url));
  return JSON.stringify({ mcpServers: { tumwater: { command: process.execPath, args: [server] } } });
}

/** The ledger record this run may resume, or null: the newest record of `opts.kind` for
 * claude, at `opts.cwd` when one is given, whose transcript file exists. Shared by
 * `resolveClaudeSession` and the backend's `resumable` hook, so the resume guard and the
 * invocation can never drift on what counts as resumable. */
function claudeResumableRecord(
  dir: string,
  opts: { kind: string; agent: string; cwd?: string },
): SessionRecord | null {
  const record = resumableSession(dir, opts);
  if (record === null) return null;
  if (opts.cwd !== undefined && record.cwd !== opts.cwd) return null;
  if (!fs.existsSync(claudeTranscriptPath(record.cwd, record.id))) return null;
  return record;
}

/** The session id this run uses: for a continue, the ledger's newest record of this kind when
 * it is claude's, this cwd's, and its transcript file exists; otherwise a fresh UUID. Returns
 * the id and the `--resume` id when resuming. */
function resolveClaudeSession(run: AgentRunSpec): { sessionId: string; resumeSessionId?: string } {
  if (run.continueSession) {
    const record = claudeResumableRecord(run.sessionDir, {
      kind: run.kind,
      agent: "claude",
      cwd: run.cwd,
    });
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

  resolveBin(config: AgentBinConfig): ResolvedAgentBin {
    return resolveBackendBin(config, this);
  },

  invocation(run: AgentRunSpec): AgentInvocation {
    // Part 4b/7's config routing fills a claude tier default before the seam, so a nameless
    // run here is a caller bug (a config that named claude without going through the views).
    if (run.config.model === undefined) {
      throw new Error("claude backend: no model resolved for this run");
    }
    const { sessionId, resumeSessionId } = resolveClaudeSession(run);
    const { args, stdin } = claudeArgs({
      cwd: run.cwd,
      model: run.config.model,
      thinking: run.config.thinking,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : { sessionId }),
      // The operator's `agents.claude.args` passthrough, appended after the harness flags (the
      // builder rejects any entry that repeats a harness-managed flag). resolvedAgentConfig
      // owns the view so a caller cannot mutate the loaded config through the returned array.
      args: resolvedAgentConfig(run.config, "claude").args,
      prompt: run.prompt,
      // The caller computes the remaining daily budget for an API-billed claude run and the
      // adapter forwards it; a subscription run or the director passes none (part 7a/7).
      ...(run.maxBudgetUsd !== undefined ? { maxBudgetUsd: run.maxBudgetUsd } : {}),
      // claude does not load the bundled pi extensions, so a run carrying a notebook gets the
      // role_notes MCP server instead. Passed on EVERY claude invocation that carries a
      // notebook — fresh or resumed, a transient retry, a SUMMARY follow-up — because claude
      // keeps no flags across --resume, so a resume without this would lose the tool.
      ...(run.notesPath !== undefined ? { mcpConfig: roleNotesMcpConfig() } : {}),
    });
    // agentBaseEnv applies the run marker and the macOS preload (shared with the pi adapter);
    // claudeEnv layers the backend's own scrub-and-set on top. The notebook path rides beside
    // the marker the same way pi's adapter carries it (pi-backend.ts withNotesPath), so the
    // spawned MCP server — which inherits this environment — reads the same notes file.
    const base =
      run.notesPath === undefined
        ? agentBaseEnv(run.runMarker)
        : { ...agentBaseEnv(run.runMarker), TUMWATER_NOTES_PATH: run.notesPath };
    const env = claudeEnv(base, {
      quietTimeoutSeconds: run.config.quietTimeoutSeconds,
    });
    return { args, stdin, env, sessionId };
  },

  translator(): StreamTranslator {
    // A third-party provider (Bedrock/Vertex/Foundry) bills as API even when claude's
    // `system/init` omits a usable `apiKeySource`; seedBilling reads the same environment to
    // seed the account file, so both must classify it the same way.
    return claudeTranslator({ thirdPartyProvider: claudeThirdPartyProvider(process.env) });
  },

  resumable(dir: string, opts: { kind: string; agent: string; cwd?: string }): boolean {
    return claudeResumableRecord(dir, opts) !== null;
  },

  // Every Claude model reads images (Claude Code's Read tool returns them as image blocks), so
  // a claude seam is always capable — the doctor probes nothing and never works around it.
  imageInput(): boolean {
    return true;
  },

  classifyExit: classifyClaudeExit,
};
