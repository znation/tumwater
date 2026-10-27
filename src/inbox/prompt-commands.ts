/** The CLI layer of `tumwater prompt` — the steering-prompt command: submit a prompt to the
 * director (default) or one role's queue, `--list` what is queued with per-role position
 * numbering, or `--cancel <n>` a queued prompt by position. Split out of
 * operator/operator-commands.ts because this command is not a team-control marker: its
 * sibling commands there ride the operator-intent marker protocol, while this command drives
 * the durable per-role queues (src/inbox/inbox.ts) through the inbox-cancel, inbox-edit, and
 * operator-intent helpers, each with its own broken-config policy — so the command lives
 * beside the queue module it drives. The team-side half — the dequeue and requeue a role
 * performs — is inbox.ts and pending-prompt.ts. */
import { fail, say, sayJson } from "../cli/cli-output.js";
import path from "node:path";
import { parsePromptArgs } from "../cli/cli-command-args.js";
import {
  type CancelOutcome,
  type ListedCancelOutcome,
  type ListedQueueMiss,
  cancelListedPrompt,
  cancelRolePrompt,
  resolveListedQueue,
} from "./inbox-cancel.js";
import {
  type EditOutcome,
  type ListedEditOutcome,
  editListedPrompt,
  editQueuedFile,
  editRolePrompt,
  readQueuedPromptBody,
} from "./inbox-edit.js";
import { movePromptToTop, type TopOutcome } from "./inbox-top.js";
import { editInEditor } from "../cli/cli-editor.js";
import { listWideScope, queuedFileAtPosition, promptPreview, queuedListRows, queuedRowsMatching, renderQueuedList } from "./inbox.js";
import { durationLabel, parseRoleListFlag } from "../cli/cli-args.js";
import { knownRoleIds, knownRoleIdsCached, loadConfig } from "../config/config.js";
import { errorMessage } from "../text/text.js";
import { plural } from "../text/phrases.js";
import { readPromptImageFiles, type PromptImageInput } from "./inbox-attachments.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "../roles/roles.js";
import { submitRolePromptAndWake } from "../operator/operator-intent.js";
import { imagePromptGuidance } from "./inbox-submit.js";
import { roleLabel } from "../roles/role-labels.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";

/** Fail with the ambiguity or miss message of a list-wide position resolution, else return
 * the resolved value narrowed. Shared by sayListedOutcome and the editor form so the wordings
 * cannot drift. */
function failQueueMiss<T extends { status: string }>(listed: T | ListedQueueMiss, position: number): T {
  if (isQueueMiss(listed)) {
    if (listed.status === "ambiguous") {
      fail(`position ${position} is in more than one role's inbox (${listed.roles.join(", ")}) — name one with --role <id>`);
    }
    // `queued` is the longest queue's length — the highest position any role's numbering can
    // reach — so a miss names it as the valid range when at least one role holds a prompt.
    const range = listed.queued > 0 ? ` — valid: 1-${listed.queued}` : "";
    fail(`no prompt at position ${position} (longest inbox holds ${listed.queued})${range}`);
  }
  return listed;
}

/** Resolve a list-wide position to the single role holding it, failing on ambiguity or miss.
 * The no-`--role` resolution the cancel/edit/top branches each make, shared so the three
 * verbs cannot drift from one another or from sayListedOutcome's wordings. */
function resolveListedRole(root: string, position: number): string {
  return failQueueMiss(resolveListedQueue(root, listWideScope(root), position), position).role;
}

/** Whether a list-wide outcome is one of the two miss shapes — the guard that narrows the
 * miss fields (`roles`, `queued`) without a cast. */
function isQueueMiss(listed: { status: string }): listed is ListedQueueMiss {
  return listed.status === "ambiguous" || listed.status === "missing";
}

