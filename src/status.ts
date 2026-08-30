import type { LoopState, TumwaterConfig } from "./types.js";
import { openQuestions } from "./backlog.js";
import { defaultConfig, enabledRoleIds, loadConfigSafe } from "./config.js";
import { statOrNull } from "./files.js";
import { inboxSize } from "./inbox.js";
import { statePath } from "./paths.js";
import { loadLoopState, orchestratorAlive, readOrchestratorInfo } from "./state.js";

/** Status data collection: one fresh snapshot of the fleet for observers (`tumwater
 * status`, TUI, GUI). Rendering lives in status-render.ts. */

export interface StatusSnapshot {
  running: boolean;
  pid?: number;
  inbox: number;
  /** Open questions awaiting a human answer (QUESTIONS.md's ## Open) — the header badge. */
  questions: number;
  loops: LoopState[];
}

// The last config each root loaded successfully. snapshot is polled every second by the
// TUI and GUI, where a throw would kill (or blind) the observer — but tumwater.json can be
// transiently broken while a user edits it live-reload style. On failure we keep showing
// the fleet with the last known-good role set; the orchestrator does the same in its own
// reload poll and surfaces the error as a warning event visible in `tumwater logs`.
const lastGoodConfig = new Map<string, TumwaterConfig>();

/** The config to display loop state against: fresh when valid, otherwise the last
 * known-good one (or defaults if this process never saw a valid file). Never throws. */
function configForStatus(root: string): TumwaterConfig {
  const { config } = loadConfigSafe(root);
  if (config) {
    lastGoodConfig.set(root, config);
    return config;
  }
  return lastGoodConfig.get(root) ?? defaultConfig();
}

// Per-poll loop-state cache: the TUI and GUI poll snapshot every second, but a role's state
// file changes only at its tick boundaries (start/end) — between ticks it sits unchanged for
// minutes. Serve an unchanged file from a stat-keyed cache: one stat syscall per file per
// poll instead of re-reading and re-parsing JSON that hasn't moved, the same freshness check
// as backlog.ts's markdown readers (any write invalidates via dev/ino/mtime/size). Keyed by
// state-file path so distinct roots never collide; capped like backlog.ts so many short-lived
// roots in tests cannot grow it unbounded.
interface LoopStateCache {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  value: LoopState;
}
const loopStateCache = new Map<string, LoopStateCache>();
/** Safety cap so the cache can never grow unbounded (e.g. many short-lived roots in tests).
 * Evicting only costs one re-read per file on the next call. */
const MAX_CACHED_LOOP_STATES = 64;

/** This poll's view of one role's state: fresh when the file changed since this process last
 * read it, cached otherwise (see above). Returns a copy so each snapshot owns its data —
 * mutating one poll's LoopState must not poison later polls. */
function loopStateForPoll(root: string, role: string): LoopState {
  const file = statePath(root, role);
  const st = statOrNull(file);
  if (!st) {
    loopStateCache.delete(file); // Vanished — drop any stale entry.
    return loadLoopState(root, role);
  }
  const cached = loopStateCache.get(file);
  if (
    cached &&
    cached.dev === st.dev &&
    cached.ino === st.ino &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size
  ) {
    return { ...cached.value }; // A copy: callers may treat the result as their own.
  }
  const value = loadLoopState(root, role);
  if (loopStateCache.size >= MAX_CACHED_LOOP_STATES) loopStateCache.clear();
  loopStateCache.set(file, { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, value });
  return { ...value };
}

export function snapshot(root: string): StatusSnapshot {
  const roles = enabledRoleIds(configForStatus(root));
  const info = readOrchestratorInfo(root);
  return {
    running: orchestratorAlive(root),
    pid: info?.pid,
    inbox: inboxSize(root),
    questions: openQuestions(root).length,
    loops: roles.map((r) => loopStateForPoll(root, r)),
  };
}
