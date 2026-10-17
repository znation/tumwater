// vocabulary: plain
/** The CLI layer of `tumwater prompt` — the steering-prompt command: submit a prompt to the
 * director (default) or one role's queue, `--list` what is queued with per-loop position
 * numbering, or `--cancel <n>` a queued prompt by position. Split out of
 * operator/operator-commands.ts because this command is not a fleet-control marker: its
 * sibling commands there ride the operator-intent marker protocol, while this command drives
 * the durable per-loop queues (src/inbox/inbox.ts) through the inbox-cancel, inbox-edit, and
 * operator-intent helpers, each with its own broken-config policy — so the command lives
 * beside the queue module it drives. The fleet-side half — the dequeue and requeue a loop
 * performs — is inbox.ts and pending-prompt.ts. */
import { fail, say, sayJson } from "../cli/cli-output.js";
import fs from "node:fs";
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
import { editInEditor } from "../cli/cli-editor.js";
import { listWideScope, queuedFileAtPosition, promptPreview, queuedListRows, renderQueuedList } from "./inbox.js";
import { durationLabel } from "../cli/cli-args.js";
import { knownRoleIds, knownRoleIdsCached, loadConfig } from "../config/config.js";
import { errorMessage } from "../text/text.js";
import {
  promptImageExtensionProblem,
  promptImageSizeProblem,
  promptImagesCountProblem,
  promptImagesProblem,
  type PromptImageInput,
} from "./inbox-attachments.js";
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
    fail(`no prompt at position ${position} (longest inbox holds ${listed.queued})`);
  }
  return listed;
}

/** Whether a list-wide outcome is one of the two miss shapes — the guard that narrows the
 * miss fields (`roles`, `queued`) without a cast. */
function isQueueMiss(listed: { status: string }): listed is ListedQueueMiss {
  return listed.status === "ambiguous" || listed.status === "missing";
}

/** The shared tail of the list-wide cancel/edit branches: report an ambiguity (naming the
 * rival loops, with the `--role` escape hatch) or a miss (carrying the length of the longest
 * queue, the highest position numbering any loop can hold), else render the resolved outcome
 * through sayPromptOutcome. One helper so the
 * two verbs' handling of the miss shapes cannot drift. */
function sayListedOutcome(listed: ListedCancelOutcome | ListedEditOutcome, position: number): void {
  const found = failQueueMiss(listed, position);
  sayPromptOutcome(position, found.role, found.outcome, true);
}

/** Run one loop-targeted queue verb (cancelRolePrompt/editRolePrompt) for a `--role`-scoped
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
 * the loop — the no-`--role` command resolves across every loop, so its output must say where
 * the prompt went — while a `--role`-scoped command already names it in the user's own
 * command. One helper so the cancel and edit wordings cannot drift. */
function sayPromptOutcome(position: number, role: string, outcome: CancelOutcome | EditOutcome, labelRole: boolean): void {
  if (outcome.status === "gone") {
    say(`prompt ${position} is no longer in the inbox — ${roleLabel(role)} already took it`);
    return;
  }
  // A resolved cancel carries the removed text; a resolved edit carries what it wrote.
  const text = outcome.status === "cancelled" ? outcome.text : outcome.newText;
  say(labelRole ? `${outcome.status} (${role}): ${promptPreview(text)}` : `${outcome.status}: ${promptPreview(text)}`);
}

/** Refuse an `--attach` path list from what the paths alone reveal, before any file is read:
 * the shared image-count cap first (so a glob that expanded past it is rejected without
 * reading or base64-encoding dozens of files), then each path's extension, regular-file
 * shape, and on-disk size. The regular-file check is not just a nicer message for a
 * directory named `shot.png` (whose stat size is small enough to pass the cap): it also keeps
 * `readPromptImages` from calling readFileSync on a FIFO or device node that would block the
 * command indefinitely. A path that cannot be statted is left for the read below to report
 * with its own missing-file wording. Returns the first problem, or null when every path
 * survives. */
function attachPathsProblem(paths: readonly string[]): string | null {
  const countProblem = promptImagesCountProblem(paths.length);
  if (countProblem !== null) return countProblem;
  for (const p of paths) {
    const extProblem = promptImageExtensionProblem(p);
    if (extProblem !== null) return extProblem;
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile())
        return `attached image ${JSON.stringify(p)} is not a regular file — pass a path to an image file`;
      const sizeProblem = promptImageSizeProblem(path.basename(p), stat.size);
      if (sizeProblem !== null) return sizeProblem;
    } catch {
      // Missing or unreadable: the read below names it.
    }
  }
  return null;
}

