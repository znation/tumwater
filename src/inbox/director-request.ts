import fs from "node:fs";
import { directorRequestPath } from "../paths.js";
import { readTextOrNull } from "../files/files.js";
import { errorMessage } from "../text/text.js";
import { submitRolePrompt } from "./inbox-submit.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";

/** The fixed framing around a bugfix role's cannot-reproduce handoff: the preamble names
 * why a director prompt is queued, the ask gives the director its two outcomes — explain or
 * reproduce (a Progress note, entry stays open) versus park it for the user with a
 * `by director` needs-review note that only the user clears. */
const DIRECTOR_REQUEST_PREAMBLE =
  "The bugfix role could not reproduce this bug and asks you to review it before it is parked for the user:";
const DIRECTOR_REQUEST_ASK =
  "Investigate it against the code. If you can explain or reproduce it, add a Progress note under the entry in BUGS.md and leave the entry open. If you cannot resolve it, append `**Needs review <YYYY-MM-DD> by director: <what the user must decide>**` as its own line under the entry's heading and leave the rest of the entry intact.";

/** The queue seam applyDirectorRequest enqueues through: submitRolePrompt by default (which
 * validates the length cap and logs the `prompt_enqueued` event under director). Injectable
 * only so the throw path is testable without a broken inbox. */
type QueueFn = typeof submitRolePrompt;

/** Delete the request on EVERY path — success, empty body, over-cap, enqueue throw — so it
 * can never be staged by commitAll, reach a review gate, or retry forever (the same
 * best-effort unlink the director's config request uses, config-request.ts's
 * discardConfigRequest): a failed unlink is surfaced as an error so the caller logs it, and
 * a passed-in error outranks the failed-deletion message. Returns the error to surface. */
function discardDirectorRequest(requestFile: string, error: string | undefined): string | undefined {
  try {
    fs.unlinkSync(requestFile);
  } catch (err) {
    return error ?? `director request file could not be deleted: ${errorMessage(err)}`;
  }
  return error;
}

/** Consume a bugfix role's director-review request file (`.tumwater-director-request.md`
 * at its worktree root). The bugfix role writes it when it cannot reproduce an open bug
 * (role-catalog.ts's bugfix find), and the harness calls this before every staging path
 * (run-verdict.ts's bugfix block), so the file is queued as one director prompt and deleted
 * before it can enter a diff.
 *
 * Returns null when no request file exists — the common case for every non-bugfix run and a
 * bugfix run that reproduced. A non-empty body is composed into the queued text from the
 * fixed preamble, the body, and the fixed ask; an empty or whitespace-only body is an
 * error (nothing to review). The composed text rides submitRolePrompt's normal validation,
 * so an over-cap body is rejected there and the file is still deleted. The file is deleted
 * on every path (INV-B8).
 *
 * @param root the repo root the prompt queue and event log live under
 * @param wt the requesting role's worktree, where the request file sits at its root
 * @param queue the queue seam (submitRolePrompt by default)
 * @returns `{ queued: true }` when a director prompt was enqueued, `{ error }` when the
 *   body was empty or the queue rejected/threw, or null when no request file existed.
 */
export function applyDirectorRequest(
  root: string,
  wt: string,
  queue: QueueFn = submitRolePrompt,
): { queued: true } | { error: string } | null {
  const requestFile = directorRequestPath(wt);
  const raw = readTextOrNull(requestFile);
  if (raw === null) return null; // no request this run

  const body = raw.trim();
  let error: string | undefined;
  if (body === "") {
    error = "director request body is empty";
  } else {
    try {
      queue(root, DIRECTOR_ROLE, `${DIRECTOR_REQUEST_PREAMBLE}\n\n${body}\n\n${DIRECTOR_REQUEST_ASK}`);
    } catch (err) {
      error = errorMessage(err);
    }
  }
  error = discardDirectorRequest(requestFile, error);
  return error === undefined ? { queued: true } : { error };
}
