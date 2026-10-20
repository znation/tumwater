// vocabulary: plain
/** The read-only query commands' bodies (status, diff, backlog, questions, role), split out of
 * cli.ts's dispatcher: main() routes to a cmd* here exactly as it routes to operator-commands's
 * cmdAbort or config-commands's cmdConfig, and cli.ts keeps only routing and the help/version
 * surfaces. Each command owns its argument gate, ready-repo gating decision, and output shape,
 * with the wording and gating order moved verbatim from main()'s cases. */

import { fail, say, sayJson, sayJsonOrRender, warnIfUncommitted } from "./cli-output.js";
import { flagValue, parseCountFlag, parseGrepFlag, parsePositionFlag, parseRoleFlag, parseRoleListScope, rejectRepeatFlag } from "./cli-args.js";
import { JSON_FLAG, READY_FLAG, grepFlagSpec, rejectEqualsForm, rejectUnknownArgs, ROLE_FLAG, STAT_FLAG } from "./cli-flag-specs.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli-repo-gate.js";
import { defaultConfig, knownRoleIds, knownRoleIdsCached, loadConfigSafe } from "../config/config.js";
import { gotSuffix, parsePositiveInt } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";
import { scopeSnapshotToRoles, snapshot } from "../status/status-data.js";
import { statusPayload } from "../ui/status-payload.js";
import { renderStatus } from "../ui/status-render.js";
import { backlogPayload } from "../backlog/backlog.js";
import { backlogHolds, backlogInProgress } from "../backlog/backlog-eligibility.js";
import { readyBacklog, grepBacklog, renderBacklogMarkdown } from "../backlog/backlog-render.js";
import { collectTeamChanges, collectRoleChange } from "../change/change-data.js";
import { renderTeamChange, renderRoleChange } from "../change/change-render.js";
import { readMergeQueue } from "../merge/merge-queue.js";
import { renderMergeQueue } from "../merge/merge-queue-render.js";
import { orchestratorAlive } from "../team/orchestrator-info.js";
import { queueInFlight } from "../status/status-polls.js";
import { rolePayload } from "../roles/role-view.js";
import { renderRoleMarkdown } from "../roles/role-render.js";
import { DIRECTOR_ROLE, unknownRoleMessage } from "../roles/roles.js";
import { saveRoleNote } from "../agent/role-notes-write.js";
import { roleNotesPath } from "../paths.js";
import { errorMessage } from "../text/text.js";
import { readPromptFileArg, promptFileValue } from "./cli-command-args.js";
import { commitOperatorBacklogEdit } from "../backlog/backlog-commit.js";
import { stampedSubject } from "../git/commit-message.js";
import { wakeQuestionAsker } from "../operator/operator-intent.js";
import { answerEditorBuffer, answerQuestion, answerQuestionFromText, decisionFromEditorBuffer, sayAnswered, sayQuestionList } from "./question-commands.js";
import { answeredQuestionAt, answeredQuestionCount, answeredQuestionList, answeredQuestionPayload, openQuestionAt, questionListPayload, renderShownQuestion } from "../backlog/question-answer.js";
import { editInEditor } from "./cli-editor.js";
import { canonicalRoleId } from "../roles/legacy-role-ids.js";
import { baseRoleOf } from "../roles/runner-ids.js";
import { setConfigKey, unsetConfigKey } from "../config/config-write.js";

/** `questions answer`'s `--file <path>` flag: the decision comes from the file, lines kept. */
const FILE_SPEC = { names: ["--file"], value: true, valueName: "<path>" };

/** `role`'s notebook-write flags: clear the note, or replace it from a file (`-` for stdin). */
const CLEAR_NOTES_SPEC = { names: ["--clear-notes"] };
const NOTES_FILE_SPEC = { names: ["--notes-file"], value: true, valueName: "<path>" };

/** `role`'s instructions-override flags: clear it, or replace it from a file (`-` for stdin). */
const CLEAR_INSTRUCTIONS_SPEC = { names: ["--clear-instructions"] };
const INSTRUCTIONS_FILE_SPEC = { names: ["--instructions-file"], value: true, valueName: "<path>" };

/** `role`'s quiet-hours write flags: clear the window, or set it to a daily local-time window. */
const CLEAR_QUIET_HOURS_SPEC = { names: ["--clear-quiet-hours"] };
const QUIET_HOURS_SPEC = { names: ["--quiet-hours"], value: true, valueName: "<window>" };

