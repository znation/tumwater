import { readBrief } from "../brief.js";
import { editInitialPrompt } from "../brief-edit.js";
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
  const outcome = await editInitialPrompt(root, readPromptFileArg(args[fileIdx + 1]!));
  if (!outcome.ok) fail(outcome.error);
  const { file: name, changed, committed } = outcome;
  if (json) sayJson({ file: name, changed, committed });
  else if (!changed) say("initial prompt unchanged");
  else say(`initial prompt updated in ${name}${committed ? " (committed to main)" : ""}`);
}
