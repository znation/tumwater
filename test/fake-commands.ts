// --- The fake-command machinery (writeScript/pathPrepend), split out of the old util.ts grab-bag ---
// Every fake command a test installs — fake git, fake npm, fake pi, fake build tools — is a
// symlink to one committed shim whose script body lives beside it, and tests point PATH at a
// directory holding the fakes they need. This module is that generic install machinery; the
// specific families built on it live in fake-pi.ts (fake pi) and the test files themselves
// (fake git/npm, build tools). loop-fixtures.ts also imports writeScript for its
// buildCheckFixture.

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

/** The suite's one committed executable (test/fixtures/script-shim): every fake command a
 * test installs through writeScript is a symlink to it. Resolved from the source tree, which
 * sits beside dist/ whenever the compiled tests run. */
const SCRIPT_SHIM = fileURLToPath(new URL("../../test/fixtures/script-shim", import.meta.url));
// Read-only, so a test that writes to a fake's path (instead of calling writeScript again)
// fails on EACCES right there, rather than writing through the symlink and silently turning
// every other fake in the run into its body. Git records only the executable bit, so this
// never shows up as a change.
try {
  fs.chmodSync(SCRIPT_SHIM, 0o555);
} catch {
  // A read-only checkout already is; the fakes still run.
}

/** Install a fake command at `file` that runs `body` under /bin/sh exactly as a `#!/bin/sh`
 * script holding it would — same process, $0 and arguments — without creating a new
 * executable: macOS scans each newly created executable on its first exec (~150 ms apiece,
 * far more under load), which hundreds of per-test fakes turned into minutes of suite time.
 * `file` becomes a symlink to the committed script-shim, which sources `<file>.sh`. To change
 * a fake, call this again: writing to `file` itself would write through the link into the
 * shim. */
export function writeScript(file: string, body: string): void {
  fs.writeFileSync(`${file}.sh`, `${body}\n`);
  fs.rmSync(file, { force: true });
  fs.symlinkSync(SCRIPT_SHIM, file);
}

/** The manifest every test project writes to its package.json: same name and version across
 * the suite, with the caller's npm scripts. Single-homed so a shape change (a new field, a
 * different project name) lands in all ~30 fixture sites at once instead of one at a time. */
export function projManifest(scripts: Record<string, string | null>): string {
  return JSON.stringify({ name: "proj", version: "1.0.0", scripts });
}

/** Put a directory at the front of PATH for the duration of a test, so executables dropped
 * into it shadow the real ones (the same technique behind every fake-* helper here).
 * Returns a restore function. */
export function pathPrepend(dir: string): () => void {
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
  return () => {
    process.env.PATH = oldPath;
  };
}