/** `role`'s daily-cap write flags: clear the cap, or set it to a USD amount (0 disables). */
const CLEAR_CAP_SPEC = { names: ["--clear-cap"] };
const CAP_SPEC = { names: ["--cap"], value: true, valueName: "<usd>" };

/** `role`'s min-run-interval write flags: clear it, or set it to a second count (0 is
 * back-to-back). */
const CLEAR_MIN_RUN_INTERVAL_SPEC = { names: ["--clear-min-run-interval"] };
const MIN_RUN_INTERVAL_SPEC = { names: ["--min-run-interval"], value: true, valueName: "<seconds>" };

/** `role`'s instances write flags: clear the count, or set it to a parallel-runner count
 * (an integer from 1 to 8; only feature and bugfix split). */
const CLEAR_INSTANCES_SPEC = { names: ["--clear-instances"] };
const INSTANCES_SPEC = { names: ["--instances"], value: true, valueName: "<n>" };

/** `role`'s enabled-state write flags: enable or disable the role, written to
 * roles.<base>.enabled. */
const ENABLE_SPEC = { names: ["--enable"] };
const DISABLE_SPEC = { names: ["--disable"] };

/** `role`'s model-triple write flags: clear the field, or set it, written to
 * roles.<base>.provider/.model/.thinking. model and provider take an id; thinking takes a
 * pi `--thinking` level (off|minimal|low|medium|high|xhigh|max). */
const CLEAR_PROVIDER_SPEC = { names: ["--clear-provider"] };
const PROVIDER_SPEC = { names: ["--provider"], value: true, valueName: "<id>" };
const CLEAR_MODEL_SPEC = { names: ["--clear-model"] };
const MODEL_SPEC = { names: ["--model"], value: true, valueName: "<id>" };
const CLEAR_THINKING_SPEC = { names: ["--clear-thinking"] };
const THINKING_SPEC = { names: ["--thinking"], value: true, valueName: "<level>" };

/** Peel `tumwater role <id>`'s positional id off the argument list: the first token that is
 * neither a flag nor the value of a --role, --notes-file, --instructions-file,
 * --quiet-hours, --cap, --min-run-interval, --instances, --provider, --model or
 * --thinking flag. Returns the id (null when absent) and the remaining arguments — flags
 * only, ready for rejectUnknownArgs and sayJsonOrRender. The id may also arrive as
 * --role <id>, the flag spelling every other role-targeting command shares; the
 * collector's caller rejects both spellings at once rather than silently picking one.
 * Lives here because it exists only for this one
 * command's mixed positional/flag vocabulary. */
function peelRolePositional(args: string[]): { id: string | null; rest: string[] } {
  const valueIdx = new Set<number>();
  for (const flag of ["--role", "--notes-file", "--instructions-file", "--quiet-hours", "--cap", "--min-run-interval", "--instances", "--provider", "--model", "--thinking"]) {
    const at = args.indexOf(flag);
    if (at >= 0) valueIdx.add(at + 1);
  }
  let id: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    // A non-flag token that is not a value-taking flag's value is the positional,
    // taken once; everything else — flags and their values alike — rides in rest for
    // rejectUnknownArgs and flagValue to claim.
    if (!arg.startsWith("-") && id === null && !valueIdx.has(i)) {
      id = arg;
      continue;
    }
    rest.push(arg);
  }
  return { id, rest };
}

/** `tumwater status`: the team snapshot as rendered text or as the JSON document GET
 * /api/status serves. */
export async function cmdStatus(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("status", args, [ROLE_FLAG, JSON_FLAG]);
  await requireReadyRepo(root);
  const scope = parseRoleListScope(root, args);
  if (args.includes("--json")) {
    // Machine-readable team state — the document GET /api/status serves minus the
    // serving process's own `serverBuildSha`, printed with no server. A query, not a
    // health verdict: exit 0 on any successful read and let scripts interpret fields
    // themselves ("running": false is data, not failure).
    sayJson(statusPayload(root, Date.now(), scope));
  } else {
    const snap = snapshot(root);
    say(renderStatus(root, scope ? scopeSnapshotToRoles(snap, scope) : snap, process.stdout.isTTY ? process.stdout.columns : undefined, scope !== null));
  }
}

/** `tumwater diff`: one line per role holding pending work, or the full per-role view with
 * `--role <id>`. */
