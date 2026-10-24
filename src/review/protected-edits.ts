import path from "node:path";
import { promptBlockOf } from "../brief/brief.js";
import { readTextOrNull } from "../files/files.js";
import { changeBaseRev, fileContentAt } from "../git/git.js";
import { briefCandidates } from "../paths.js";
import { baseRoleOf } from "../roles/runner-ids.js";

/** The brief files that may carry the brief text block: the basenames of `briefCandidates`. */
const BRIEF_FILES = briefCandidates("").map((p) => path.basename(p));
/** The roles that may edit PRINCIPLES.md. */
const PRINCIPLES_ROLES = new Set(["director", "steward"]);

/** The deterministic gate/stage finding for a change that edits the brief text block of a brief
 * file (changed, removed, or the file deleted — a block that only moves passes); the role-
 * independent half of protectedEditReason, split out so the main watch still runs it when it
 * cannot name the tip's merging role (an unknown role is no basis for calling a PRINCIPLES.md
 * edit unauthorized, but the brief block forbids its edit for every role alike): a brief edit
 * could otherwise land on main un-watched ("Every commit is verified on main, part 1/3").
 * undefined when no brief-file change touches the block. Reads the worktree and the change's
 * baseRev (a commit or branch) like backlogStructureReason; a missing file reads as empty and
 * never throws. */
export async function briefEditReason(
  wt: string,
  baseRev: string,
  files: string[],
): Promise<string | undefined> {
  const briefs = BRIEF_FILES.filter((f) => files.includes(f));
  if (briefs.length > 0) {
    for (const file of briefs) {
      const base = promptBlockOf(await fileContentAt(wt, baseRev, file));
      if (base === null) continue;
      const head = promptBlockOf(readTextOrNull(path.join(wt, file)) ?? "");
      if (head !== base)
        return `${file} changes the brief between the tumwater:prompt markers — only you edit it (tumwater brief); restore the block`;
    }
  }
  return undefined;
}

/** The deterministic gate/stage finding for a change that edits what the role prompts forbid
 * editing: the brief text block of a brief file (changed, removed, or the file deleted —
 * a block that only moves passes), or PRINCIPLES.md from a role other than director or
 * steward. undefined when neither happened. Reads the worktree and the change's merge-base
 * like backlogStructureReason; a missing file reads as empty and never throws. */
export async function protectedEditReason(
  wt: string,
  mainBranch: string,
  files: string[],
  role: string,
): Promise<string | undefined> {
  const baseRev = await changeBaseRev(wt, mainBranch);
  const brief = await briefEditReason(wt, baseRev, files);
  if (brief !== undefined) return brief;
  if (files.includes("PRINCIPLES.md") && !PRINCIPLES_ROLES.has(baseRoleOf(role)))
    return `PRINCIPLES.md is edited by the ${role} role — only the director and steward roles may edit it; record an objection in PLANS.md instead and revert the edit`;
  return undefined;
}
