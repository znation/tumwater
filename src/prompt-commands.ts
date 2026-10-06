/** The CLI layer of `tumwater prompt` — the steering-prompt command: submit a prompt to the
 * director (default) or one role's queue, `--list` what is queued with per-loop position
 * numbering, or `--cancel <n>` a queued prompt by position. Split out of operator-commands.ts
 * because this command is not a fleet-control marker: its sibling commands there ride the
 * operator-intent marker protocol, while every mode here reads or writes the durable per-loop
 * queues (src/inbox/inbox.ts) directly, each with its own broken-config policy — so the command
 * lives beside the queue module it drives. The fleet-side half (the dequeues a loop performs)
 * is inbox.ts and pending-prompt.ts. */
import { fail, say, sayJson } from "./cli/cli-output.js";
import fs from "node:fs";
import path from "node:path";
import { parsePromptArgs } from "./cli/cli-command-args.js";
import {
  type CancelOutcome,
  type ListedCancelOutcome,
  cancelListedPrompt,
  cancelRolePrompt,
} from "./inbox/inbox-cancel.js";
import {
  type EditOutcome,
  type ListedEditOutcome,
  editListedPrompt,
  editRolePrompt,
} from "./inbox/inbox-edit.js";
import { promptPreview, queuedRolePromptRecords } from "./inbox/inbox.js";
import { stripNotBeforeMarker } from "./prompt-not-before.js";
import { humanSeconds, secondsSince, secondsUntil } from "./datetime.js";
import { durationLabel } from "./cli/cli-args.js";
import { knownRoleIds, knownRoleIdsCached, loadConfig } from "./config/config.js";
import { errorMessage } from "./text.js";
import { promptImagesProblem, type PromptImageInput } from "./inbox/inbox-attachments.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "./roles.js";
import { submitRolePromptAndWake } from "./operator-intent.js";

/** One traversal of the queues behind `prompt --list`'s render: with `--role`, that loop's
 * queue alone; otherwise the director first (its queue is the shared pre-1/2 inbox), then the
 * remaining catalog ids in order, empty queues skipped — exactly the sections the prose
 * prints. `position` is the 1-based per-loop number the prose prints and `--cancel`
 * consumes; `text` is the full verbatim prompt, not a preview; `queuedAtMs` is the enqueue
 * stamp parsed from the queue filename (null for a hand-placed name), which the prose turns
 * into a `queued <age> ago` suffix; `notBeforeMs` is the prompt's not-before time parsed from
 * its queue file's marker line (null when absent or malformed), which the prose turns into a
 * `delivers in <duration>` countdown instead of the age — and `--json` carries both as-is. */
function promptListPayload(
  root: string,
  role: string | null,
  validIds: string[],
): { prompts: { role: string; position: number; text: string; queuedAtMs: number | null; notBeforeMs: number | null }[] } {
  const prompts: { role: string; position: number; text: string; queuedAtMs: number | null; notBeforeMs: number | null }[] = [];
  const record = (r: string, position: number, e: { text: string; queuedAtMs: number | null; notBeforeMs: number | null }) =>
    // The marker is stripped from the text both shapes print (stripNotBeforeMarker): the
    // prose and --json are the operator's view of what a loop will tick, and the marker is
    // plumbing, not content. Full verbatim prompt text minus plumbing, still not a preview.
    prompts.push({ role: r, position, text: stripNotBeforeMarker(e.text), queuedAtMs: e.queuedAtMs, notBeforeMs: e.notBeforeMs });
  if (role !== null) {
    queuedRolePromptRecords(root, role).forEach((e, i) => record(role, i + 1, e));
    return { prompts };
  }
  queuedRolePromptRecords(root, DIRECTOR_ROLE).forEach((e, i) => record(DIRECTOR_ROLE, i + 1, e));
  for (const r of validIds) {
    if (r === DIRECTOR_ROLE) continue;
    queuedRolePromptRecords(root, r).forEach((e, i) => record(r, i + 1, e));
  }
  return { prompts };
}

/** The ` (queued <age> ago)` suffix a prose `--list` line carries when its queue filename
 * stamps the enqueue time (queueFileStamp) — omitted when the stamp is unparseable, so a
 * hand-placed file renders exactly as it did before the age existed. Age buckets through
 * humanSeconds, the same phrasing every other relative time in the harness prints.
 * A deferred prompt (the not-before marker still in the future) shows its countdown instead
 * — ` (delivers in <duration>)` from the same humanSeconds — since the age of a prompt that
 * has not been delivered yet is not the fact an operator scanning the list needs. */
function queuedAgeSuffix(queuedAtMs: number | null, notBeforeMs: number | null, now: number): string {
  if (notBeforeMs !== null && notBeforeMs > now) {
    const seconds = secondsUntil(notBeforeMs, now);
    return ` (delivers in ${humanSeconds(seconds)})`;
  }
  if (queuedAtMs === null) return "";
  const ageSeconds = secondsSince(queuedAtMs, now);
  return ` (queued ${humanSeconds(ageSeconds)} ago)`;
}