/** Read and validate an `--attach <path>` list into the GUI's image input shape: refuse the
 * cheap path-only rules first (attachPathsProblem above — count, extension, on-disk size),
 * read each surviving file whole, and re-run the endpoint's validation client-side
 * (promptImagesProblem) so the CLI's error names the broken rule with the same wording the
 * dashboard answers 400 with. Fails through `fail` with the same messages the enqueue branch
 * always raised, so the enqueue and `--edit` forms share one definition and cannot drift. */
function readPromptImages(paths: readonly string[]): PromptImageInput[] {
  const pathProblem = attachPathsProblem(paths);
  if (pathProblem !== null) fail(pathProblem);
  const images = paths.map((p): PromptImageInput => {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(p);
    } catch (err) {
      return fail(`cannot read attached image ${JSON.stringify(p)}: ${errorMessage(err)}`);
    }
    return { name: path.basename(p), dataBase64: bytes.toString("base64") };
  });
  const problem = promptImagesProblem(images);
  if (problem !== null) fail(problem);
  return images;
}

/** `tumwater prompt [--role <id>] <text|list|cancel <n>>`: submit a steering prompt to the
 * director (default) or one role's queue, list what is queued with per-loop position
 * numbering, or cancel a queued prompt by position. The dispatcher in cli.ts gates on a ready
 * repo and delegates here; list output is grouped by loop — the director first (its queue is
 * the shared one every pre-1/2 prompt landed in), then each role with queued prompts — so a
 * per-role queue's position numbering stays unambiguous. */
