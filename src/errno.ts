/** Helpers for reading and fabricating Node.js errno errors — the `code`-tagged errors fs and
 * process calls throw (ENOENT, EACCES, EEXIST, EPERM, EADDRINUSE, …). The unsafe cast lives in
 * exactly one place instead of being repeated per catch site: consumers ask `errCode(err)`
 * instead of casting the unknown throw themselves, and tests build synthetic errno throws with
 * `errnoError` rather than re-stating the Object.assign dance. Depends on nothing. */

/** The errno `code` of a thrown unknown value, when it carries one as a string (the shape of
 * Node's fs and process errors). Plain Errors, non-Error throws, and non-string codes yield
 * undefined, so callers compare the result directly without touching the throw's shape. */
export function errCode(err: unknown): string | undefined {
  return typeof (err as NodeJS.ErrnoException | undefined)?.code === "string"
    ? (err as NodeJS.ErrnoException).code
    : undefined;
}

/** An Error carrying the errno `code`, the shape fs and process calls throw — for tests that
 * stub those calls with a synthetic failure, and anywhere a synthetic errno error is raised. */
export function errnoError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
}
