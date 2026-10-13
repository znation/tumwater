// Open text in the operator's editor, the way `git commit` and `crontab -e` do.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./cli-output.js";

/** Signal number → name, for the shell's 128+n convention: a shell that does not re-raise a
 * signal-killed child (dash on Linux) exits with 128+signo, so node sees an exit status where
 * bash on macOS lets it see the signal. Keyed by number, so a later alias (SIGABRT over SIGIOT)
 * wins; any name is fine for the message. */
const SIGNAL_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(os.constants.signals).map(([name, n]) => [n, name]),
);

/** How an editor run ended, naming a signal even when the shell folded it into 128+n. A null
 * status (spawn error, signal) and a plain non-zero status fall through unchanged. */
function exitReason(r: { error?: Error; signal: NodeJS.Signals | null; status: number | null }): string {
  if (r.error) return r.error.message;
  if (r.signal) return `signal ${r.signal}`;
  const signalled = r.status !== null && r.status > 128 ? SIGNAL_NAMES[r.status - 128] : undefined;
  return signalled ? `signal ${signalled}` : `status ${r.status}`;
}

/** Write `initial` to a temp file named `fileName`, run `$VISUAL` (else `$EDITOR`) on it, and
 * return the saved text. The editor value runs through `sh -c` (git's convention) so one with
 * arguments, like `code -w`, works. There is no `vi` fallback: a script without a TTY must fail
 * rather than hang. A missing editor, a spawn error, a non-zero exit, or a signal fails the
 * command (`fallback` ends the no-editor message); the temp dir is removed before the failure exits. */
export function editInEditor(initial: string, fileName: string, fallback = "pass the new text or --file <path>"): string {
  const editor = (process.env.VISUAL || process.env.EDITOR || "").trim();
  if (editor === "") fail(`no editor: set $VISUAL or $EDITOR, or ${fallback}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tumwater-edit-"));
  let saved: string | undefined;
  let failure: string | undefined;
  try {
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, `${initial}\n`);
    const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    if (r.error || r.status !== 0) {
      failure = `editor exited with ${exitReason(r)}; nothing changed`;
    } else {
      saved = fs.readFileSync(file, "utf8");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // fail() exits the process, which would skip the finally above, so it runs after cleanup.
  if (failure !== undefined) fail(failure);
  return saved as string;
}
