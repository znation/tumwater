// Open text in the operator's editor, the way `git commit` and `crontab -e` do.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./cli-output.js";

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
      const how = r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `status ${r.status}`;
      failure = `editor exited with ${how}; nothing changed`;
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
