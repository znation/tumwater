/** Installing the per-team `tumwater-notes` shim every backend's run finds on its PATH
 * (plans/notes-command.md "Reaching it from a run"): run-spawn calls `ensureNotesShim(root)`
 * before building each invocation, and the backend prepends the returned dir to the run's
 * PATH (backendBaseEnv's `binDir`, src/process/run-marker.ts). The shim is a two-line `sh`
 * script that execs the compiled notes CLI, so a model's shell — pi's, Claude Code's or
 * OpenCode's — runs the same command on every backend.
 *
 * The `<dist>` in the exec path is the shared distDir (src/build/build-info.ts), derived from
 * this module's own location so a staged build (.tumwater/build/<sha>) points its shim at its
 * own copy rather than the installed package's. The script is written
 * atomically and made executable, only when its content differs, so a redeploy re-points it
 * without churning the file. */

import fs from "node:fs";
import path from "node:path";
import { distDir } from "../build/build-info.js";
import { readTextOrNull, writeTextAtomic } from "../files/files.js";
import { notesShimDir } from "../paths.js";

/** The shim's file name — the command name every run sees on its PATH. */
export const NOTES_SHIM_NAME = "tumwater-notes";

/** Install the `tumwater-notes` shim under `<root>/.tumwater/bin` and return that directory.
 * The shim is written atomically with mode 0755, only when its content differs from what is
 * already there (a redeploy that changes `<dist>` rewrites it). Never throws: a failure to
 * write is the caller's to absorb — run-spawn logs one warning and runs without the shim. */
export function ensureNotesShim(root: string, execPath: string = process.execPath): string {
  const dir = notesShimDir(root);
  const target = path.join(dir, NOTES_SHIM_NAME);
  // Prefer the recorded node binary, falling back to `node` on PATH when it is gone — a
  // Homebrew node upgrade under the running team deletes the old keg while the team keeps
  // running on it, so `process.execPath` names a file that no longer exists (BUGS.md
  // 2026-10-21). The `[ -x "$n" ]` check answers at run time, so a shim written long ago
  // still survives an upgrade, and the running orchestrator's repeated rewrites stop
  // restoring the broken path.
  const content = `#!/bin/sh\nn="${execPath}"; [ -x "$n" ] || n=node; exec "$n" "${path.join(distDir(), "src", "notes-cli.js")}" "$@"\n`;
  const needsWrite = readTextOrNull(target) !== content; // absent or unreadable — write it
  if (needsWrite) {
    writeTextAtomic(target, content);
  }
  fs.chmodSync(target, 0o755);
  return dir;
}