export async function cmdDiff(root: string, args: string[]): Promise<void> {
  // The repo half of requireReadyRepo still gates: a directory tumwater cannot read yet
  // (no git, not a repository, no tumwater.json, no commits) has no team to ask about,
  // and the change view's own degradation would misreport that as "main branch <name>
  // does not exist" — so the shared readiness wording answers here, like every sibling
  // command. Past the gate an absent worktree still degrades to a `no worktree for
  // <role>` line (exit 0), so the command answers in any initialized directory —
  // report's rationale.
  rejectUnknownArgs("diff", args, [ROLE_FLAG, JSON_FLAG, STAT_FLAG]);
  await requireReadyRepo(root);
  // Absent --role is the team-wide form: one line per role holding pending work
  // (parseRoleFlag returns null only for an absent flag — an empty or unknown value
  // already failed above). A named role keeps the full per-role view.
  const role = parseRoleFlag(args, knownRoleIdsCached(root));
  if (role === null) {
    if (args.includes("--stat")) fail("diff --stat needs --role <id> (the team roster prints no patch)");
    sayJsonOrRender(args, await collectTeamChanges(root), renderTeamChange);
  } else {
    const change = await collectRoleChange(root, role, { stat: args.includes("--stat") });
    sayJsonOrRender(args, change, renderRoleChange);
  }
}

/** `tumwater queue`: the durable merge queue in execution order, as text or as the
 * `{entries, unreadable}` document. */
export async function cmdQueue(root: string, args: string[]): Promise<void> {
  // The repo half of requireReadyRepo gates: like every repo-bound query, a directory
  // tumwater cannot read yet has no queue to show. Past the gate an absent queue dir reads
  // as an empty queue (a `merge queue empty` line, exit 0), so no merge ever queued is
  // data, not an error.
  rejectUnknownArgs("queue", args, [JSON_FLAG]);
  await requireReadyRepo(root);
  // The JSON branch prints the reader's own document — raw sha and numeric enqueuedAt, not
  // the render's short sha and age — and the render is the collector's view with one clock
  // read, so `tumwater queue` and `tumwater status --json`'s mergeQueue cannot drift.
  // The in-flight marker rides along only while an orchestrator runs and the marker names a
  // queued entry (queueInFlight) — status --json's mergeQueue.inFlight, so the two agree.
  const view = readMergeQueue(root);
  const inFlight = queueInFlight(root, view.entries, orchestratorAlive(root));
  sayJsonOrRender(args, inFlight ? { ...view, inFlight } : view, () => renderMergeQueue(view, Date.now(), inFlight));
}

/** `tumwater backlog`: the planned/open entries as Markdown or as the GUI's JSON payload. */
export async function cmdBacklog(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate: the entry readers degrade to [] on a missing file, so the
  // command prints three empty sections in any directory (report's rationale, not config's);
  // the team-workspace refusal still applies.
  // --grep filters the three entry arrays to the matches, the finished-entry lists' one
  // matcher (entryMatches) on the active backlog; it composes with --ready (grep first, so
  // the hidden count and the kept entries count only the matches) and with --json. The
  // missing-value wording lives in BACKLOG_GREP_VALUE_ERROR, the flag gate's and this
  // parser's shared string.
  const BACKLOG_GREP_VALUE_ERROR = "backlog --grep needs text (usage: tumwater backlog --grep <text>)";
  rejectUnknownArgs("backlog", args, [JSON_FLAG, READY_FLAG, grepFlagSpec(BACKLOG_GREP_VALUE_ERROR)]);
  refuseTeamWorkspace(root);
  const { rest, pattern } = parseGrepFlag(args, BACKLOG_GREP_VALUE_ERROR);
  // Machine-readable backlog — the three entry arrays the Markdown view renders and the
  // GUI's /api/backlog serves (status --json's "print the endpoint's payload" pattern),
  // plus `holds.plans`/`holds.bugs` parallel to the entry arrays so a skipped entry's
  // reason is data, not inference: a pretty-printed JSON document in every exit-0 case,
  // never prose. The payload is a thunk, so whichever branch runs reads the three entry
  // files through their stat caches once — the Markdown renderer consumes the same arrays
  // the JSON document prints.
  // --ready filters both branches through readyBacklog; the Markdown branch adds a count of
  // the held entries it hid. The --json/--ready reads go over `rest` (the --grep value token
  // removed), so a flag-shaped pattern like `--grep --json` greps for "--json" rather than
  // flipping this branch into JSON mode.
  const ready = rest.includes("--ready");
  let hidden = 0;
  sayJsonOrRender(
    rest,
    () => {
      const view = { ...backlogPayload(root), holds: backlogHolds(root), inProgress: backlogInProgress(root) };
      const filtered = pattern === null ? view : grepBacklog(view, pattern);
      if (!ready) return filtered;
      const kept = readyBacklog(filtered);
      hidden = filtered.plans.length + filtered.bugs.length - kept.plans.length - kept.bugs.length;
      return kept;
    },
    (v) => renderBacklogMarkdown(v) + (hidden > 0
      ? `\n\n_(${hidden} held entries hidden; run \`tumwater backlog\` to see them)_` : ""),
  );
}

