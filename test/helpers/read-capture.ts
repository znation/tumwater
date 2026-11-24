/** The tests' single home for "read a capture log, or empty if the fake never wrote it": the
 * `fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""` guard that fourteen call sites across nine
 * test files hand-rolled when this was factored out (2026-11-21): the capture logs the fake shims
 * append to — the codex/opencode delete captures in retention, session-ledger, session-ledger-prune
 * and opencode-run, a fake pi's argv log in orchestrator-budget, `loggingGit`'s fake-git call log
 * in orchestrator-poll-reserve-exit, github-issue-mirrors and github-issue-queue, a notify hook's
 * output file in cli-start-shutdown. A fake shim writes its capture file only when it is invoked,
 * so an absent file is the answer "nothing was called", and an assertion on "" is the meaningful
 * one. Unlike readJson, this is tolerant on purpose: a test that needs the file to exist
 * should read it strictly, not treat a missing capture as "". Not converted: plain
 * project-file reads with the same guard, which are not
 * captures (orchestrator-3's .gitignore, validation-gap's URL, post-merge-review's BUGS.md); and
 * the guard's variants that fall back to something other than "" and so answer a different
 * question (prompt-commands' and operator-retire's `null`, build-check-process's `0`, supervisor's
 * `"(none)"`). */
import fs from "node:fs";

export function readCapture(file: string | URL): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
