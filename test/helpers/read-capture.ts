/** The tests' single home for "read a capture log, or empty if the fake never wrote it": the
 * `fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""` guard that nine call sites across five
 * test files hand-rolled when this was factored out (2026-11-21): the fake-shim capture logs in
 * retention, session-ledger, session-ledger-prune, opencode-run and orchestrator-budget. A fake
 * shim writes its capture file only when it is invoked, so an absent file is the answer "nothing
 * was called", and an assertion on "" is the meaningful one. Unlike readJson, this is tolerant on
 * purpose: a test that needs the file to exist should read it strictly, not treat a missing
 * capture as "". Not converted: plain project-file reads with the same guard (orchestrator-3's
 * .gitignore, validation-gap's URL), which are not captures. */
import fs from "node:fs";

export function readCapture(file: string | URL): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
