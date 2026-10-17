// vocabulary: plain
/** The opencode adapter for the agent seam (plans/opencode-backend.md "The invocation",
 * "Sessions", §6). It shapes one run's argv/stdin/env, translates opencode's `run --format
 * json` into the canonical stream, runs the authoritative session export after the process
 * exits, and classifies the exit's stderr — everything backend-specific. src/agent/run-agent.ts
 * owns the spawn and records this run in the session ledger; opencode mints its own session id
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
 * Registration lives in src/agent/run-agent.ts beside the pi and claude adapters; a test selects
 * opencode by setting `config.agent = "opencode"` on a run. A run carrying a notebook gets the
 * bundled role-notes MCP server under `mcp.servers.tumwater` (part 5b/7) and the notes path in
 * its environment, as the pi and claude adapters do. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigSafe } from "../../config/config.js";
import { resolvedAgentConfig } from "../../config/config-views.js";
import { agentBaseEnv } from "../../process/run-marker.js";
import { resolveBackendBin, type ResolvedAgentBin } from "../../pi/pi-bin.js";
import { opencodeDbPath } from "../../paths.js";
import type {
  AgentBackend,
  AgentBinConfig,
  AgentExitClassification,
  AgentExitInfo,
  AgentInvocation,
  AgentRunSpec,
  StreamTranslator,
} from "../agent-backend.js";
import { resumableSession } from "../session-ledger.js";
import { opencodeArgs } from "./opencode-args.js";
import { opencodeConfigContent, operatorMcpNames } from "./opencode-config.js";
import { opencodeEnv } from "./opencode-env.js";
import { mintOpencodeSessionId } from "./opencode-session-id.js";
import { opencodeExportLines, opencodeTranslator, type OpencodeStreamTranslator } from "./opencode-stream.js";

/** How long a post-run `opencode session export` may take before it gives up (design §6): the
 * export measured 0.18 s live, so 10 s is a generous bound on a slow or wedged CLI. Used for
 * both the resume-existence check and the reconciling export. */
const EXPORT_TIMEOUT_MS = 10_000;

/** The team root that owns `sessionDir`: the `.tumwater` directory that contains it. A run's
 * session dir is always `<root>/.tumwater/sessions/…`, so the first ancestor holding a
 * `.tumwater` directory is the root; opencodeDbPath reads back to that same `.tumwater` for
 * the run's shared database. */
function teamRootOf(sessionDir: string): string {
  let dir = sessionDir;
  for (let i = 0; i < 64; i += 1) {
    let tumwater: fs.Stats | undefined;
    try {
      tumwater = fs.statSync(path.join(dir, ".tumwater"));
    } catch {
      tumwater = undefined;
    }
    if (tumwater?.isDirectory()) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Unreachable in a harness run; a sensible fallback for an odd session dir.
  return path.dirname(path.dirname(sessionDir));
}

/** Run `opencode session export <id> --standalone` (the same database the run used, bounded at
 * 10 s) and return whether it reported success — the existence check that decides a resume.
 * Nonzero exit, a timeout, or a spawn failure all read as "no such session", which is the safe
 * direction: `--session` would otherwise silently create a missing session. */
function opencodeSessionExists(id: string, env: NodeJS.ProcessEnv, bin: string, cwd: string): boolean {
  try {
    const res = spawnSync(bin, ["session", "export", id, "--standalone"], {
      env,
      cwd,
      timeout: EXPORT_TIMEOUT_MS,
      stdio: "ignore",
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Run the reconciling export after a successful run and return its two canonical lines
 * (`run_cost`, `run_usage`) from the session's `info`. Anything that goes wrong — a spawn or
 * timeout, a nonzero exit, unparseable or malformed output — returns `[]`, and the caller
 * (afterRun) reports `opencode_usage_partial` so the run keeps its streamed numbers. */
function opencodeExport(result: { id: string; env: NodeJS.ProcessEnv; bin: string; cwd: string }): string[] {
  let res;
  try {
    res = spawnSync(result.bin, ["session", "export", result.id, "--standalone"], {
      env: result.env,
      cwd: result.cwd,
      timeout: EXPORT_TIMEOUT_MS,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  if (res.status !== 0 || !res.stdout) return [];
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

/** The bundled role-notes MCP server's dist module, resolved exactly as claude-backend.ts's
 * `roleNotesMcpConfig` resolves it (the same dist module the bundled pi extensions reach), so
 * OpenCode runs it under the same node running this harness. */
function roleNotesServerPath(): string {
  return fileURLToPath(new URL("../mcp/role-notes-server.js", import.meta.url));
}

/** The agent-backend seam's opencode adapter. */
export const opencodeBackend: AgentBackend = {
  id: "opencode",
  label: "OpenCode",
  defaultBin: "opencode",
  binEnv: "TUMWATER_OPENCODE_BIN",

  resolveBin(config: AgentBinConfig): ResolvedAgentBin {
    return resolveBackendBin(config, this);
  },

  invocation(run: AgentRunSpec): AgentInvocation {
    // The shared database and injected config are per-root, built the same way for every run of
    // this team so a resume's export check reads the same OPENCODE_DB the original run wrote.
    const dbPath = opencodeDbPath(teamRootOf(run.sessionDir));
    const configContent = opencodeConfigContent({
      cwd: run.cwd,
      operatorMcpNames: operatorMcpNames(process.env, os.homedir()),
      // A run carrying a notebook gets tumwater's bundled role-notes MCP server under
      // `mcp.servers.tumwater`. Passed on EVERY invocation that carries notes — fresh or
      // resumed, a transient retry, a SUMMARY follow-up — because OpenCode's config is per
      // process.
      ...(run.notesPath !== undefined
        ? { notesServer: { command: [process.execPath, roleNotesServerPath()], notesPath: run.notesPath } }
        : {}),
    });
    // The notebook path rides beside the run marker so the spawned MCP server — which inherits
    // this environment — reads the same notes file, as the pi and claude adapters' envs do.
    const base =
      run.notesPath === undefined
        ? agentBaseEnv(run.runMarker)
        : { ...agentBaseEnv(run.runMarker), TUMWATER_NOTES_PATH: run.notesPath };
    const env = opencodeEnv(base, { dbPath, configContent });
    const { sessionId } = resolveOpencodeSession(run, env);
    const { args, stdin } = opencodeArgs({
      model: run.config.model ?? "",
      sessionId,
      title: run.sessionName,
      args: resolvedAgentConfig(run.config, "opencode").args,
      prompt: run.prompt,
    });
    return { args, stdin, env, sessionId };
  },

  translator(): OpencodeStreamTranslator {
    return opencodeTranslator();
  },

  resumable(dir: string, opts: { kind: string; agent: string; cwd?: string }): boolean {
    const record = resumableSession(dir, { kind: opts.kind, agent: "opencode", cwd: opts.cwd });
    if (record === null) return false;
    const root = teamRootOf(dir);
    const dbPath = opencodeDbPath(root);
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
