import fs from "node:fs";
import { directorRequestPath } from "../paths.js";
import { readTextOrNull } from "../files/files.js";
import { cutSplitsSurrogatePair, errorMessage } from "../text/text.js";
import { DIRECTOR_PROMPT_MAX_CHARS, submitRolePrompt } from "./inbox-submit.js";
import { DIRECTOR_ROLE } from "../roles/roles.js";

/** The fixed framing around a bugfix role's cannot-reproduce handoff: the preamble names
 * why a director prompt is queued, the ask gives the director its two outcomes — explain or
 * reproduce (a Progress note, entry stays open) versus park it for the user with a
 * `by director` needs-review note that only the user clears. */
const DIRECTOR_REQUEST_PREAMBLE =
  "The bugfix role could not reproduce this bug and asks you to review it before it is parked for the user:";
const DIRECTOR_REQUEST_ASK =
  "Investigate it against the code. If you can explain or reproduce it, add a Progress note under the entry in BUGS.md and leave the entry open. If you cannot resolve it, append `**Needs review <YYYY-MM-DD> by director: <what the user must decide>**` as its own line under the entry's heading and leave the rest of the entry intact.";

/** The fixed framing overhead: the preamble and ask plus the four newlines between the three
 * parts (104 + 329 + 4 = 437). The body must fit in DIRECTOR_PROMPT_MAX_CHARS minus this so the
 * composed prompt always rides under the cap and is queued — never rejected and dropped (the
 * over-cap drop that latched a handoff entry, BUGS.md 2026-11-01). */
const FRAMING_OVERHEAD = DIRECTOR_REQUEST_PREAMBLE.length + DIRECTOR_REQUEST_ASK.length + 4;

/** The visible marker appended when a body is truncated to fit the cap, so the director sees
 * that the body was capped rather than the loss being silent (truncateWithNote's rule, applied
 * to a hard cap the composed prompt must not exceed). */
const OVER_CAP_NOTE = "\n…[body over the prompt cap; truncated]";

/** The queue seam applyDirectorRequest enqueues through: submitRolePrompt by default (which
 * validates the length cap and logs the `prompt_enqueued` event under director). Injectable
 * only so the throw path is testable without a broken inbox. */
type QueueFn = typeof submitRolePrompt;

/** Bring a request body under the cap so the composed prompt always fits: unchanged when it
 * fits, otherwise cut to leave room for OVER_CAP_NOTE, so the composed text never exceeds
 * DIRECTOR_PROMPT_MAX_CHARS. The cut that would split a surrogate pair backs off one unit, so
 * the kept prefix never ends on a lone high surrogate (truncate's rule). */
function fitBody(body: string): string {
  const budget = DIRECTOR_PROMPT_MAX_CHARS - FRAMING_OVERHEAD - OVER_CAP_NOTE.length;
  if (body.length <= budget) return body;
  let cut = budget;
  if (cutSplitsSurrogatePair(body, cut)) cut -= 1; // Never emit a lone high surrogate.
  return `${body.slice(0, cut).trimEnd()}${OVER_CAP_NOTE}`;
}

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
 * error (nothing to review). A body too long to ride the fixed framing under the prompt cap
 * is truncated to fit (with a visible note) before composing, so the composed prompt always
 * fits and the request is always queued — never rejected, so the director is always told and
 * the handoff entry never latches behind a prompt that was never sent. The file is deleted
 * on every path (INV-B8).
 *
 * @param root the repo root the prompt queue and event log live under
 * @param wt the requesting role's worktree, where the request file sits at its root
 * @param queue the queue seam (submitRolePrompt by default)
 * @returns `{ queued: true }` when a director prompt was enqueued (an over-cap body is
 *   truncated to fit first), `{ error }` when the body was empty or the queue threw, or
 *   null when no request file existed.
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
    const fitted = fitBody(body); // An over-cap body is truncated to fit, never dropped.
    try {
      queue(root, DIRECTOR_ROLE, `${DIRECTOR_REQUEST_PREAMBLE}\n\n${fitted}\n\n${DIRECTOR_REQUEST_ASK}`);
    } catch (err) {
      error = errorMessage(err);
    }
  }
  error = discardDirectorRequest(requestFile, error);
  return error === undefined ? { queued: true } : { error };
}
