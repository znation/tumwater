import type { TumwaterConfig } from "../config/config-schema.js";
import { detectBuildCheck, type BuildCheck } from "./build-check-detect.js";

/** The throttled reader of a project's declared check, beside the detection it caches. Split out
 * of status/status-polls.ts, where it sat with the other per-poll cached readers, because it is
 * not a status concern: it is `detectBuildCheck` with a time throttle, and its two consumers are
 * the status snapshot's `noDeclaredCheck` field and the orchestrator's check-declaration request
 * (prompt/check-declaration-request.ts). Kept in the status layer, that second reader had to
 * import UP into src/status to get it — the only such edge from src/prompt in the tree. Here both
 * consumers reach down to the layer that owns the question. */

/** How long a computed `check` detection answer is reused. Detection needs the project's `check`
 * config plus a walk-up over the filesystem scalars (each ancestor's package.json and
 * node_modules existence, and the package.json's scripts), so it is throttled by time rather than
 * keyed by a single stat: the dashboards poll every second but these inputs change only when the
 * operator edits tumwater.json or the repo structure, and `snapshot()`'s `noDeclaredCheck` asks
 * it every poll. Mirrors the collectRootInstallDrift throttle (status/status-install.ts), the
 * other multi-read per-second figure. */
const CHECK_POLL_MS = 15_000;

/** Safety cap, as in files/stat-cache.ts: many short-lived roots (tests) cannot grow the map
 * unbounded. */
const MAX_CHECKS_CACHED = 64;

const buildCheckCache = new Map<string, { at: number; value: BuildCheck | null; key: string }>();

/** This poll's view of the project's declared check: `detectBuildCheck` against the live
 * last-known-good config, recomputed at most once per CHECK_POLL_MS per root. Keyed on the
 * config's check slice too, so a live `config set check.*` lands within the throttle instead of
 * waiting out the window. The caller owns the returned value. */
export function buildCheckForPoll(root: string, cfg: TumwaterConfig): BuildCheck | null {
  const checkSlice = cfg.check && typeof cfg.check === "object"
    ? JSON.stringify(cfg.check)
    : "";
  const key = `${root}\u0000${checkSlice}`;
  const hit = buildCheckCache.get(root);
  const now = Date.now();
  if (hit?.key === key && now - hit.at < CHECK_POLL_MS) return hit.value;
  const value = detectBuildCheck(root, cfg);
  if (buildCheckCache.size >= MAX_CHECKS_CACHED) buildCheckCache.clear();
  buildCheckCache.set(root, { at: now, value, key });
  return value;
}
