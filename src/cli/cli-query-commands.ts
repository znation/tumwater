/** The read-only query commands' bodies (status, diff, backlog, questions, role), split out of
 * cli.ts's dispatcher: main() routes to a cmd* here exactly as it routes to operator-commands's
 * cmdAbort or config-commands's cmdConfig, and cli.ts keeps only routing and the help/version
 * surfaces. Each command owns its argument gate, ready-repo gating decision, and output shape,
 * with the wording and gating order moved verbatim from main()'s cases. */

import { fail, say, sayJson, sayJsonOrRender } from "./cli-output.js";
import { flagValue, parseRoleFlag, rejectRepeatFlag } from "./cli-args.js";
import { JSON_FLAG, rejectEqualsForm, rejectUnknownArgs, ROLE_FLAG } from "./cli-flag-specs.js";
import { requireReadyRepo } from "./cli-repo-gate.js";
import { defaultConfig, knownRoleIds, knownRoleIdsCached, loadConfigSafe } from "../config/config.js";
import { gotSuffix, parsePositiveInt } from "../text/text.js";
import { snapshot } from "../status/status-data.js";
import { statusPayload } from "../ui/status-payload.js";
import { renderStatus } from "../ui/status-render.js";
import { backlogPayload } from "../backlog/backlog.js";
import { backlogHolds } from "../backlog/backlog-eligibility.js";
import { renderBacklogMarkdown } from "../backlog/backlog-render.js";
import { collectFleetChanges, collectRoleChange } from "../change/change-data.js";
import { renderFleetChange, renderRoleChange } from "../change/change-render.js";
import { readLandingQueue } from "../landing/landing-queue.js";
import { renderLandingQueue } from "../landing/landing-queue-render.js";
import { rolePayload } from "../roles/role-view.js";
import { renderRoleMarkdown } from "../roles/role-render.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "../roles/roles.js";
import { saveRoleNote } from "../agent/role-notes-write.js";
import { roleNotesPath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { readPromptFileArg, promptFileValue } from "./cli-command-args.js";
import { answerQuestion, answerQuestionFromText, sayAnswered, sayQuestionList } from "./question-commands.js";

/** `questions answer`'s `--file <path>` flag: the decision comes from the file, lines kept. */
const FILE_SPEC = { names: ["--file"], value: true, valueName: "<path>" };

/** `role`'s notebook-write flags: clear the note, or replace it from a file (`-` for stdin). */
const CLEAR_NOTES_SPEC = { names: ["--clear-notes"] };
const NOTES_FILE_SPEC = { names: ["--notes-file"], value: true, valueName: "<path>" };

/** Peel `tumwater role <id>`'s positional id off the argument list: the first token that is
 * neither a flag nor the value of a --role or --notes-file flag. Returns the id (null when absent) and the
 * remaining arguments — flags only, ready for rejectUnknownArgs and sayJsonOrRender. The
 * id may also arrive as --role <id>, the flag spelling every other role-targeting command
 * shares; the collector's caller rejects both spellings at once rather than silently
 * picking one. Lives here because it exists only for this one command's mixed
 * positional/flag vocabulary. */
function peelRolePositional(args: string[]): { id: string | null; rest: string[] } {
  const valueIdx = new Set<number>();
  for (const flag of ["--role", "--notes-file"]) {
    const at = args.indexOf(flag);
    if (at >= 0) valueIdx.add(at + 1);
  }
  let id: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    // A non-flag token that is not a --role or --notes-file flag's value is the positional, taken once;
    // everything else — flags and their values alike — rides in rest for rejectUnknownArgs
    // and flagValue to claim.
    if (!arg.startsWith("-") && id === null && !valueIdx.has(i)) {
      id = arg;
      continue;
    }
    rest.push(arg);
  }
  return { id, rest };
}

/** `tumwater status`: the fleet snapshot as rendered text or as the JSON document GET
 * /api/status serves. */
export async function cmdStatus(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("status", args, [JSON_FLAG]);
  await requireReadyRepo(root);
  if (args.includes("--json")) {
    // Machine-readable fleet state — the document GET /api/status serves minus the
    // serving process's own `serverBuildSha`, printed with no server. A query, not a
    // health verdict: exit 0 on any successful read and let scripts interpret fields
    // themselves ("running": false is data, not failure).
    sayJson(statusPayload(root));
  } else {
    say(renderStatus(root, snapshot(root), process.stdout.isTTY ? process.stdout.columns : undefined));
  }
}

