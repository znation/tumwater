// vocabulary: plain
import { installDrift } from "../build/dep-install.js";

/** How long a computed drift answer is reused. The answer depends on two files (the lockfile and
 * each installed manifest), so it is throttled by time rather than keyed by stat: the dashboard
 * polls every second and must not re-parse a large lockfile each time. */
const ROOT_INSTALL_POLL_MS = 60_000;

/** Safety cap, as in files/stat-cache.ts: many short-lived roots (tests) cannot grow the map
 * unbounded. */
const MAX_ROOTS_CACHED = 64;

const cache = new Map<string, { at: number; drift: string[] }>();

/** Direct dependencies `root`'s node_modules does not hold at package-lock.json's pin (the
 * doctor's `root install` row), recomputed at most once per ROOT_INSTALL_POLL_MS per root.
 * `[]` when there is no readable lockfile. The caller owns the returned array. */
export function collectRootInstallDrift(root: string, now: number): string[] {
  const hit = cache.get(root);
  if (hit && now - hit.at < ROOT_INSTALL_POLL_MS) return [...hit.drift];
  const drift = installDrift(root);
  if (cache.size >= MAX_ROOTS_CACHED) cache.clear();
  cache.set(root, { at: now, drift });
  return [...drift];
}

/** Forget every cached answer (tests). */
export function resetRootInstallCache(): void {
  cache.clear();
}
