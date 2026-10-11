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
  cancelListedPrompt,
  cancelRolePrompt,
} from "./inbox-cancel.js";
import {
  type EditOutcome,
  type ListedEditOutcome,
  editListedPrompt,
  editRolePrompt,
} from "./inbox-edit.js";
import { listWideScope, promptPreview, queuedListRows, renderQueuedList } from "./inbox.js";
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

/** The shared tail of the list-wide cancel/edit branches: report an ambiguity (naming the
 * rival loops, with the `--role` escape hatch) or a miss (carrying the length of the longest
 * queue, the highest position numbering any loop can hold), else render the resolved outcome
 * through sayPromptOutcome. One helper so the
 * two verbs' handling of the miss shapes cannot drift. */
function sayListedOutcome(listed: ListedCancelOutcome | ListedEditOutcome, position: number): void {
  if (listed.status === "ambiguous") {
    fail(`position ${position} is queued for more than one loop (${listed.roles.join(", ")}) — name one with --role <id>`);
  }
  if (listed.status === "missing") {
    fail(`no prompt at position ${position} (longest queue holds ${listed.queued})`);
  }
  sayPromptOutcome(position, listed.role, listed.outcome, true);
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
    say(`prompt ${position} is no longer queued — ${role} already took it`);
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
      say(role !== null ? `nothing queued for ${role}` : "nothing queued");
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
    if (role === null) {
      sayListedOutcome(editListedPrompt(root, listWideScope(root), parsed.position, parsed.text, images), parsed.position);
      return;
    }
    const target = role ?? DIRECTOR_ROLE;
    sayPromptOutcome(
      parsed.position,
      target,
      runRolePromptCommand(root, target, parsed.position, (r, role, position) => editRolePrompt(r, role, position, parsed.text, images)),
      false,
    );
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  // `--at <duration>` is a delay, not an epoch: the marker's not-before time is now + the
  // parsed duration, computed at submit so the deferral starts when the operator queued it.
  const dueMs = parsed.atDelayMs !== null ? Date.now() + parsed.atDelayMs : undefined;
  // `--attach <path>`: read and validate through the shared helper (a bad path fails by name
  // before anything is queued).
  const images = parsed.attachPaths.length > 0 ? readPromptImages(parsed.attachPaths) : undefined;
  const wake = submitRolePromptAndWake(root, target, parsed.text, images, dueMs);
  const attached = images !== undefined ? ` with ${images.length} image(s)` : "";
  if (parsed.atDelayMs !== null) {
    // A deferred prompt's confirmation names the delivery delay, in the same duration
    // vocabulary --at parsed (durationLabel), so the operator can re-type it.
    const deferred = ` — delivers in ${durationLabel(parsed.atDelayMs)}`;
    say(role === null ? `queued for the director loop${deferred}${attached}` : `queued for the ${role} loop${deferred}${attached}`);
  } else if (role === null) {
    say(`queued for the director loop${attached}`);
  } else {
    say(`queued for the ${role} loop${attached}`);
  }
  say(wake);
}