/** `tumwater diff`: one line per loop holding pending work, or the full per-role view with
 * `--role <id>`. */
export async function cmdDiff(root: string, args: string[]): Promise<void> {
  // The repo half of requireReadyRepo still gates: a directory tumwater cannot read yet
  // (no git, not a repository, no tumwater.json, no commits) has no fleet to ask about,
  // and the change view's own degradation would misreport that as "main branch <name>
  // does not exist" — so the shared readiness wording answers here, like every sibling
  // command. Past the gate an absent worktree still degrades to a `no worktree for
  // <role>` line (exit 0), so the command answers in any initialized directory —
  // report's rationale.
  rejectUnknownArgs("diff", args, [ROLE_FLAG, JSON_FLAG]);
  await requireReadyRepo(root);
  // Absent --role is the fleet-wide form: one line per loop holding pending work
  // (parseRoleFlag returns null only for an absent flag — an empty or unknown value
  // already failed above). A named role keeps the full per-role view.
  const role = parseRoleFlag(args, knownRoleIdsCached(root));
  if (role === null) {
    sayJsonOrRender(args, await collectFleetChanges(root), renderFleetChange);
  } else {
    const change = await collectRoleChange(root, role);
    sayJsonOrRender(args, change, renderRoleChange);
  }
}

/** `tumwater queue`: the durable land queue in execution order, as text or as the
 * `{entries, unreadable}` document. */
export async function cmdQueue(root: string, args: string[]): Promise<void> {
  // The repo half of requireReadyRepo gates: like every repo-bound query, a directory
  // tumwater cannot read yet has no queue to show. Past the gate an absent queue dir reads
  // as an empty queue (a `land queue empty` line, exit 0), so no landing ever queued is
  // data, not an error.
  rejectUnknownArgs("queue", args, [JSON_FLAG]);
  await requireReadyRepo(root);
  // The JSON branch prints the reader's own document — raw sha and numeric enqueuedAt, not
  // the render's short sha and age — and the render is the collector's view with one clock
  // read, so `tumwater queue` and `tumwater status --json`'s landQueue cannot drift.
  sayJsonOrRender(args, readLandingQueue(root), (view) => renderLandingQueue(view, Date.now()));
}

/** `tumwater backlog`: the planned/open entries as Markdown or as the GUI's JSON payload. */
export async function cmdBacklog(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate: the entry readers degrade to [] on a missing file, so the
  // command prints three empty sections in any directory (report's rationale, not config's).
  rejectUnknownArgs("backlog", args, [JSON_FLAG]);
  // Machine-readable backlog — the three entry arrays the Markdown view renders and the
  // GUI's /api/backlog serves (status --json's "print the endpoint's payload" pattern),
  // plus `holds.plans`/`holds.bugs` parallel to the entry arrays so a skipped entry's
  // reason is data, not inference: a pretty-printed JSON document in every exit-0 case,
  // never prose. The payload is a thunk, so whichever branch runs reads the three entry
  // files through their stat caches once — the Markdown renderer consumes the same arrays
  // the JSON document prints.
  sayJsonOrRender(
    args,
    () => ({ ...backlogPayload(root), holds: backlogHolds(root) }),
    renderBacklogMarkdown,
  );
}

