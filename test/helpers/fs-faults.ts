import fs from "node:fs";

/** Monkey-patched fs entry points: fault-injection helpers that simulate the races and
 * surprises real readers must survive (a log rotation rename landing between a reader's stat
 * and its open, a file vanishing mid-read), plus the read-counting spy the cache tests use,
 * and `errnoError` — the synthetic errno throw a test raises when it stubs an fs or process
 * call. Each patch swaps a global fs entry point for the duration of a call — surgery on
 * shared state, so these live together here rather than beside ordinary fixture builders.
 * `patchFsMethod` single-homes that capture/swap/restore contract. */

/** An Error carrying the errno `code`, the shape fs and process calls throw — the synthetic
 * failure a stubbed call raises (the code under test reads it back with src/errno.ts's
 * `errCode`). Lives beside the injection helpers: simulating a failure and planting it are
 * one concern. */
export function errnoError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
}

type FsCall = (...args: unknown[]) => unknown;

/** Swap fs entry point `name` for `wrapper` for the duration of one test phase. `wrapper`
 * receives the bound original so it can inspect or rewrite arguments and fall through, and
 * the returned undo restores it. The one home of the capture/swap/restore contract the fault
 * helpers below are built from — each sets its own one-shot `hit` flag and side effect inside
 * its wrapper. `withCountedReads`, which scopes its patch to a `body` callback and returns a
 * count, deliberately keeps its own try/finally scaffold. */
function patchFsMethod(name: string, wrapper: (orig: FsCall) => FsCall): () => void {
  const holder = fs as unknown as Record<string, FsCall>;
  const orig = holder[name]!.bind(fs) as FsCall;
  holder[name] = wrapper(orig);
  return () => {
    holder[name] = orig;
  };
}

/** Wrap fs.openSync so the first open of `file` unlinks it instead — simulating a log
 * rotation rename landing between a reader's stat and its open (the race tail readers must
 * survive as "no data", not an ENOENT throw). Returns an undo function. */
export function vanishOnOpen(file: string): () => void {
  let hit = false;
  return patchFsMethod("openSync", (orig) => (p, flags) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return orig(p, flags);
  });
}

/** The rotation twin of vanishOnOpen where the path comes back before open: on the first
 * open of `file`, rename the old file away and recreate it with `content` (smaller than the
 * original in every use so far), then open — simulating a rotation rename plus a fresh append
 * landing between a reader's stat and its open. Returns an undo function. */
export function recreateSmallerOnOpen(file: string, content: string): () => void {
  let hit = false;
  return patchFsMethod("openSync", (orig) => (p, flags) => {
    if (!hit && p === file) {
      hit = true;
      fs.renameSync(file, file + ".1");
      fs.writeFileSync(file, content);
    }
    return orig(p, flags);
  });
}

/** Make the first fs.renameSync whose source path starts with `target` + ".tmp-" throw instead
 * of renaming — simulating the write failure a tmp+rename writer (writeTextAtomic,
 * writeJsonAtomic) must survive without leaving its tmp remnant behind. `target` is the final
 * file path; the tmp name is derived from it, so the wrapper matches the right write without
 * knowing the pid-suffixed tmp name it will pick. Returns an undo function. */
export function failRenameSyncOn(target: string, message: string): () => void {
  let hit = false;
  return patchFsMethod("renameSync", (orig) => (a, b) => {
    if (!hit && typeof a === "string" && a.startsWith(`${target}.tmp-`)) {
      hit = true;
      throw new Error(message);
    }
    return orig(a, b);
  });
}

/** Simulate the process dying partway through a file write: the next fs.writeFileSync writes
 * `partial` to whatever destination the writer chose — a plain writer's target, or a
 * tmp+rename writer's tmp — and throws instead of completing, as if the process was killed
 * after the bytes reached the file and before the call returned. A plain writer leaves the
 * truncated file at its target; a tmp+rename writer leaves the target untouched and cleans up
 * its tmp. Returns an undo function. */
export function dieMidWrite(partial: string): () => void {
  let hit = false;
  return patchFsMethod("writeFileSync", (orig) => (p, ...rest) => {
    if (!hit) {
      hit = true;
      orig(p, partial);
      throw new Error("killed mid-write");
    }
    return orig(p, ...rest);
  });
}

/** The readFileSync twin of vanishOnOpen — for readers that stat and then read a small file
 * whole. Returns an undo function. */
export function vanishOnReadFile(file: string): () => void {
  let hit = false;
  return patchFsMethod("readFileSync", (orig) => (p, ...rest) => {
    if (!hit && p === file) {
      hit = true;
      fs.unlinkSync(file);
    }
    return orig(p, ...rest);
  });
}

/** Swap fs.readFileSync for a pass-through that counts matching reads for the duration of
 * `body`, then restore the original — the idiom behind the stat-keyed-cache tests, which
 * assert that a warm cache costs zero reads and a miss exactly one. `match` filters what
 * counts (default: every read); snapshot tests use it to count one state file's reads while
 * the reader touches many. `body` may call the live `readSoFar` getter to assert mid-body —
 * an assertion placed after `body` would also count the reads its own calls trigger.
 * Returns the final matching-read count. */
export function withCountedReads(
  body: (readSoFar: () => number) => void,
  match: (file: unknown) => boolean = () => true,
): number {
  let reads = 0;
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
      if (match(args[0])) reads += 1;
      return (originalReadFileSync as (...a: unknown[]) => string)(...args);
    };
    body(() => reads);
  } finally {
    (fs as unknown as { readFileSync: unknown }).readFileSync = originalReadFileSync;
  }
  return reads;
}