/** The shared tail of the list-wide cancel/edit branches: report an ambiguity (naming the
 * rival roles, with the `--role` escape hatch) or a miss (carrying the length of the longest
 * queue, the highest position numbering any role can hold), else render the resolved outcome
 * through sayPromptOutcome. One helper so the
 * two verbs' handling of the miss shapes cannot drift. */
function sayListedOutcome(listed: ListedCancelOutcome | ListedEditOutcome, position: number): void {
  const found = failQueueMiss(listed, position);
  sayPromptOutcome(position, found.role, found.outcome, true);
}

/** Run one role-targeted queue verb (cancelRolePrompt/editRolePrompt) for a `--role`-scoped
 * command: a thrown failure (a broken config, an unwritable queue) exits through fail with
 * its message, a success returns the verb's outcome for the caller to render. One helper so
 * the cancel and edit branches' broken-config policy cannot drift. */
function runRolePromptCommand<O extends CancelOutcome | EditOutcome>(
  root: string,
  role: string,
  position: number,
  verb: (root: string, role: string, position: number) => O,
): O {
  try {
    return verb(root, role, position);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

/** The user-facing reply for one resolved cancel or edit — the four branches of cmdPrompt's
 * cancel and edit modes (list-wide and `--role`-scoped each): a concurrent dequeue is a normal
 * race, not an error, so it is reported and exited clean; a resolved one previews the text it
 * removed (a cancel's `text`) or wrote (an edit's `newText`). When `labelRole` the line names
 * the role — the no-`--role` command resolves across every role, so its output must say where
 * the prompt went — while a `--role`-scoped command already names it in the user's own
 * command. One helper so the cancel and edit wordings cannot drift. */
function sayPromptOutcome(position: number, role: string, outcome: CancelOutcome | EditOutcome, labelRole: boolean): void {
  if (outcome.status === "gone") {
    sayPromptGone(position, role);
    return;
  }
  // A resolved cancel carries the removed text; a resolved edit carries what it wrote.
  const text = outcome.status === "cancelled" ? outcome.text : outcome.newText;
  say(labelRole ? `${outcome.status} (${role}): ${promptPreview(text)}` : `${outcome.status}: ${promptPreview(text)}`);
}

/** The gone-case tail shared by every resolved queue-verb reply: a concurrent dequeue is a
 * normal race, not an error, so report it and exit clean, naming the role that took the
 * prompt. One helper so the cancel, edit and top verbs' gone wording cannot drift. */
function sayPromptGone(position: number, role: string): void {
  say(`prompt ${position} is no longer in the inbox — ${roleLabel(role)} already took it`);
}

/** The user-facing reply for one resolved top — the two branches of cmdPrompt's top mode
 * (list-wide and `--role`-scoped): a concurrent dequeue is a normal race, not an error, so it
 * is reported and exited clean; a resolved one previews the moved prompt. When `labelRole` the
 * line names the role — the no-`--role` command resolves across every role, so its output must
 * say where the prompt moved — while a `--role`-scoped command already names it in the user's
 * own command. The `sayPromptOutcome` contract, so the verbs cannot drift. */
function sayTopOutcome(position: number, role: string, outcome: TopOutcome, labelRole: boolean): void {
  if (outcome.status === "gone") {
    sayPromptGone(position, role);
    return;
  }
  say(labelRole ? `topped (${role}): ${outcome.preview}` : `topped: ${outcome.preview}`);
}

/** Read and validate an `--attach <path>` list into the GUI's image input shape, through the
 * shared throwing core both surfaces use (readPromptImageFiles in inbox-attachments.ts), with
 * each failure exiting through `fail` with the same messages the enqueue branch always
 * raised — so the enqueue and `--edit` forms share one definition and cannot drift from the
 * TUI's prompt-line attach. */
function readPromptImages(paths: readonly string[]): PromptImageInput[] {
  try {
    return readPromptImageFiles(paths);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

/** `--list` mode — the inspection verb: filter the list-wide rows by `--role a,b` and `--grep`,
 * then print the prose list, the `--json` document, or one of the empty/no-match lines. One
 * helper so `--list`'s rules are found by name. */
function runPromptList(root: string, args: string[], json: boolean, grep: string | null, validIds: string[] | null): void {
  // One payload, two shapes: the prose render and the --json output both come from the
  // same array, so the per-role positions --cancel consumes can never disagree with the
  // data a script reads. Full text, verbatim: this is the inspection command that tells
  // you what a queued prompt actually says before you cancel it.
  // `--role a,b` filters the list-wide rows, so section order and each section's own
  // numbering stay what `--cancel <n> --role <id>` takes.
  const listRoles = parseRoleListFlag(args, validIds as string[]);
  const allRows = queuedListRows(root, null, validIds as string[]);
  const scoped = listRoles === null ? allRows : allRows.filter((row) => listRoles.includes(row.role));
  const prompts = queuedRowsMatching(scoped, grep ?? null);
  if (json) {
    // An empty queue still prints the document, the history --json empty-rows precedent.
    sayJson({ prompts });
    return;
  }
  if (prompts.length === 0 && scoped.length > 0) {
    say(`no queued prompt matches "${grep}"`);
    return;
  }
  if (prompts.length === 0) {
    say(listRoles === null
      ? "every inbox is empty"
      : listRoles.length === 1
        ? `${roleLabel(listRoles[0]!)}'s inbox is empty`
        : `every listed inbox is empty (${listRoles.join(", ")})`);
    return;
  }
  say(renderQueuedList(prompts, Date.now()));
}

/** `--cancel <n>` mode — remove a queued prompt by position, list-wide or `--role`-scoped. One
 * helper so `--cancel`'s rules are found by name. */
function runPromptCancel(root: string, position: number, role: string | null): void {
  if (role === null) {
    // No --role: the position addresses what --list shows — its per-role sections, each
    // numbered from 1 (the director first, then the roles in catalog order). Resolve across
    // that scope: one role holding the position cancels there, several are ambiguous (the
    // list itself shows two "N." lines), none is a miss. The output names the role, since
    // the caller scoped nothing.
    sayListedOutcome(cancelListedPrompt(root, listWideScope(root), position), position);
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  sayPromptOutcome(position, target, runRolePromptCommand(root, target, position, cancelRolePrompt), false);
}

/** Run the CLI's image-input gate for one `prompt` surface. Shared by the submit and
 * --edit forms so the refusal promise holds across every CLI attach surface: an image no
 * configured model can read is refused (fail) before a byte is written — the peer-tier
 * reroute was subtracted, so there is no notice to say. */
function runPromptImageGate(root: string, target: string): void {
  const guidance = imagePromptGuidance(root, target);
  if (guidance.refusal) fail(guidance.refusal);
}

/** `--edit <n>` mode — replace a queued prompt's body by position: the attachment gate, then
 * the editor for a bare position or the typed/`--file` text, list-wide or `--role`-scoped. One
 * helper so `--edit`'s rules are found by name. */
function runPromptEdit(root: string, position: number, text: string | null, attachPaths: string[], role: string | null): void {
  // The same broken-config policy and list-wide resolution as cancel, one verb over: the
  // file's new content rides the same queue file (position, enqueue stamp, and a pending
  // --at deferral untouched), and a concurrent dequeue reports gone and exits clean. An
  // `--attach` list is read through the same helper the enqueue form uses and appended to
  // the prompt's images in place.
  const images = attachPaths.length > 0 ? readPromptImages(attachPaths) : undefined;
  // Image-input gate, `--edit`'s twin of the submit branch below (plans/image-input.md
  // "Attachments", part 5/5): editing an attachment into a queued prompt is the same
  // run-time discovery the submit gate prevents, so the refusal promise holds across every
  // CLI attach surface — an image no configured model can read is refused before a byte is
  // written, and a role that reroutes a blind read is told where the prompt will run. The
  // target role is resolved first (the same resolution the verb below makes) so the gate can
  // name it.
  if (images !== undefined && images.length > 0) {
    const targetRole = role ?? resolveListedRole(root, position);
    runPromptImageGate(root, targetRole);
  }
  const typed = text;
  if (typed === null) {
    // Bare `--edit <n>`: open the prompt's body in the editor. The role is resolved first
    // and the write goes by file name, so a dequeue while the editor is open reports gone
    // instead of editing the neighbour that shifted into the position.
    const targetRole = role ?? resolveListedRole(root, position);
    let name: string;
    let body: string | null;
    try {
      name = path.basename(queuedFileAtPosition(root, targetRole, position));
      body = readQueuedPromptBody(root, targetRole, name);
    } catch (err) {
      return fail(errorMessage(err));
    }
    if (body === null) {
      sayPromptOutcome(position, targetRole, { status: "gone" }, role === null);
      return;
    }
    const after = editInEditor(body, "prompt.md");
    // An emptied buffer is an abort, not a blank prompt: the queue would otherwise hold a
    // prompt with no text, which the enqueue forms refuse.
    if (after.trim() === "" && body.trim() !== "") fail("the edited prompt is empty; nothing changed (use --cancel <n> to drop it)");
    if (after.trim() === body.trim() && images === undefined) {
      say(`prompt ${position} unchanged`);
      return;
    }
    try {
      sayPromptOutcome(position, targetRole, editQueuedFile(root, targetRole, name, after, images), role === null);
    } catch (err) {
      fail(errorMessage(err));
    }
    return;
  }
  if (role === null) {
    sayListedOutcome(editListedPrompt(root, listWideScope(root), position, typed, images), position);
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  sayPromptOutcome(
    position,
    target,
    runRolePromptCommand(root, target, position, (r, role, position) => editRolePrompt(r, role, position, typed, images)),
    false,
  );
}

/** `--top <n>` mode — move a queued prompt to the head of its queue by position, list-wide or
 * `--role`-scoped. One helper so `--top`'s rules are found by name. */
function runPromptTop(root: string, position: number, role: string | null): void {
  // The same list-wide resolution the cancel branch uses, one verb on: no --role resolves the
  // position across `--list`'s per-role sections and moves it in the resolved role's queue;
  // with --role it is the role-scoped call. A concurrent dequeue reports gone and exits
  // clean; position 1 of the resolved role is "already first".
  if (role === null) {
    const targetRole = resolveListedRole(root, position);
    let outcome: TopOutcome;
    try {
      outcome = movePromptToTop(root, targetRole, position);
    } catch (err) {
      return fail(errorMessage(err));
    }
    sayTopOutcome(position, targetRole, outcome, true);
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  let outcome: TopOutcome;
  try {
    outcome = movePromptToTop(root, target, position);
  } catch (err) {
    return fail(errorMessage(err));
  }
  sayTopOutcome(position, target, outcome, false);
}

/** The default (enqueue) mode — the steering-prompt submit form: the `--at` due time, the
 * `--attach` read and image-input gate, then submitRolePromptAndWake and the confirmation.
 * One helper so the submit form's rules are found by name. */
function runPromptSubmit(root: string, text: string, atDelayMs: number | null, attachPaths: string[], role: string | null): void {
  const target = role ?? DIRECTOR_ROLE;
  // `--at <duration>` is a delay, not an epoch: the marker's not-before time is now + the
  // parsed duration, computed at submit so the deferral starts when the operator queued it.
  const dueMs = atDelayMs !== null ? Date.now() + atDelayMs : undefined;
  // `--attach <path>`: read and validate through the shared helper (a bad path fails by name
  // before anything is queued). An attachment the target role cannot read is refused here by
  // name — the same gate submitRolePrompt enforces, surfaced early so the CLI exits non-zero
  // with the fix before anything is written or queued; a role that reroutes a blind read is
  // not refused, but the operator is told where the prompt will actually run.
  const images = attachPaths.length > 0 ? readPromptImages(attachPaths) : undefined;
  if (images && images.length > 0) {
    runPromptImageGate(root, target);
  }
  const wake = submitRolePromptAndWake(root, target, text, images, dueMs);
  const attached = images !== undefined ? ` with ${plural(images.length, "image")}` : "";
  const owner = target === DIRECTOR_ROLE ? "the director's" : `${roleLabel(target)}'s`;
  if (atDelayMs !== null) {
    // A deferred prompt's confirmation names the delivery delay, in the same duration
    // vocabulary --at parsed (durationLabel), so the user can re-type it.
    say(`added to ${owner} inbox — delivers in ${durationLabel(atDelayMs)}${attached}`);
  } else {
    say(`added to ${owner} inbox${attached}`);
  }
  say(wake);
}

/** `tumwater prompt [--role <id>] <text|list|cancel <n>|top <n>>`: submit a steering prompt to the
 * director (default) or one role's queue (`--list` takes `--role <id>[,<id>...]`), list what
 * is queued with per-role position numbering, cancel a queued prompt by position, or move
 * one to the head of its queue. The dispatcher in cli.ts gates on a ready repo and
 * delegates here; list output is grouped by role — the director first (its queue is
 * the shared one every pre-1/2 prompt landed in), then each role with queued prompts — so a
 * per-role queue's position numbering stays unambiguous. */
export async function cmdPrompt(root: string, args: string[]): Promise<void> {
  const parsed = parsePromptArgs(args);
  // --list takes a comma list (parseRoleListFlag below); every other mode keeps one id.
  if (parsed.role !== null && parsed.mode !== "list") parsed.role = canonicalRoleId(parsed.role);
  // `--role <id>` scopes every mode to one role's queue; the value is validated here, with
  // the same message every other --role consumer uses. The director is always valid: its
  // queue is the historical inbox (inbox.ts).
  //
  // Where the id set comes from differs by mode, following parseRoleScope's split: --list is
  // a read-only view, so a transiently broken tumwater.json must not take it down — it falls
  // back to the built-in catalog (knownRoleIdsCached), exactly like cmdLogs/cmdHistory's
  // --role scope, at the cost of a broken config hiding a custom role's queued section. The
  // state-changing modes (enqueue, cancel) instead read through loadConfig and fail loudly
  // when an id was given: before writing to a named role's queue the operator is owed the
  // config error, not a built-ins-only guess about whether the role exists. With no --role,
  // enqueue touches only the director queue (inbox.ts) and never reads the config — a broken
  // tumwater.json must not block steering the director — while cancel resolves its position
  // across the per-role sections --list prints, through the same cached, never-throwing id set
  // --list uses, so it cancels exactly what the list showed even under a broken config.
  const validIds = parsed.mode === "list"
    ? knownRoleIdsCached(root)
    : parsed.role !== null
      ? knownRoleIds(loadConfig(root))
      : null;
  if (parsed.mode !== "list" && validIds !== null && parsed.role !== null && !validIds.includes(parsed.role)) {
    fail(unknownRoleMessage(parsed.role, validIds));
  }
  const role = parsed.role;
  if (parsed.mode === "list") {
    runPromptList(root, args, parsed.json, parsed.grep, validIds);
    return;
  }
  if (parsed.mode === "cancel") {
    runPromptCancel(root, parsed.position, role);
    return;
  }
  if (parsed.mode === "edit") {
    runPromptEdit(root, parsed.position, parsed.text, parsed.attachPaths, role);
    return;
  }
  if (parsed.mode === "top") {
    runPromptTop(root, parsed.position, role);
    return;
  }
  runPromptSubmit(root, parsed.text, parsed.atDelayMs, parsed.attachPaths, role);
}