/** `tumwater questions`: list open questions, or answer one with `answer <n> <decision>`. */
export async function cmdQuestions(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate, like backlog: the reader degrades to an empty list on a
  // missing QUESTIONS.md, so the command inspects any directory instead of refusing (a team
  // workspace still refuses).
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
  let answeredFlag = false;
  let limit: number | undefined;
  let grep: string | undefined;
  let show: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!numbered && arg === "--show") {
      rejectRepeatFlag(show !== undefined, "--show");
      show = parsePositionFlag("--show", args[++i], "--show 2");
      continue;
    }
    if (!numbered && arg === "--answered") {
      rejectRepeatFlag(answeredFlag, "--answered");
      answeredFlag = true;
      continue;
    }
    if (!numbered && arg === "-n") {
      rejectRepeatFlag(limit !== undefined, "-n");
      limit = parseCountFlag("-n", args[++i]);
      continue;
    }
    if (!numbered && arg === "--grep") {
      rejectRepeatFlag(grep !== undefined, "--grep");
      const text = args[++i];
      if (text === undefined || text === "") fail("--grep needs text (usage: tumwater questions [--answered] --grep <text>)");
      grep = text;
      continue;
    }
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
      rejectEqualsForm(arg, [JSON_FLAG, FILE_SPEC, { names: ["--show"], value: true, valueName: "<n>" }, { names: ["--grep"], value: true, valueName: "<text>" }]);
      fail(`unknown argument: ${arg} (valid flags for tumwater questions: --json, --file, --answered, --show, --grep)`);
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
  if (limit !== undefined && !answeredFlag) fail("-n needs --answered (it limits the answered questions listed)");
  refuseTeamWorkspace(root);
  if (show !== undefined) {
    if (grep !== undefined) fail("--grep does not apply to --show");
    if (words.length > 0) fail("--show prints one open question; it takes no subcommand");
    if (file !== undefined) fail("--file only applies to questions answer <n>");
    if (answeredFlag) {
      if (limit !== undefined) fail("-n does not apply to --show");
      const a = answeredQuestionAt(root, show);
      if (a === null) {
        const count = answeredQuestionCount(root);
        const range = count > 0 ? ` — valid: 1-${count}` : "";
        fail(`no answered question at position ${show} (${count} in QUESTIONS.md)${range}`);
      }
      if (jsonFlag) sayJson(a);
      else say(renderShownQuestion(a));
      return;
    }
    const q = openQuestionAt(root, show);
    if (q === null) {
      const count = questionListPayload(root).questions.length;
      const range = count > 0 ? ` — valid: 1-${count}` : "";
      fail(`no open question at position ${show} (${count} in QUESTIONS.md)${range}`);
    }
    if (jsonFlag) sayJson(q);
    else say(renderShownQuestion(q));
    return;
  }
  if (answeredFlag) {
    if (words.length > 0) fail("--answered lists answered questions; it takes no subcommand");
    if (file !== undefined) fail("--file only applies to questions answer <n>");
    if (jsonFlag) sayJson(answeredQuestionPayload(root, limit ?? 10, grep));
    else say(answeredQuestionList(root, limit ?? 10, grep));
    return;
  }
  if (words.length === 0 && file !== undefined) fail("--file only applies to questions answer <n>");
  if (words.length === 0) {
    sayQuestionList(root, jsonFlag, grep);
    return;
  }
  if (grep !== undefined) fail("--grep only applies to listing questions");
  if (words[0] !== "answer")
    fail(
      `unknown questions subcommand: ${words[0]} (use "answer <n> <decision>", or run \`tumwater questions\` with no subcommand to list them)${typoSuffix(words[0]!, ["answer"])}`,
    );
  // The offending token carries the same ` (got "...")` suffix every sibling number parser
  // adds (parsePositiveInt's flag callers, --cancel); the bare `answer` form names none.
  const raw = words.length > 1 ? words[1] : undefined;
  const n = raw === undefined ? null : parsePositiveInt(raw);
  if (n === null)
    fail(
      `questions answer needs a positive question number: questions answer <n> "<decision>"${gotSuffix(raw)}`,
    );
  if (file !== undefined) {
    if (words.length > 2) fail(`unexpected argument ${JSON.stringify(words[2])} — with --file the decision comes from the file`);
    const answered = answerQuestionFromText(root, n, readPromptFileArg(file));
    await commitAndReportAnswer(root, n, jsonFlag, answered.title, answered.decision);
    return;
  }
  const decision = words.slice(2).join(" ").trim();
  if (words.length === 2) {
    const open = questionListPayload(root).questions;
    const question = open[n - 1];
    if (question === undefined) {
      const range = open.length > 0 ? ` — valid: 1-${open.length}` : "";
      fail(`no question at position ${n} (${open.length} open)${range}`);
    }
    const edited = decisionFromEditorBuffer(
      editInEditor(answerEditorBuffer(question.title, question.body), `answer-${n}.md`, "pass a decision or --file <path>"),
    );
    if (edited.trim() === "") fail("questions answer needs a decision: the editor left it blank; nothing changed");
    const answered = answerQuestionFromText(root, n, edited, question.title);
    await commitAndReportAnswer(root, n, jsonFlag, answered.title, answered.decision);
    return;
  }
  if (decision === "")
    fail('questions answer needs a decision: questions answer <n> "<decision>"');
  // answerQuestion collapses the free-form decision to one line before writing it; report
  // that written text in the --json payload so it matches the file, not the caller's spacing.
  const { title, decision: writtenDecision } = answerQuestion(root, n, decision);
  await commitAndReportAnswer(root, n, jsonFlag, title, writtenDecision);
}

