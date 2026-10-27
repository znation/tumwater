import path from "node:path";
import { readRegularTextOrNull } from "../files/files.js";
import { PRINCIPLES_MAX_CHARS } from "../prompt/principles.js";
import { okOutcome, warnOutcome, type CheckOutcome } from "./outcome.js";

/** Doctor check for PRINCIPLES.md's injection cap. readPrinciples caps the trimmed text at
 * PRINCIPLES_MAX_CHARS for every prompt's <principles> block, and principleBullets keeps only
 * its leading bullets; a file over the cap loses its tail (and a long header eats bullet
 * budget) with nothing telling the operator who edits it. This check warns when the file would
 * truncate, naming the trimmed count, the cap, the marker, and the fix. Read-only, like every
 * doctor check — it never edits PRINCIPLES.md. */
export function checkPrinciples(root: string): CheckOutcome {
  const raw = readRegularTextOrNull(path.join(root, "PRINCIPLES.md"));
  if (raw === null) return okOutcome("no PRINCIPLES.md");
  const length = raw.trim().length;
  if (length <= PRINCIPLES_MAX_CHARS) {
    return okOutcome(
      `PRINCIPLES.md is within the ${PRINCIPLES_MAX_CHARS}-character prompt cap`,
    );
  }
  return warnOutcome(
    "PRINCIPLES.md has " +
      `${length} trimmed characters, over the ${PRINCIPLES_MAX_CHARS}-character ` +
      "prompt cap; every run's <principles> block carries only the head plus " +
      "`…[PRINCIPLES.md truncated at " +
      `${PRINCIPLES_MAX_CHARS} chars]` +
      " and only the leading bullets survive — keep it to its list bullets and " +
      "move long-form rationale into docs/ (not injected)",
  );
}
