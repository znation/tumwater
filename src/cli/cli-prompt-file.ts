/** The `--file` prompt source every --file-taking command reads: the missing-value and
 * flag-shaped-value refusals, the read (naming the file's role in its error), the empty-file
 * refusal, and the stdin (`-`) read memoized once per process. Split out of cli/cli-command-args.ts
 * — home of the init and prompt free-form parsers — because this is the one file I/O in the CLI's
 * arg layer, and its consumers reach across every command family: init, prompt's edit and enqueue
 * branches, plan/bug add and edit (fileAndAnnounce / editAndAnnounce), brief, role
 * (--notes-file / --instructions-file), and questions. Holding it here, beside the arg layer that
 * first read prompt files, keeps the parsers' shared vocabulary (cli/cli-flag-specs.ts) and the
 * cross-command file rule in one module each. */
import fs from "node:fs";
import { rejectFlagLookingValue } from "./cli-args.js";
import { fail } from "./cli-output.js";
import { errorMessage } from "../text/text.js";

/** Read a `--file <path>` prompt file: fail naming the file when it cannot be read. A raw
 * ENOENT/EISDIR names the path but not its role, so the message says this was the --file
 * prompt. Shared by the init and prompt parsers' path branches; the prompt parser's stdin
 * branch (`-`) reads fd 0 itself — its read must be cached and its read-error names stdin —
 * and both parsers check emptiness through failEmptyPromptFile (via readPromptFileChecked
 * for real paths). */
function readPromptFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    fail(`cannot read prompt file ${JSON.stringify(file)}: ${errorMessage(err)}`);
  }
}

/** A `--file <path>` value that must be present: the one home of the missing-value refusal
 * shared by every `--file`-taking parser — init, prompt's edit and enqueue branches, plan/bug
 * add and edit (fileAndAnnounce / editAndAnnounce), and the questions command — so the wording
 * cannot drift between them. The flag token itself is claimed by each parser's stray-argument
 * accounting; this helper only owns the value. A flag-shaped token (`--file --json`) is
 * refused up front via rejectFlagLookingValue instead of being read as a path that fails deep
 * with a misleading "cannot read prompt file" about a flag nobody intended as a file. */
export function promptFileValue(file: string | undefined): string {
  rejectFlagLookingValue("--file", file);
  if (!file) fail("--file needs a path");
  return file;
}

/** The read+emptiness pair both parsers apply to a real `--file <path>`: read through
 * readPromptFile (whose error names the file's role) and refuse an empty file through
 * failEmptyPromptFile, in one place so the two parsers' path branches cannot drift apart.
 * The prompt parser's stdin branch (`-`) keeps its own read — it must be cached and its
 * read-error names stdin — and calls failEmptyPromptFile itself. */
export function readPromptFileChecked(file: string): string {
  const contents = readPromptFile(file);
  failEmptyPromptFile(file, contents);
  return contents;
}

/** Fail when a read `--file` prompt holds no text: an empty (or whitespace-only) file reads
 * as an empty prompt, which the bare-init path would then treat as "re-seed from README.md"
 * (the operator's --file argument silently ignored on an initialized repo), and a generic
 * "a brief is required" (which never names the file) on a fresh one; the prompt
 * queue would enqueue nothing. Names the file, like every other bad --file shape. Shared by
 * the init and prompt parsers, so the message cannot drift between them. */
function failEmptyPromptFile(file: string, contents: string): void {
  if (contents.trim() === "")
    fail(`the prompt file ${JSON.stringify(file)} is empty — it carries no prompt text`);
}

/** The stdin prompt read once per process: cli.ts pre-parses prompt's args and cmdPrompt
 * re-parses them, and a second readFileSync(0) on a drained pipe would see an empty prompt. */
let stdinPrompt: string | null = null;

/** Read a `--file` value: `-` reads stdin (memoized in stdinPrompt, with the stdin read error
 * and emptiness check beside the read), any other path goes through readPromptFileChecked.
 * Shared by `prompt --file` and the `bug`/`plan` file forms. */
export function readPromptFileArg(file: string): string {
  if (file !== "-") return readPromptFileChecked(file);
  if (stdinPrompt === null) {
    try {
      stdinPrompt = fs.readFileSync(0, "utf8");
    } catch (err) {
      stdinPrompt = "";
      fail(`cannot read prompt file "-" (stdin): ${errorMessage(err)}`);
    }
  }
  failEmptyPromptFile(file, stdinPrompt);
  return stdinPrompt;
}
