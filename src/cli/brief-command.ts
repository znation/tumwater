// vocabulary: plain
import path from "node:path";
import { readBrief, renderBrief } from "../brief/brief.js";
import { editInitialPrompt } from "../brief/brief-edit.js";
import { editInEditor } from "./cli-editor.js";
import { readPromptFileArg } from "./cli-command-args.js";
import { JSON_FLAG, rejectUnknownArgs } from "./cli-flag-specs.js";
import { fail, say, sayJson } from "./cli-output.js";
import { requireReadyRepo } from "./cli-repo-gate.js";

/** `brief`'s `--file <path>` flag: the replacement prompt (`-` for stdin). */
const FILE_SPEC = { names: ["--file"], value: true, valueName: "<path>" };

/** `brief`'s `--edit` flag: open the prompt in `$VISUAL`/`$EDITOR`. */
const EDIT_SPEC = { names: ["--edit"] };

/** `tumwater brief`: show the initial prompt and the file holding it, or with `--file <path>` to
 * replace it (or with `--edit`, open it in the editor) under the checks init applies and commit
 * that one file on main. */
export async function cmdBrief(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("brief", args, [JSON_FLAG, FILE_SPEC, EDIT_SPEC]);
  await requireReadyRepo(root);
  const json = args.includes("--json");
  const fileIdx = args.indexOf("--file");
  const edit = args.includes("--edit");
  if (edit && fileIdx >= 0) fail("pass --edit or --file, not both");
  const brief = readBrief(root);
  if (brief === null) fail("no project brief with a prompt block found — run `tumwater init` first");
  if (fileIdx < 0 && !edit) {
    if (json) sayJson({ file: brief.file, prompt: brief.prompt });
    else say(renderBrief(brief));
    return;
  }
  let text: string;
  if (edit) {
    text = editInEditor(brief.prompt, "brief.md", "pass --file <path>");
    if (text.trim() === brief.prompt.trim()) {
      if (json) sayJson({ file: path.basename(brief.file), changed: false, committed: false });
      else say("brief unchanged");
      return;
    }
  } else text = readPromptFileArg(args[fileIdx + 1]!);
  const outcome = await editInitialPrompt(root, text);
  if (!outcome.ok) fail(outcome.error);
  const { file: name, changed, committed } = outcome;
  if (json) sayJson({ file: name, changed, committed });
  else if (!changed) say("brief unchanged");
  else say(`brief updated in ${name}${committed ? " (committed to main)" : ""}`);
}