export async function cmdPrompt(root: string, args: string[]): Promise<void> {
  const parsed = parsePromptArgs(args);
  if (parsed.role !== null) parsed.role = canonicalRoleId(parsed.role);
  // `--role <id>` scopes every mode to one loop's queue; the value is validated here, with
  // the same message every other --role consumer uses. The director is always valid: its
  // queue is the historical inbox (inbox.ts).
  //
  // Where the id set comes from differs by mode, following parseRoleScope's split: --list is
  // a read-only view, so a transiently broken tumwater.json must not take it down — it falls
  // back to the built-in catalog (knownRoleIdsCached), exactly like cmdLogs/cmdHistory's
  // --role scope, at the cost of a broken config hiding a custom loop's queued section. The
  // state-changing modes (enqueue, cancel) instead read through loadConfig and fail loudly
  // when an id was given: before writing to a named loop's queue the operator is owed the
  // config error, not a built-ins-only guess about whether the loop exists. With no --role,
  // enqueue touches only the director queue (inbox.ts) and never reads the config — a broken
  // tumwater.json must not block steering the director — while cancel resolves its position
  // across the per-loop sections --list prints, through the same cached, never-throwing id set
  // --list uses, so it cancels exactly what the list showed even under a broken config.
  const validIds = parsed.mode === "list"
    ? knownRoleIdsCached(root)
    : parsed.role !== null
      ? knownRoleIds(loadConfig(root))
      : null;
  if (validIds !== null && parsed.role !== null && !validIds.includes(parsed.role)) {
    fail(unknownRoleMessage(parsed.role, validIds));
  }
  const role = parsed.role;
  if (parsed.mode === "list") {
    // One payload, two shapes: the prose render and the --json output both come from the
    // same array, so the per-loop positions --cancel consumes can never disagree with the
    // data a script reads. Full text, verbatim: this is the inspection command that tells
    // you what a queued prompt actually says before you cancel it.
    const prompts = queuedListRows(root, role, validIds as string[]);
    if (parsed.json) {
      // An empty queue still prints the document, the history --json empty-rows precedent.
      sayJson({ prompts });
      return;
    }
    if (prompts.length === 0) {
      say(role !== null ? `${roleLabel(role)}'s inbox is empty` : "every inbox is empty");
      return;
    }
    say(renderQueuedList(prompts, Date.now()));
    return;
  }
  if (parsed.mode === "cancel") {
    if (role === null) {
      // No --role: the position addresses what --list shows — its per-loop sections, each
      // numbered from 1 (the director first, then the roles in catalog order). Resolve across
      // that scope: one loop holding the position cancels there, several are ambiguous (the
      // list itself shows two "N." lines), none is a miss. The output names the loop, since
      // the caller scoped nothing.
      sayListedOutcome(cancelListedPrompt(root, listWideScope(root), parsed.position), parsed.position);
      return;
    }
    const target = role ?? DIRECTOR_ROLE;
    sayPromptOutcome(parsed.position, target, runRolePromptCommand(root, target, parsed.position, cancelRolePrompt), false);
    return;
  }
  if (parsed.mode === "edit") {
    // The same broken-config policy and list-wide resolution as cancel, one verb over: the
    // file's new content rides the same queue file (position, enqueue stamp, and a pending
    // --at deferral untouched), and a concurrent dequeue reports gone and exits clean. An
    // `--attach` list is read through the same helper the enqueue form uses and appended to
    // the prompt's images in place.
    const images = parsed.attachPaths.length > 0 ? readPromptImages(parsed.attachPaths) : undefined;
    // Image-input gate, `--edit`'s twin of the submit branch below (plans/image-input.md
    // "Attachments", part 5/5): editing an attachment into a queued prompt is the same
    // tick-time discovery the submit gate prevents, so the refusal promise holds across every
    // CLI attach surface — an image no configured model can read is refused before a byte is
    // written, and a loop that reroutes a blind read is told where the prompt will run. The
    // target loop is resolved first (the same resolution the verb below makes) so the gate can
    // name it.
    if (images !== undefined && images.length > 0) {
      const loop = role ?? failQueueMiss(resolveListedQueue(root, listWideScope(root), parsed.position), parsed.position).role;
      const guidance = imagePromptGuidance(root, loop);
      if (guidance.refusal) return fail(guidance.refusal);
      if (guidance.notice) say(guidance.notice);
    }
    const typed = parsed.text;
    if (typed === null) {
      // Bare `--edit <n>`: open the prompt's body in the editor. The loop is resolved first
      // and the write goes by file name, so a dequeue while the editor is open reports gone
      // instead of editing the neighbour that shifted into the position.
      let target = role;
      if (target === null) {
        const resolved = resolveListedQueue(root, listWideScope(root), parsed.position);
        target = failQueueMiss(resolved, parsed.position).role;
      }
      const loop = target;
      let name: string;
      let body: string | null;
      try {
        name = path.basename(queuedFileAtPosition(root, loop, parsed.position));
        body = readQueuedPromptBody(root, loop, name);
      } catch (err) {
        return fail(errorMessage(err));
      }
      if (body === null) {
        sayPromptOutcome(parsed.position, loop, { status: "gone" }, role === null);
        return;
      }
      const after = editInEditor(body, "prompt.md");
      // An emptied buffer is an abort, not a blank prompt: the queue would otherwise hold a
      // prompt with no text, which the enqueue forms refuse.
      if (after.trim() === "" && body.trim() !== "") fail("the edited prompt is empty; nothing changed (use --cancel <n> to drop it)");
      if (after.trim() === body.trim() && images === undefined) {
        say(`prompt ${parsed.position} unchanged`);
        return;
      }
      try {
        sayPromptOutcome(parsed.position, loop, editQueuedFile(root, loop, name, after, images), role === null);
      } catch (err) {
        fail(errorMessage(err));
      }
      return;
    }
    if (role === null) {
      sayListedOutcome(editListedPrompt(root, listWideScope(root), parsed.position, typed, images), parsed.position);
      return;
    }
    const target = role ?? DIRECTOR_ROLE;
    sayPromptOutcome(
      parsed.position,
      target,
      runRolePromptCommand(root, target, parsed.position, (r, role, position) => editRolePrompt(r, role, position, typed, images)),
      false,
    );
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  // `--at <duration>` is a delay, not an epoch: the marker's not-before time is now + the
  // parsed duration, computed at submit so the deferral starts when the operator queued it.
  const dueMs = parsed.atDelayMs !== null ? Date.now() + parsed.atDelayMs : undefined;
  // `--attach <path>`: read and validate through the shared helper (a bad path fails by name
  // before anything is queued). An attachment the target loop cannot read is refused here by
  // name — the same gate submitRolePrompt enforces, surfaced early so the CLI exits non-zero
  // with the fix before anything is written or queued; a loop that reroutes a blind read is
  // not refused, but the operator is told where the prompt will actually run.
  const images = parsed.attachPaths.length > 0 ? readPromptImages(parsed.attachPaths) : undefined;
  if (images && images.length > 0) {
    const guidance = imagePromptGuidance(root, target);
    if (guidance.refusal) return fail(guidance.refusal);
    if (guidance.notice) say(guidance.notice);
  }
  const wake = submitRolePromptAndWake(root, target, parsed.text, images, dueMs);
  const attached = images !== undefined ? ` with ${images.length} image(s)` : "";
  const owner = target === DIRECTOR_ROLE ? "the director's" : `${roleLabel(target)}'s`;
  if (parsed.atDelayMs !== null) {
    // A deferred prompt's confirmation names the delivery delay, in the same duration
    // vocabulary --at parsed (durationLabel), so the user can re-type it.
    say(`added to ${owner} inbox — delivers in ${durationLabel(parsed.atDelayMs)}${attached}`);
  } else {
    say(`added to ${owner} inbox${attached}`);
  }
  say(wake);
}
