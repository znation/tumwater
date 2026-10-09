/** Scoped `process.env` overrides, single-homed. Tests that make a production path read an
 * environment variable (PATH for a fake binary, HOME for a config dir, a TUMWATER_* override)
 * all repeat the same save/set/restore dance, and the restore is easy to forget or to get
 * wrong for an originally-unset variable. `setEnv` returns the restore function so a `finally`
 * can call it; `withEnv` wraps a whole body for the common case. */

/** Set `process.env[name]` to `value` — `undefined` deletes it, so a test can exercise the
 * unset case — and return a function that restores the exact prior value (deleting again if it
 * was unset). */
export function setEnv(name: string, value: string | undefined): () => void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

/** Run a synchronous `body` with `process.env[name]` set to `value`, restoring the prior value
 * afterward. (An async body would need `setEnv` in a `try/finally`, since this restores as soon
 * as `body` returns its promise.) */
export function withEnv<T>(name: string, value: string | undefined, body: () => T): T {
  const restore = setEnv(name, value);
  try {
    return body();
  } finally {
    restore();
  }
}
