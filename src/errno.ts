/** Helper for reading a Node.js errno error's `code` — the `code`-tagged errors fs and process
 * calls throw (ENOENT, EACCES, EEXIST, EPERM, EADDRINUSE, …). The unsafe cast lives in exactly
 * one place instead of being repeated per catch site: consumers ask `errCode(err)` instead of
 * casting the unknown throw themselves. The fabricate half — building a synthetic errno throw
 * to stub a call with — is test-suite-only and lives with the other fault-injection helpers
 * (test/helpers/fs-faults.ts). Depends on nothing. */

/** The errno `code` of a thrown unknown value, when it carries one as a string (the shape of
 * Node's fs and process errors). Plain Errors, non-Error throws, and non-string codes yield
 * undefined, so callers compare the result directly without touching the throw's shape. */
export function errCode(err: unknown): string | undefined {
  return typeof (err as NodeJS.ErrnoException | undefined)?.code === "string"
    ? (err as NodeJS.ErrnoException).code
    : undefined;
}

/** True when `err`'s errno code says the path itself holds no file: a deleted path (`ENOENT`) or
 * one whose parent component is a regular file (`ENOTDIR`). The "already absent" classification
 * every consumer that must tell a missing path from a genuinely unreadable one (a read whose
 * EACCES must surface rather than read as empty) used to inline as the code pair, in three
 * modules; it lives here so they cannot drift. Depends only on `errCode`. */
export function isErrAbsent(err: unknown): boolean {
  const code = errCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}