/** The user-facing reply for one resolved cancel or edit — the four branches of cmdPrompt's
 * cancel and edit modes (list-wide and `--role`-scoped each): a concurrent dequeue is a normal
 * race, not an error, so it is reported and exited clean; a resolved one previews the text it
 * removed (a cancel's `text`) or wrote (an edit's `newText`). When `labelRole` the line names
 * the loop — the no-`--role` command resolves across every loop, so its output must say where
 * the prompt went — while a `--role`-scoped command already names it in the user's own
 * command. One helper so the cancel and edit wordings cannot drift. */
/** The loop order a list-wide position (`--cancel`/`--edit` with no `--role`) resolves across:
 * the director first, then the remaining cached catalog ids — the per-loop sections `--list`
 * prints, each numbered from 1. The single home of that scope, shared by the cancel and edit
 * branches so neither can drift from what the list showed. */
function listWideScope(root: string): string[] {
  return [DIRECTOR_ROLE, ...knownRoleIdsCached(root).filter((r) => r !== DIRECTOR_ROLE)];
}

/** The shared tail of the list-wide cancel/edit branches: report an ambiguity (naming the
 * rival loops, with the `--role` escape hatch) or a miss (carrying the queue count across
 * every loop), else render the resolved outcome through sayPromptOutcome. One helper so the
 * two verbs' handling of the miss shapes cannot drift. */
function sayListedOutcome(listed: ListedCancelOutcome | ListedEditOutcome, position: number): void {
  if (listed.status === "ambiguous") {
    fail(`position ${position} is queued for more than one loop (${listed.roles.join(", ")}) — name one with --role <id>`);
  }
  if (listed.status === "missing") {
    fail(`no prompt at position ${position} (${listed.queued} queued across all loops)`);
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

function sayPromptOutcome(position: number, role: string, outcome: CancelOutcome | EditOutcome, labelRole: boolean): void {
  if (outcome.status === "gone") {
    say(`prompt ${position} is no longer queued — ${role} already took it`);
    return;
  }
  // A resolved cancel carries the removed text; a resolved edit carries what it wrote.
  const text = outcome.status === "cancelled" ? outcome.text : outcome.newText;
  say(labelRole ? `${outcome.status} (${role}): ${promptPreview(text)}` : `${outcome.status}: ${promptPreview(text)}`);
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
    const payload = promptListPayload(root, role, validIds as string[]);
    if (parsed.json) {
      // An empty queue still prints the document, the history --json empty-rows precedent.
      sayJson(payload);
      return;
    }
    if (payload.prompts.length === 0) {
      say(role !== null ? `nothing queued for ${role}` : "nothing queued");
      return;
    }
    const sections: string[] = [];
    let currentRole: string | null = null;
    let lines: string[] = [];
    const now = Date.now();
    for (const p of payload.prompts) {
      if (p.role !== currentRole) {
        if (currentRole !== null) sections.push(`${currentRole}:\n${lines.join("\n")}`);
        currentRole = p.role;
        lines = [];
      }
      lines.push(`${p.position}. ${p.text}${queuedAgeSuffix(p.queuedAtMs, p.notBeforeMs, now)}`);
    }
    if (currentRole !== null) sections.push(`${currentRole}:\n${lines.join("\n")}`);
    say(sections.join("\n"));
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
    // --at deferral untouched), and a concurrent dequeue reports gone and exits clean.
    if (role === null) {
      sayListedOutcome(editListedPrompt(root, listWideScope(root), parsed.position, parsed.text), parsed.position);
      return;
    }
    const target = role ?? DIRECTOR_ROLE;
    sayPromptOutcome(
      parsed.position,
      target,
      runRolePromptCommand(root, target, parsed.position, (r, role, position) => editRolePrompt(r, role, position, parsed.text)),
      false,
    );
    return;
  }
  const target = role ?? DIRECTOR_ROLE;
  // `--at <duration>` is a delay, not an epoch: the marker's not-before time is now + the
  // parsed duration, computed at submit so the deferral starts when the operator queued it.
  const dueMs = parsed.atDelayMs !== null ? Date.now() + parsed.atDelayMs : undefined;
  // `--attach <path>`: read each file whole and fail naming the path before anything is
  // queued, then re-run the GUI endpoint's validation client-side (promptImagesProblem) so
  // the CLI's error names the broken rule — extension list, per-image cap, image-count cap —
  // with the same wording the dashboard answers 400 with, instead of deferring to
  // savePromptImages's post-enqueue rejection.
  let images: PromptImageInput[] | undefined;
  if (parsed.attachPaths.length > 0) {
    images = parsed.attachPaths.map((p) => {
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
  }
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