/** Commit the answered question, report it in the requested output mode, and wake the
 * asking role in prose mode — the tail every `questions answer` branch ends with. */
async function commitAndReportAnswer(root: string, n: number, jsonFlag: boolean, title: string, decision: string): Promise<void> {
  warnIfUncommitted(await commitOperatorBacklogEdit(root, "QUESTIONS.md", stampedSubject("operator", `Answer question: ${title}`)), "QUESTIONS.md"); // vocabulary-ok: commit prefix stays
  sayAnswered(n, title, jsonFlag, decision);
  if (!jsonFlag) sayAskerWake(root, title);
}

/** Prose-mode follow-up to `questions answer`: wake the asking role and print the confirmation. */
function sayAskerWake(root: string, title: string): void {
  const wake = wakeQuestionAsker(root, title);
  if (wake !== null) say(wake);
}

/** Refuse an unknown role id with the shared unknownRoleMessage wording before a per-role
 * config write resolves the id. Every `tumwater role` write branch starts with the same
 * prelude — load the config (falling back to defaultConfig so built-in roles resolve) and
 * throw the unknown-role error unless the id appears — so this keeps that check in one place.
 * The caller then derives `baseRoleOf(id)` for the write key. */
function requireKnownRole(root: string, id: string): void {
  const cfg = loadConfigSafe(root).config ?? defaultConfig();
  if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
}

/** The config-key write the six per-role hold branches (quiet hours, daily cap, min run
 * interval, provider, model and thinking) share: with `clear`, or an empty typed value, unset
 * `key` under `base`; else set it. `serialize` shapes the value `setConfigKey` stores (it
 * JSON-encodes nothing itself) and `display` gives the human phrase for the confirmation
 * line. The caller returns right after. The instructions branch keeps its own block: its
 * value is a file's text, so an empty value is a legitimate write, not a clear. */
function writeRoleConfigKey(
  root: string,
  base: string,
  clear: boolean,
  raw: string,
  key: string,
  noun: string,
  serialize: (value: string) => string,
  display: (value: string) => string,
): void {
  if (clear || raw.trim() === "") {
    const result = unsetConfigKey(root, key);
    if (!result.ok) fail(result.error);
    say(`${base}: ${noun} cleared`);
  } else {
    const result = setConfigKey(root, key, serialize(raw));
    if (!result.ok) fail(result.error);
    say(`${base}: ${noun} set to ${display(raw)}`);
  }
}

