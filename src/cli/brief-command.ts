import fs from "node:fs";
import path from "node:path";
import { INITIAL_PROMPT_MAX_CHARS, PROMPT_END, PROMPT_START, briefPath, readBrief, replaceInitialPrompt } from "../brief.js";
import { commitOperatorBacklogEdit } from "../backlog/backlog-commit.js";
import { withStateLock } from "../concurrency/lock.js";
import { writeTextAtomic } from "../files/files.js";
import { stampedSubject } from "../git/commit-message.js";
import { primaryWorktreeLockPath } from "../paths.js";
import { PREFILL_REASON } from "../text/phrases.js";
import { tooLongMessage } from "../text/text.js";
import { readPromptFileArg } from "./cli-command-args.js";
import { JSON_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { fail, say, sayJson } from "./cli-output.js";
import { requireReadyRepo } from "./cli-repo-gate.js";

/** `brief`'s `--file <path>` flag: the replacement prompt (`-` for stdin). */
const FILE_SPEC = { names: ["--file"], value: true, valueName: "<path>" };

/** `tumwater brief`: show the initial prompt and the file holding it, or with `--file <path>`
 * replace it under the checks init applies and commit that one file on main. */
export async function cmdBrief(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("brief", args, [JSON_FLAG, FILE_SPEC]);
  await requireReadyRepo(root);
  const json = args.includes("--json");
  const fileIdx = args.indexOf("--file");
  const brief = readBrief(root);
  if (brief === null) fail("no project brief with a prompt block found — run `tumwater init` first");
  if (fileIdx < 0) {
    if (json) sayJson({ file: brief.file, prompt: brief.prompt });
    else say(`${brief.file}\n${brief.prompt}`);
    return;
  }
  const prompt = readPromptFileArg(args[fileIdx + 1]!).trim();
  if (prompt === "") fail("the new initial prompt is empty");
  if (prompt.length > INITIAL_PROMPT_MAX_CHARS)
    fail(tooLongMessage("the new initial prompt", prompt.length, INITIAL_PROMPT_MAX_CHARS, PREFILL_REASON));
  if (prompt.includes(PROMPT_START) || prompt.includes(PROMPT_END))
    fail("the new initial prompt contains a tumwater:prompt marker, which would break the block for every reader");
  const file = briefPath(root) ?? fail("no project brief with a prompt block found — run `tumwater init` first");
  const changed = withStateLock(primaryWorktreeLockPath(root), () => {
    const current = fs.readFileSync(file, "utf8");
    const next = replaceInitialPrompt(current, prompt);
    if (next === null) fail(`${path.basename(file)} no longer carries a prompt block`);
    if (next === current) return false;
    writeTextAtomic(file, next);
    return true;
  });
  const name = path.basename(file);
  const committed =
    changed && (await commitOperatorBacklogEdit(root, name, stampedSubject("operator", "Edit initial prompt")));
  if (json) sayJson({ file: name, changed, committed });
  else if (!changed) say("initial prompt unchanged");
  else say(`initial prompt updated in ${name}${committed ? " (committed to main)" : ""}`);
}