/** `tumwater questions`: list open questions, or answer one with `answer <n> <decision>`. */
export async function cmdQuestions(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate, like backlog: the reader degrades to an empty list on a
  // missing QUESTIONS.md, so the command inspects any directory instead of refusing.
  // The answer form's decision is free-form prose, so peelPositionals cannot route the
  // tokens: a decision word may begin with a single dash (`questions answer 1 "-50% spend
  // cap"`), and peelPositionals would hand it to the flag gate as an unknown flag — the
  // same masking parsePromptArgs avoids for prompt text by owning only `--`-prefixed
  // tokens. So the questions parse scans args itself: a `--json` token before the
  // question's number positional is the one flag (repeats refused, equals form named by
  // rejectEqualsForm), any other `--`-prefixed token before it is refused as unknown, and
  // every remaining token in order is prose — subcommand, position number, then the
  // decision words. Past the number positional, tokens are decision words even when one
  // is spelled `--json`: unquoted decision prose (`questions answer 1 keep --json output`)
  // reaches the command as separate argv tokens, and a flag scan that matched `--json`
  // anywhere silently ate the token out of the recorded decision and flipped the command
  // into JSON mode. Unknown `--`-prefixed tokens stay refused even there, so a misspelled
  // flag is still an error rather than silent decision text.
  const words: string[] = [];
  let jsonFlag = false;
  let numbered = false;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--file") {
      rejectRepeatFlag(file !== undefined, "--file");
      file = promptFileValue(args[++i]);
      continue;
    }
    if (!numbered && arg === "--json") {
      rejectRepeatFlag(jsonFlag, "--json");
      jsonFlag = true;
      continue;
    }
    if (arg.startsWith("--") && arg !== "--json") {
      rejectEqualsForm(arg, [JSON_FLAG, FILE_SPEC]);
      fail(`unknown argument: ${arg} (valid flags for tumwater questions: --json, --file)`);
    }
    if (!numbered) {
      // The position is a plain-decimal positive integer (parsePositiveInt's rule, the same
      // one --cancel's position honors): bare Number() admitted hex ("0x2"), exponent
      // ("1e2"), and whitespace-padded spellings as a valid question number, answering a
      // question the operator never named.
      if (parsePositiveInt(arg) !== null) numbered = true;
    }
    words.push(arg);
  }
  if (words.length === 0 && file !== undefined) fail("--file only applies to questions answer <n>");
  if (words.length === 0) {
    sayQuestionList(root, jsonFlag);
    return;
  }
  if (words[0] !== "answer")
    fail(
      `unknown questions subcommand: ${words[0]} (use "answer <n> <decision>", or run \`tumwater questions\` with no subcommand to list them)`,
    );
  // The offending token carries the same ` (got "...")` suffix every sibling number parser
  // adds (parsePositiveInt's flag callers, --cancel); the bare `answer` form names none.
  const raw = words.length > 1 ? words[1] : undefined;
  const n = raw === undefined ? null : parsePositiveInt(raw);
  if (n === null)
    fail(
      `questions answer needs a positive question number: questions answer <n> "<decision>"${raw === undefined ? "" : gotSuffix(raw)}`,
    );
  if (file !== undefined) {
    if (words.length > 2) fail(`unexpected argument ${JSON.stringify(words[2])} — with --file the decision comes from the file`);
    const answered = answerQuestionFromText(root, n, readPromptFileArg(file));
    sayAnswered(n, answered.title, jsonFlag, answered.decision);
    return;
  }
  const decision = words.slice(2).join(" ").trim();
  if (decision === "")
    fail('questions answer needs a decision: questions answer <n> "<decision>"');
  // answerQuestion collapses the free-form decision to one line before writing it; report
  // that landed text in the --json payload so it matches the file, not the caller's spacing.
  const { title, decision: landedDecision } = answerQuestion(root, n, decision);
  sayAnswered(n, title, jsonFlag, landedDecision);
}

/** `tumwater role <id>`: one loop's standing prompt and next tick's assembled prompt. */
export async function cmdRole(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate, like backlog: role-view degrades (missing state files →
  // fresh defaults, a missing queue directory an empty inbox), so the command inspects
  // a repo the fleet never started in — and a torn one — instead of refusing.
  const { id: positional, rest } = peelRolePositional(args);
  rejectUnknownArgs("role", rest, [ROLE_FLAG, JSON_FLAG, CLEAR_NOTES_SPEC, NOTES_FILE_SPEC]);
  // The id is required: positional (`tumwater role <id>`) or --role <id> (the flag
  // spelling every other role-targeting command shares). Both at once is a mistake, not
  // a silent pick of one.
  const flagId = flagValue(rest, "--role") ?? null;
  const id = positional ?? flagId;
  if (!id) fail("tumwater role needs a role id");
  if (positional !== null && flagId !== null && flagId !== positional)
    fail("give the role id once — as the positional or as --role <id>, not both");
  const clear = rest.includes("--clear-notes");
  const notesFile = flagValue(rest, "--notes-file");
  if (clear || rest.includes("--notes-file")) {
    if (clear && rest.includes("--notes-file")) fail("give --clear-notes or --notes-file, not both");
    if (rest.includes("--json")) fail("--json does not apply to a notebook write");
    if (id === DIRECTOR_ROLE) fail("the director has no notebook");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const text = clear ? "" : readPromptFileArg(notesFile || fail("--notes-file needs a path"));
    try {
      say(`${id}: ${saveRoleNote(roleNotesPath(root, id), text)}`);
    } catch (err) {
      fail(errorMessage(err));
    }
    return;
  }
  // The unknown-role answer (exit 1, unknownRoleMessage's wording) lives in the
  // collector; here the id just has to be non-null for the thunk's types.
  sayJsonOrRender(rest, () => rolePayload(root, id), renderRoleMarkdown);
}
