/** Shared environment-building skeleton for the three agent backend env builders
 * (claude-env.ts, codex-env.ts, opencode-env.ts). Each backend isolates one run the same shape:
 * copy the keys of `base` that survive the scrub, then let the backend set its own run vars.
 * The copy half never writes anything but `keep`-accepted keys of `base`, so a caller's base
 * (the process env, or a layered run-marker/notes/preload env) is never mutated — the invariant
 * the per-backend tests pin. */

/** One backend's scrub-and-set policy for building a run's process environment. */
interface EnvScrub {
  /** Which keys of `base` survive into the run's environment. */
  keep: (key: string) => boolean;
  /** Set the backend's own run-isolation variables on the fresh (base-derived) env. */
  then: (env: NodeJS.ProcessEnv) => void;
}

/** Build a process environment from `base` under `scrub` without mutating `base`: copy the
 * `keep`-accepted base entries into a fresh object, then hand it to `then` for the backend's
 * own additions. */
export function scrubEnv(base: NodeJS.ProcessEnv, scrub: EnvScrub): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (scrub.keep(key)) env[key] = value;
  }
  scrub.then(env);
  return env;
}
