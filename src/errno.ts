/** Helper for reading a Node.js errno error's `code` — the `code`-tagged errors fs and process
 * calls throw (ENOENT, EACCES, EEXIST, EPERM, EADDRINUSE, …). The unsafe cast lives in exactly
 * one place instead of being repeated per catch site: consumers ask `errCode(err)` instead of
 * casting the unknown throw themselves. The fabricate half — building a synthetic errno throw
 * to stub a call with — is test-suite-only and lives with the other fault-injection helpers
 * (test/fs-faults.ts). Depends on nothing. */

/** The errno `code` of a thrown unknown value, when it carries one as a string (the shape of
 * Node's fs and process errors). Plain Errors, non-Error throws, and non-string codes yield
 * undefined, so callers compare the result directly without touching the throw's shape. */
export function errCode(err: unknown): string | undefined {
  return typeof (err as NodeJS.ErrnoException | undefined)?.code === "string"
    ? (err as NodeJS.ErrnoException).code
    : undefined;
}

