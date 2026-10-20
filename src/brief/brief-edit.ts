// vocabulary: plain
import fs from "node:fs";
import path from "node:path";
import { INITIAL_PROMPT_MAX_CHARS, PROMPT_END, PROMPT_START, briefPath, replaceInitialPrompt } from "./brief.js";
import { commitOperatorBacklogEdit } from "../backlog/backlog-commit.js";
import { withPrimaryWorktreeLock } from "../concurrency/lock.js";
import { writeTextAtomic } from "../files/files.js";
import { stampedSubject } from "../git/commit-message.js";
import { PREFILL_REASON } from "../text/phrases.js";
import { tooLongMessage } from "../text/text.js";

/** The outcome of replacing the initial prompt: a refusal's message, or the brief file's
 * basename with whether the text changed and whether that change was committed to main. */
type BriefEditOutcome =
  | { ok: false; error: string }
  | { ok: true; file: string; changed: boolean; committed: boolean };

const NO_BRIEF = "no project brief with a prompt block found — run `tumwater init` first";

/** Replace the initial prompt with `text` under the checks init applies (non-empty, at most
 * INITIAL_PROMPT_MAX_CHARS, no prompt marker), write it under the primary-worktree lock, and
 * commit that one file on main. The one writer behind `tumwater brief --file` and the
 * dashboard's Settings card, so the two cannot drift. */
export async function editInitialPrompt(root: string, text: string): Promise<BriefEditOutcome> {
  const prompt = text.trim();
  if (prompt === "") return { ok: false, error: "the new brief is empty" };
  if (prompt.length > INITIAL_PROMPT_MAX_CHARS)
    return { ok: false, error: tooLongMessage("the new brief", prompt.length, INITIAL_PROMPT_MAX_CHARS, PREFILL_REASON) };
  if (prompt.includes(PROMPT_START) || prompt.includes(PROMPT_END))
    return { ok: false, error: "the new brief contains a tumwater:prompt marker, which would break the block for every reader" };
  const file = briefPath(root);
  if (file === null) return { ok: false, error: NO_BRIEF };
  const name = path.basename(file);
  const changed = withPrimaryWorktreeLock(root, (): boolean | string => {
    const current = fs.readFileSync(file, "utf8");
    const next = replaceInitialPrompt(current, prompt);
    if (next === null) return `${name} no longer carries a prompt block`;
    if (next === current) return false;
    writeTextAtomic(file, next);
    return true;
  });
  if (typeof changed === "string") return { ok: false, error: changed };
  const committed = changed && (await commitOperatorBacklogEdit(root, name, stampedSubject("operator", "Edit brief"))); // vocabulary-ok: commit prefix stays
  return { ok: true, file: name, changed, committed };
}