/** `tumwater role <id>`: one role's standing prompt and next tick's assembled prompt. */
export async function cmdRole(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate, like backlog: role-view degrades (missing state files →
  // fresh defaults, a missing queue directory an empty inbox), so the command inspects
  // a repo the team never started in — and a torn one — instead of refusing (a team
  // workspace still refuses).
  const { id: positional, rest } = peelRolePositional(args);
  rejectUnknownArgs("role", rest, [ROLE_FLAG, JSON_FLAG, CLEAR_NOTES_SPEC, NOTES_FILE_SPEC, CLEAR_INSTRUCTIONS_SPEC, INSTRUCTIONS_FILE_SPEC, CLEAR_QUIET_HOURS_SPEC, QUIET_HOURS_SPEC, ENABLE_SPEC, DISABLE_SPEC, CLEAR_CAP_SPEC, CAP_SPEC, CLEAR_MIN_RUN_INTERVAL_SPEC, MIN_RUN_INTERVAL_SPEC, CLEAR_INSTANCES_SPEC, INSTANCES_SPEC, CLEAR_PROVIDER_SPEC, PROVIDER_SPEC, CLEAR_MODEL_SPEC, MODEL_SPEC, CLEAR_THINKING_SPEC, THINKING_SPEC]);
  refuseTeamWorkspace(root);
  // The id is required: positional (`tumwater role <id>`) or --role <id> (the flag
  // spelling every other role-targeting command shares). Both at once is a mistake, not
  // a silent pick of one.
  const flagId = flagValue(rest, "--role") ?? null;
  const typedId = positional ?? flagId;
  if (!typedId) fail("tumwater role needs a role id");
  const id = canonicalRoleId(typedId);
  if (positional !== null && flagId !== null && flagId !== positional)
    fail("give the role id once — as the positional or as --role <id>, not both");
  const clear = rest.includes("--clear-notes");
  const notesFile = flagValue(rest, "--notes-file");
  const clearInst = rest.includes("--clear-instructions");
  const instFile = flagValue(rest, "--instructions-file");
  const clearQuiet = rest.includes("--clear-quiet-hours");
  const clearCap = rest.includes("--clear-cap");
  const clearInterval = rest.includes("--clear-min-run-interval");
  const clearInstances = rest.includes("--clear-instances");
  const clearProvider = rest.includes("--clear-provider");
  const clearModel = rest.includes("--clear-model");
  const clearThinking = rest.includes("--clear-thinking");
  const notesWrite = clear || rest.includes("--notes-file");
  const instructionsWrite = clearInst || rest.includes("--instructions-file");
  const quietWrite = clearQuiet || rest.includes("--quiet-hours");
  const capWrite = clearCap || rest.includes("--cap");
  const intervalWrite = clearInterval || rest.includes("--min-run-interval");
  const instancesWrite = clearInstances || rest.includes("--instances");
  const providerWrite = clearProvider || rest.includes("--provider");
  const modelWrite = clearModel || rest.includes("--model");
  const thinkingWrite = clearThinking || rest.includes("--thinking");
  const enable = rest.includes("--enable");
  const disable = rest.includes("--disable");
  const writes: string[] = [];
  if (notesWrite) writes.push("notes");
  if (instructionsWrite) writes.push("instructions");
  if (quietWrite) writes.push("quiet-hours");
  if (instancesWrite) writes.push("instances");
  if (capWrite) writes.push("cap");
  if (intervalWrite) writes.push("min-run-interval");
  if (providerWrite) writes.push("provider");
  if (modelWrite) writes.push("model");
  if (thinkingWrite) writes.push("thinking");
  if (enable) writes.push("enable");
  if (disable) writes.push("disable");
  if (writes.length > 1)
    fail(`${writes.join(" and ")} writes cannot share one invocation`);
  if (notesWrite) {
    if (clear && rest.includes("--notes-file")) fail("give --clear-notes or --notes-file, not both");
    if (rest.includes("--json")) fail("--json does not apply to a notes write");
    if (id === DIRECTOR_ROLE) fail("the director has no notes");
    requireKnownRole(root, id);
    const text = clear ? "" : readPromptFileArg(notesFile || fail("--notes-file needs a path"));
    try {
      say(`${id}: ${saveRoleNote(roleNotesPath(root, id), text)}`);
    } catch (err) {
      fail(errorMessage(err));
    }
    return;
  }
  // The instructions-override write: the file-shaped twin of the notes flags, but the value
  // lands in roles.<base>.instructions (run-prompt reads config.roles[base]) through the
  // same setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig
  // enforces the 4096-char cap and the write is atomic. The director is allowed here (its
  // override reaches its own runs), unlike the notes branch's director refusal.
  if (instructionsWrite) {
    if (clearInst && rest.includes("--instructions-file")) fail("give --clear-instructions or --instructions-file, not both");
    if (rest.includes("--json")) fail("--json does not apply to an instructions write");
    requireKnownRole(root, id);
    const base = baseRoleOf(id);
    if (clearInst) {
      const result = unsetConfigKey(root, `roles.${base}.instructions`);
      if (!result.ok) fail(result.error);
      say(`${base}: instructions cleared`);
    } else {
      const text = readPromptFileArg(instFile || fail("--instructions-file needs a path"));
      const result = setConfigKey(root, `roles.${base}.instructions`, JSON.stringify(text));
      if (!result.ok) fail(result.error);
      say(`${base}: instructions saved (${text.length} chars)`);
    }
    return;
  }
  // The quiet-hours write: the third write kind, the terminal twin of `config set
  // quietHoursPerRole.<base> <window>`. The window lands in quietHoursPerRole.<base> through
  // the same setConfigKey/unsetConfigKey core config set/unset use, so checkQuietHours (with
  // the typed key as its label) and validateConfig own validation and the write is atomic.
  // The director is exempt — its quietHoursPerRole.director entry is inert (the gate and
  // doctor both exempt it), like the notes branch's director refusal.
  if (quietWrite) {
    if (clearQuiet && rest.includes("--quiet-hours")) fail("give --clear-quiet-hours or --quiet-hours, not both");
    if (rest.includes("--json")) fail("--json does not apply to a quiet-hours write");
    requireKnownRole(root, id);
    if (id === DIRECTOR_ROLE) fail("the director has no quiet hours");
    const base = baseRoleOf(id);
    const window = flagValue(rest, "--quiet-hours") ?? "";
    writeRoleConfigKey(root, base, clearQuiet, window, `quietHoursPerRole.${base}`, "quiet hours", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  // The daily-cap write: the terminal twin of `config set maxDailyCostUsdPerRole.<base>
  // <usd>`, the two remaining per-role holds' write the dashboard and the TUI already own.
  // The value lands in maxDailyCostUsdPerRole.<base> through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so checkDailyBudgetUsd
  // (with the typed key as its label) and validateConfig own validation and the write is
  // atomic. The director is exempt — it has no cap, like the notes and quiet-hours branches'
  // director refusals.
  if (capWrite) {
    if (clearCap && rest.includes("--cap")) fail("give --clear-cap or --cap, not both");
    if (rest.includes("--json")) fail("--json does not apply to a cap write");
    requireKnownRole(root, id);
    if (id === DIRECTOR_ROLE) fail("the director has no daily cap");
    const base = baseRoleOf(id);
    const cap = flagValue(rest, "--cap") ?? "";
    writeRoleConfigKey(root, base, clearCap, cap, `maxDailyCostUsdPerRole.${base}`, "daily cap", (v) => v, (v) => v);
    return;
  }
  // The min-run-interval write: the terminal twin of `config set
  // roles.<base>.minRunIntervalSeconds <seconds>`, the fourth per-role hold's write. The
  // value lands in roles.<base>.minRunIntervalSeconds through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig's
  // roles.<id>.minRunIntervalSeconds DURATION_NON_NEGATIVE check owns validation and the
  // write is atomic. Unlike the notes/quiet-hours/cap branches there is no director refusal:
  // the director ticks on the same clock.
  if (intervalWrite) {
    if (clearInterval && rest.includes("--min-run-interval")) fail("give --clear-min-run-interval or --min-run-interval, not both");
    if (rest.includes("--json")) fail("--json does not apply to a min-run-interval write");
    requireKnownRole(root, id);
    const base = baseRoleOf(id);
    const secs = flagValue(rest, "--min-run-interval") ?? "";
    writeRoleConfigKey(root, base, clearInterval, secs, `roles.${base}.minRunIntervalSeconds`, "min run interval", (v) => v, (v) => `${v}s`);
    return;
  }
  // The instances write: the terminal twin of `config set roles.<base>.instances <n>`, the
  // last per-role hold's write. The count lands in roles.<base>.instances through the same
  // setConfigKey/unsetConfigKey core `config set`/`config unset` use, so validateConfig's
  // roles.<id>.instances INSTANCE_COUNT check owns the bound and the write is atomic. As
  // with min run interval there is no director (or non-instance-role) refusal of its own:
  // validateConfig's `!INSTANCE_ROLES.has(id)` branch answers for the director and every
  // custom role, and an unset/empty value clears the key.
  if (instancesWrite) {
    if (clearInstances && rest.includes("--instances")) fail("give --clear-instances or --instances, not both");
    if (rest.includes("--json")) fail("--json does not apply to an instances write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const n = flagValue(rest, "--instances") ?? "";
    writeRoleConfigKey(root, base, clearInstances, n, `roles.${base}.instances`, "instances", (v) => v, (v) => v);
    return;
  }
  // The model-triple writes: the terminal twins of `config set roles.<base>.provider|model|thinking
  // <value>` and `config unset` — the three fields configForRole resolves through seamOverrides.
  // `tumwater role <id>` renders them as its Model: line. Each lands in roles.<base>.<field>.
  // Through setConfigKey/unsetConfigKey, validateConfig's checkModelTripleField ("tier-name"
  // shape) owns validation (model accepts a tier name; thinking must be a THINKING_LEVELS level)
  // and each write is atomic. No director refusal: accepted exactly as --min-run-interval is.
  if (providerWrite) {
    if (clearProvider && rest.includes("--provider")) fail("give --clear-provider or --provider, not both");
    if (rest.includes("--json")) fail("--json does not apply to a provider write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const provider = flagValue(rest, "--provider") ?? "";
    writeRoleConfigKey(root, base, clearProvider, provider, `roles.${base}.provider`, "provider", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  if (modelWrite) {
    if (clearModel && rest.includes("--model")) fail("give --clear-model or --model, not both");
    if (rest.includes("--json")) fail("--json does not apply to a model write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const model = flagValue(rest, "--model") ?? "";
    writeRoleConfigKey(root, base, clearModel, model, `roles.${base}.model`, "model", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  if (thinkingWrite) {
    if (clearThinking && rest.includes("--thinking")) fail("give --clear-thinking or --thinking, not both");
    if (rest.includes("--json")) fail("--json does not apply to a thinking write");
    const cfg = loadConfigSafe(root).config ?? defaultConfig();
    if (!knownRoleIds(cfg).includes(id)) throw new Error(unknownRoleMessage(id, knownRoleIds(cfg)));
    const base = baseRoleOf(id);
    const level = flagValue(rest, "--thinking") ?? "";
    writeRoleConfigKey(root, base, clearThinking, level, `roles.${base}.thinking`, "thinking", (v) => JSON.stringify(v), (v) => v);
    return;
  }
  // The enable/disable write: the scoped write for the enabled state `tumwater role <id>`
  // already renders, the terminal twin of `config set roles.<base>.enabled true|false`. The
  // value lands in roles.<base>.enabled through the same setConfigKey core config set uses, so
  // validateConfig's checkBoolean (the roles.<id>. prefix) owns the type and the write stays
  // atomic and applies live. The director cannot be disabled: with it disabled runnerIds omits
  // it and no role dequeues the operator's inbox, so that refusal is explicit (enabling stays
  // allowed). knownRoleIds holds every catalog and custom role whether or not it is enabled, so
  // a currently-disabled id resolves; an instance id writes its base role's key. A role already
  // in the asked-for state is reported as such and the file is left alone.
  if (enable || disable) {
    if (rest.includes("--json")) fail("--json does not apply to an enable/disable write");
    requireKnownRole(root, id);
    if (disable && id === DIRECTOR_ROLE) fail("the director cannot be disabled");
    const base = baseRoleOf(id);
    const state = enable ? "enabled" : "disabled";
    if (loadConfigSafe(root).config?.roles[base]?.enabled === enable) {
      say(`${base}: already ${state}`);
      return;
    }
    const result = setConfigKey(root, `roles.${base}.enabled`, enable ? "true" : "false");
    if (!result.ok) fail(result.error);
    say(`${base}: ${state}`);
    return;
  }
  // The unknown-role answer (exit 1, unknownRoleMessage's wording) lives in the
  // collector; here the id just has to be non-null for the thunk's types.
  sayJsonOrRender(rest, () => rolePayload(root, id), renderRoleMarkdown);
}
