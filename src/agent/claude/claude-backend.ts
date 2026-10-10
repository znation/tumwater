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
 * fake under its own id. Part 4/7 makes claude selectable from tumwater.json; until then tests
 * drive it by setting `config.agent = "claude"` on a run. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ResolvedModelConfig } from "../../config/config-views.js";
import { agentBaseEnv } from "../../process/run-marker.js";
import { resolveBinFrom, type ResolvedAgentBin } from "../../pi/pi-bin.js";
import { claudeArgs } from "./claude-args.js";
import { claudeEnv } from "./claude-env.js";
import { claudeTranslator } from "./claude-stream.js";
import { resumableSession, type SessionRecord } from "../session-ledger.js";
import {
  type AgentBackend,
  type AgentExitClassification,
  type AgentExitInfo,
  type AgentInvocation,
  type AgentRunSpec,
  type StreamTranslator,
} from "../agent-backend.js";

/** claude's per-cwd project directory name under `~/.claude/projects/`: every character that
 * is not a letter or digit becomes `-`. Exported with `claudeTranscriptPath` so the PATH fake
 * and the tests create and look for exactly the file the resume check reads. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The transcript file claude writes for a session started in `cwd`: its resume check must find
 * a real file before passing `--resume`. claude's own layout is
 * `~/.claude/projects/<slug>/<sessionId>.jsonl`; exported so the fake and the resume logic
 * cannot drift. */
export function claudeTranscriptPath(cwd: string, id: string): string {
  return path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(cwd), `${id}.jsonl`);
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

  resolveBin(config: Pick<ResolvedModelConfig, "agentBin">): ResolvedAgentBin {
    return resolveBinFrom("TUMWATER_CLAUDE_BIN", "claude", config.agentBin);
  },

  invocation(run: AgentRunSpec): AgentInvocation {
    // Part 4/7 resolves a claude tier default before the seam; until then a run must name a
    // concrete model, and a nameless one is a caller bug, not a claude default.
    if (run.config.model === undefined) {
      throw new Error("claude backend: no model resolved for this run");
    }
    const { sessionId, resumeSessionId } = resolveClaudeSession(run);
    const { args, stdin } = claudeArgs({
      cwd: run.cwd,
      model: run.config.model,
      thinking: run.config.thinking,
      ...(resumeSessionId !== undefined ? { resumeSessionId } : { sessionId }),
      prompt: run.prompt,
    });
    // agentBaseEnv applies the run marker and the macOS preload (shared with the pi adapter);
    // claudeEnv layers the backend's own scrub-and-set on top. The notes MCP config lands here
    // in part 5/7.
    const env = claudeEnv(agentBaseEnv(run.runMarker), {
      quietTimeoutSeconds: run.config.quietTimeoutSeconds,
    });
    return { args, stdin, env, sessionId };
  },

  translator(): StreamTranslator {
    return claudeTranslator();
  },

  resumable(dir: string, opts: { kind: string; agent: string; cwd?: string }): boolean {
    return claudeResumableRecord(dir, opts) !== null;
  },

  classifyExit: classifyClaudeExit,
};
