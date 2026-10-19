// vocabulary: plain
import path from "node:path";
import { promptBlockOf } from "../brief/brief.js";
import { readTextOrNull } from "../files/files.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { briefCandidates } from "../paths.js";
import { baseRoleOf } from "../roles/runner-ids.js";

/** The brief files that may carry the initial prompt block: the basenames of `briefCandidates`. */
const BRIEF_FILES = briefCandidates("").map((p) => path.basename(p));
/** The roles that may edit PRINCIPLES.md. */
const PRINCIPLES_ROLES = new Set(["director", "steward"]);

/** The deterministic gate/stage finding for a change that edits what the loop prompts forbid
 * editing: the initial prompt block of a brief file (changed, removed, or the file deleted —
 * a block that only moves passes), or PRINCIPLES.md from a role other than director or
 * steward. undefined when neither happened. Reads the worktree and the change's merge-base
 * like backlogStructureReason; a missing file reads as empty and never throws. */
export async function protectedEditReason(
  wt: string,
  mainBranch: string,
  files: string[],
  role: string,
): Promise<string | undefined> {
  const briefs = BRIEF_FILES.filter((f) => files.includes(f));
  if (briefs.length > 0) {
    const baseRev = await changeBaseRev(wt, mainBranch);
    for (const file of briefs) {
      const base = promptBlockOf(await fileContentAt(wt, baseRev, file));
      if (base === null) continue;
      const head = promptBlockOf(readTextOrNull(path.join(wt, file)) ?? "");
      if (head !== base)
        return `${file} changes the brief between the tumwater:prompt markers — only you edit it (tumwater brief); restore the block`;
    }
  }
  if (files.includes("PRINCIPLES.md") && !PRINCIPLES_ROLES.has(baseRoleOf(role)))
    return `PRINCIPLES.md is edited by the ${role} role — only the director and steward roles may edit it; record an objection in PLANS.md instead and revert the edit`;
  return undefined;
}
