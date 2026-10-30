#!/usr/bin/env node
/** The CLI's entry point and command dispatcher — the `bin` target package.json points at
 * (dist/src/cli.js). main() runs the Node-floor gate from package.json's `engines.node`, answers a
 * `--help` topic before any command parses arguments or gates on a ready repo, resolves the repo
 * root from cwd (repoToplevel, falling back to cwd outside a repository), and dispatches the
 * command token. Every command imports its own module lazily, inside its case: the dispatcher
 * statically loads only the argument parsing, output, repo gate and help it shares, so
 * `tumwater report` never pays for the orchestrator or ink, and `tumwater logs` never pays for
 * the status collectors. A process that starts, runs one command and exits (the CLI as the
 * team's agents and the test suite call it, ~700 spawns a suite run) otherwise compiled all
 * 169 modules every time. The work itself lives in the command
 * modules; this file owns the shared sequence, including each case's flag rejection and its
 * ready-repo gate. An error escaping main() funnels through its catch to fail(errorMessage(err)),
 * the CLI's one error path. */
import { parseCountFlag, parseGrepFlag, parseModelFlag, parseResultFlag } from "./cli/cli-args.js";
import type { LiftableHold } from "./backlog/backlog-release.js";
import type { FiledEntry } from "./backlog/backlog-write.js";
import {
  grepFlagSpec,
  GUI_FLAG_SPECS,
  JSON_FLAG,
  LAST_FLAG,
  N_FLAG,
  rejectUnknownArgs,
  resultFlagSpec,
  modelFlagSpec,
  byFlagSpec,
  LOGS_TRANSCRIPT_FLAG,
  ROLE_FLAG,
  START_FLAG_SPECS,
  sinceFlagSpec,
  untilFlagSpec,
  STAT_FLAG,
  PATCH_FLAG,
  PROMPT_FLAG,
  TRANSCRIPT_FLAG,
  SUMMARY_FLAG,
  COUNT_FLAG,
  NOTABLE_FLAG,
  typeFlagSpec,
  DRY_RUN_FLAG,
  FORCE_FLAG,
  FOLLOW_FLAG,
  STOP_CANCEL_FLAG,
  STOP_IN_FLAG,
} from "./cli/cli-flag-specs.js";
import { fail, say } from "./cli/cli-output.js";
import { historyTrailForm, parsePromptArgs, peelPositionals } from "./cli/cli-command-args.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli/cli-repo-gate.js";
import { repoToplevel } from "./git/git.js";

import { didYouMean } from "./text/suggest.js";
import { errorMessage, gotSuffix, stripTerminalControls } from "./text/text.js";
import { typoSuffix } from "./text/suggest.js";
import { HELP, helpTopic, helpTopicForArgs, suggestCommand } from "./cli/help.js";
import { PACKAGE_JSON, nodeFloorProblem, packageEnginesNode, packageVersion } from "./version.js";

// The CLI's help text and its per-command topic parser live in help.ts — importing cli.ts
// would run main(), so tests pin the topics against help.ts directly.

/** One run's trail, shared by `history <role> <n>` and its hidden alias `tick` so the two cannot
 * drift. Positional-first: the <role> <n> tokens peel off and the remaining flags go through
 * rejectUnknownArgs (only --json, --last, --stat, --patch, --transcript, --prompt, --grep,
 * --result, --model), so a listing flag such as --role is refused.
 * Arity is gated before the ready-repo check so a malformed call fails with its usage in any
 * directory; cmdRunDetail owns the value validation and the --last/numbered rivals. */
async function runTrailCommand(root: string, args: string[]): Promise<void> {
  const { cmdRunDetail, RUN_DETAIL_USAGE } = await import("./run/run-detail.js");
  const { HISTORY_GREP_VALUE_ERROR, HISTORY_RESULT_VALUE_ERROR, HISTORY_MODEL_VALUE_ERROR } = await import("./history/history.js");
  // parseGrepFlag removes the pattern token, so `--grep two` cannot read "two" as a positional.
  const { rest: ungrepped, pattern: grep } = parseGrepFlag(args, HISTORY_GREP_VALUE_ERROR);
  const { rest: unresulted, raw: result } = parseResultFlag(ungrepped, HISTORY_RESULT_VALUE_ERROR);
  const { rest: unmodeled, raw: model } = parseModelFlag(unresulted, HISTORY_MODEL_VALUE_ERROR);
  const { positionals, rest } = peelPositionals(unmodeled);
  rejectUnknownArgs("history", rest, [JSON_FLAG, LAST_FLAG, STAT_FLAG, PATCH_FLAG, TRANSCRIPT_FLAG, PROMPT_FLAG, { names: ["--grep"] }, { names: ["--result"] }, { names: ["--model"] }]);
  if ((positionals.length < 1 && !rest.includes("--last")) || positionals.length > 2) fail(`usage: ${RUN_DETAIL_USAGE}`);
  await requireReadyRepo(root);
  await cmdRunDetail(root, positionals, rest.includes("--json"), {
    last: rest.includes("--last"),
    stat: rest.includes("--stat"),
    patch: rest.includes("--patch"),
    transcript: rest.includes("--transcript"),
    prompt: rest.includes("--prompt"),
    grep,
    result,
    model,
  });
}

async function cmdStartCase(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("start", args, START_FLAG_SPECS);
  await (await import("./cli/cli-start.js")).cmdStart(root, args);
}

async function cmdTuiCase(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("tui", args, []);
  await requireReadyRepo(root);
  // Imported lazily: the TUI module pulls in ink (the one runtime dependency the
  // tree carries), and an install whose node_modules is absent must still reach
  // every other command's own broken-install reporting instead of dying on import.
  const { runTui } = await import("./ui/tui/tui.js");
  await runTui(root);
}

async function cmdGuiCase(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("gui", args, GUI_FLAG_SPECS);
  await requireReadyRepo(root);
  await (await import("./gui/gui-command.js")).cmdGui(root, args);
}

async function cmdConfigCase(root: string, args: string[]): Promise<void> {
  const { cmdConfig, CONFIG_USAGE } = await import("./cli/cli-config-commands.js");
  // Subcommand arity before the ready-repo gate, so a malformed get/set fails with its
  // usage no matter the directory: bare config takes nothing, `get`/`unset` exactly one
  // key, `set` exactly a key and a value. cmdConfig dispatches on the (now well-shaped)
  // args.
  if (args.length > 0) {
    if (args[0] !== "get" && args[0] !== "set" && args[0] !== "unset")
      // A near-miss subcommand word gets the same typoSuffix `completion <shell>` and
      // `logs --type` give, so `config gte` reads "did you mean `get`?" while a far-off
      // word (`show`) and a flag (`--anything`) stay hint-free.
      fail(`${CONFIG_USAGE}${typoSuffix(args[0] ?? "", ["get", "set", "unset"])}`);
    if (args[0] === "get" && args.length !== 2) fail("usage: tumwater config get <key>");
    if (args[0] === "set" && args.length !== 3) fail("usage: tumwater config set <key> <value>");
    if (args[0] === "unset" && args.length !== 2) fail("usage: tumwater config unset <key>");
  }
  // An initialized repo always has tumwater.json, so this gate doubles as "a config
  // exists to print" — the command never runs outside a project.
  await requireReadyRepo(root);
  await cmdConfig(root, args);
}

async function cmdReportCase(root: string, args: string[]): Promise<void> {
  // No requireReadyRepo gate: the report aggregates files that degrade to zeros when
  // missing, so it runs (and prints an all-zero window) in any directory; the team-workspace
  // refusal still applies.
  rejectUnknownArgs("report", args, [
    {
      names: ["--days"],
      value: true,
      valueName: "<n>",
      // The gate's early report re-runs cmdReport's own shape parser (report.ts), so
      // `report --days abc` names the typo even though report has no ready-repo gate.
      validate: (value) => {
        parseCountFlag("--days", value);
      },
    },
    { names: ["--failures"] },
    sinceFlagSpec("report --since"),
    untilFlagSpec("report --until"),
    JSON_FLAG,
    ROLE_FLAG,
    FOLLOW_FLAG,
  ]);
  refuseTeamWorkspace(root);
  // --since is handled before the day-shape reads: it is a rival shape (totals over a
  // trailing window vs a series over whole days), not a modifier of either.
  await (await import("./report/report.js")).cmdReport(root, args);
}

async function cmdDoctorCase(root: string, args: string[]): Promise<void> {
  // cmdDoctor lives in cli-doctor-command.ts (the doctor command body, its side-effect
  // wrappers and payload shaping) and holds no ready-repo gate: doctor's job is to report
  // WHY the environment isn't ready, so it must run outside a git repo and print fail
  // lines rather than throwing. Imported lazily like every command body, so the doctor
  // subgraph is only compiled when `tumwater doctor` is asked for.
  await (await import("./cli/cli-doctor-command.js")).cmdDoctor(root, args);
}

async function cmdLogsCase(root: string, args: string[]): Promise<void> {
  const { cmdLogs, GREP_VALUE_ERROR, TYPE_VALUE_ERROR } = await import("./cli/cli-log-commands.js");
  rejectUnknownArgs("logs", args, [
    FOLLOW_FLAG,
    N_FLAG,
    sinceFlagSpec("logs --since"),
    untilFlagSpec("logs --until"),
    grepFlagSpec(GREP_VALUE_ERROR),
    typeFlagSpec(TYPE_VALUE_ERROR),
    JSON_FLAG,
    COUNT_FLAG,
    NOTABLE_FLAG,
    ROLE_FLAG,
    LOGS_TRANSCRIPT_FLAG,
    PROMPT_FLAG,
  ]);
  await requireReadyRepo(root);
  await cmdLogs(root, args);
}

async function cmdNotifyCase(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("notify", args, [{ names: ["--test"] }]);
  await requireReadyRepo(root);
  await (await import("./cli/cli-notify-command.js")).cmdNotify(root, args);
}

async function cmdHistoryCase(root: string, args: string[]): Promise<void> {
  const { cmdHistory, HISTORY_GREP_VALUE_ERROR, HISTORY_RESULT_VALUE_ERROR, HISTORY_MODEL_VALUE_ERROR, HISTORY_BY_VALUE_ERROR } = await import("./history/history.js");
  if (historyTrailForm(args)) {
    await runTrailCommand(root, args);
    return;
  }
  rejectUnknownArgs("history", args, [
    N_FLAG,
    FOLLOW_FLAG,
    sinceFlagSpec("history --since"),
    untilFlagSpec("history --until"),
    grepFlagSpec(HISTORY_GREP_VALUE_ERROR),
    resultFlagSpec(HISTORY_RESULT_VALUE_ERROR),
    modelFlagSpec(HISTORY_MODEL_VALUE_ERROR),
    byFlagSpec(HISTORY_BY_VALUE_ERROR),
    JSON_FLAG,
    ROLE_FLAG,
    SUMMARY_FLAG,
  ]);
  await requireReadyRepo(root);
  await cmdHistory(root, args);
}

async function cmdArchiveCase(root: string, args: string[]): Promise<void> {
  rejectUnknownArgs("archive", args, [JSON_FLAG]);
  await requireReadyRepo(root);
  await (await import("./backlog/backlog-cli.js")).cmdArchive(root, args);
}

/** The `bug` and `plan` argument shells are identical — the same --show/--list/--edit/
 * --cancel/--top/--release/default dispatch, each branch delegating to the shared *AndAnnounce
 * shell (backlog-cli.ts) with only the per-kind callbacks and file/section names differing. One
 * spec groups those differences so a kind never spells the dispatch out again, and a flag added
 * to both cannot drift between the two cases. The dispatch's AndAnnounce shells are imported
 * lazily here (not at cli.ts top level), preserving the per-command lazy loading every case
 * follows. */
interface BacklogCommandSpec {
  command: "bug" | "plan";
  usage: string;
  file: string;
  section: string;
  edit: (n: number, positionals: string[]) => { file: string; title: string; unchanged?: true };
  editText: (n: number, text: string) => { file: string; title: string; unchanged?: true };
  cancel: (n: number) => { file: string; title: string };
  top: (n: number) => { file: string; title: string };
  release: (n: number) => { file: string; title: string; lifted: LiftableHold };
  releaseRole: string;
  fileOp: (positionals: string[]) => FiledEntry;
  fileText: (text: string) => FiledEntry;
  wakeText: (title: string) => string;
  titleOf: (positionals: string[]) => string;
}

/** The one dispatch `bug` and `plan` both run through (see BacklogCommandSpec): route on the
 * leading flag token and hand off to the matching shared AndAnnounce shell, or file a text
 * entry by default. */
async function runBacklogCommand(root: string, args: string[], s: BacklogCommandSpec): Promise<void> {
  const { cancelAndAnnounce, editAndAnnounce, fileAndAnnounce, releaseAndAnnounce, topAndAnnounce } =
    await import("./backlog/backlog-cli.js");
  const { listAndAnnounce, showAndAnnounce } = await import("./backlog/backlog-cli-view.js");
  if (args.includes("--show")) {
    showAndAnnounce(root, args, s.command);
    return;
  }
  if (args.includes("--list")) {
    listAndAnnounce(root, args, s.command, s.file, s.section);
    return;
  }
  if (args.includes("--edit")) {
    await editAndAnnounce(root, args, s.command, s.edit, s.editText);
    return;
  }
  if (args.includes("--cancel")) {
    await cancelAndAnnounce(root, args, s.command, s.cancel);
    return;
  }
  if (args.includes("--top")) {
    await topAndAnnounce(root, args, s.command, s.top);
    return;
  }
  if (args.includes("--release")) {
    await releaseAndAnnounce(root, args, s.command, s.release, s.releaseRole);
    return;
  }
  await fileAndAnnounce(root, args, s.command, s.fileOp, s.releaseRole, s.wakeText, s.titleOf, s.fileText);
}

async function cmdBugCase(root: string, args: string[]): Promise<void> {
  const { OPERATOR_FILE_KINDS, bugWakeText, cancelBug, editBug, editBugFromText, fileBug, fileBugFromText } =
    await import("./backlog/backlog-write.js");
  const { moveEntryToTop, releaseEntry } = await import("./backlog/backlog-release.js");
  const { bugTitleOf } = await import("./backlog/backlog-cli.js");
  const usage = 'tumwater bug "<symptom>"';
  await runBacklogCommand(root, args, {
    command: "bug",
    usage,
    file: "BUGS.md",
    section: "Open",
    edit: (n, positionals) => editBug(root, n, positionals.join(" "), usage),
    editText: (n, text) => editBugFromText(root, n, text, usage),
    cancel: (n) => cancelBug(root, n),
    top: (n) => moveEntryToTop(root, "bug", n),
    release: (n) => releaseEntry(root, "bug", n),
    releaseRole: OPERATOR_FILE_KINDS.bug.role,
    fileOp: (positionals) => fileBug(root, positionals.join(" "), usage),
    fileText: (text) => fileBugFromText(root, text, usage),
    wakeText: bugWakeText,
    titleOf: bugTitleOf,
  });
}

async function cmdPlanCase(root: string, args: string[]): Promise<void> {
  const { OPERATOR_FILE_KINDS, cancelPlan, editPlan, editPlanFromText, filePlan, filePlanFromText, planWakeText } =
    await import("./backlog/backlog-write.js");
  const { moveEntryToTop, releaseEntry } = await import("./backlog/backlog-release.js");
  const { planTitleOf } = await import("./backlog/backlog-cli.js");
  const usage = 'tumwater plan "<title>" [body...]';
  await runBacklogCommand(root, args, {
    command: "plan",
    usage,
    file: "PLANS.md",
    section: "Planned",
    edit: (n, positionals) => editPlan(root, n, positionals[0] ?? "", positionals.slice(1).join(" "), usage),
    editText: (n, text) => editPlanFromText(root, n, text, usage),
    cancel: (n) => cancelPlan(root, n),
    top: (n) => moveEntryToTop(root, "plan", n),
    release: (n) => releaseEntry(root, "plan", n),
    releaseRole: OPERATOR_FILE_KINDS.plan.role,
    fileOp: (positionals) => filePlan(root, positionals[0] ?? "", positionals.slice(1).join(" "), usage),
    fileText: (text) => filePlanFromText(root, text, usage),
    wakeText: planWakeText,
    titleOf: planTitleOf,
  });
}

async function cmdPromptCase(root: string, args: string[]): Promise<void> {
  // Parse before the gate: prompt's positionals are free-form, so rejectUnknownArgs
  // cannot run here, and without this pre-parse `tumwater prompt --role` outside an
  // initialized repo would report "not a git repository" instead of the flag error —
  // the same masking every other command's spec-based missing-value check avoids.
  // cmdPrompt re-running the parse below cannot drift from what this pre-parse accepted,
  // and --file's reads are idempotent across the two parses (a file is re-read; the
  // stdin read is memoized in cli/cli-command-args.ts, so a drained pipe is not re-read
  // as an empty prompt).
  parsePromptArgs(args);
  await requireReadyRepo(root);
  await (await import("./inbox/prompt-commands.js")).cmdPrompt(root, args);
}

async function cmdRetireCase(root: string, args: string[]): Promise<void> {
  // Not a marker command (it acts immediately, not via a request file), but it shares the
  // marker commands' gate shape: unknown-args rejection, then the ready-repo gate.
  rejectUnknownArgs("retire", args, [ROLE_FLAG, FORCE_FLAG, DRY_RUN_FLAG, JSON_FLAG]);
  await requireReadyRepo(root);
  await (await import("./operator/operator-commands.js")).cmdRetire(root, args);
}

async function cmdRevertCase(root: string, args: string[]): Promise<void> {
  // Acts immediately on the primary checkout under the primary-worktree lock; the
  // positionals (a sha, or a run) are validated inside cmdRevert.
  await requireReadyRepo(root);
  await (await import("./operator/operator-commands.js")).cmdRevert(root, args);
}

async function cmdStopCase(root: string, args: string[]): Promise<void> {
  // Bare stop signals the recorded orchestrator pid; `--in`/`--cancel` schedule or drop a
  // deferred stop. Anything else is a mistake and fails before a signal is ever sent.
  rejectUnknownArgs("stop", args, [STOP_IN_FLAG, STOP_CANCEL_FLAG]);
  await requireReadyRepo(root);
  await (await import("./operator/operator-commands.js")).cmdStop(root, args);
}


async function cmdVersionCase(args: string[]): Promise<void> {
  // A stray flag fails like every other command's: `tumwater version --json` (a plausible
  // slip from `status --json`) must not print a version as if it had answered the query.
  rejectUnknownArgs("version", args, []);
  // The read lives in version.ts (testable; cli.ts runs main() on import). A broken
  // install — a missing or malformed package.json — fails with the reason instead of a
  // raw stack trace, and a non-string version fails instead of printing "undefined".
  const { version, problem } = packageVersion(PACKAGE_JSON);
  if (problem !== undefined || version === undefined)
    fail(problem ?? "package.json carries no version field (the running tumwater install looks broken)");
  say(version);
}

async function cmdHelpCase(args: string[]): Promise<void> {
  // `help <command>` prints that command's usage stanza(s), parsed from the same text the
  // full listing prints, so a topic cannot drift from it; a bare `help` (or an unknown
  // topic) points back at the full list rather than pretending the token was answered.
  if (args.length > 1) fail(`help takes at most one command name${gotSuffix(args[1])}`);
  if (args.length === 1) {
    const name = args[0] ?? "";
    const topic = helpTopic(name);
    if (topic === null) {
      const suggestion = suggestCommand(name);
      fail(
        `no help topic: ${JSON.stringify(name)}${didYouMean(suggestion)} (try \`tumwater help\` for the full command list)`,
      );
    }
    say(topic);
  } else {
    process.stdout.write(HELP);
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  // The Node-floor gate, before any command does work: package.json's engines spec is the
  // declared minimum, and a runtime below it fails with the fix instead of whatever the
  // first unsupported API call happens to throw. A floor the package read cannot supply
  // (a broken install) stands down rather than blocking every command on a value it
  // cannot evaluate — packageEnginesNode's rationale, not the version command's job here.
  const floor = packageEnginesNode(PACKAGE_JSON);
  if (floor !== null) {
    const problem = nodeFloorProblem(process.versions.node, floor);
    if (problem !== undefined) fail(problem);
  }
  // `tumwater <command> --help` (or `-h`) prints that command's help topic — the same text
  // `tumwater help <command>` derives from the full listing — and exits 0, before any command
  // parses its arguments or gates on a ready repo. help.ts's helpTopicForArgs owns which
  // invocations count as a request (a free-form command's prose makes an embedded --help
  // content, not a request) and returns null when this one should dispatch normally.
  const topic = helpTopicForArgs(command, args);
  if (topic !== null) {
    say(topic);
    return;
  }
  // The repo root, not the cwd: every command must behave identically from any subdirectory
  // of the repo it targets (.tumwater/ and tumwater.json live at the toplevel, and
  // readBranchHead's ref-file fast path needs a root that actually holds .git). Outside a
  // repository the probe fails and cwd is used as before, so doctor outside a repo still
  // reports why the environment is not ready.
  const root = (await repoToplevel(process.cwd())) ?? process.cwd();
  switch (command) {
    case "init":
      // Imported lazily: cli/cli-start.ts pulls the whole team-booting subgraph (orchestrator,
      // supervisor, redeploy, launch-services — the run path's machinery), and every other
      // command's spawn pays module compilation for it unless the dispatch defers that load
      // to the commands that actually boot or serve a team. cli-init.ts stays light for init.
      await (await import("./cli/cli-init.js")).cmdInit(root, args);
      break;
    case "start":
    case "run":
      await cmdStartCase(root, args);
      break;
    case "tui":
      await cmdTuiCase(root, args);
      break;
    case "gui":
      await cmdGuiCase(root, args);
      break;
    case "status":
      await (await import("./cli/cli-query-commands.js")).cmdStatus(root, args);
      break;
    case "config": {
      await cmdConfigCase(root, args);
      break;
    }
    case "report": {
      await cmdReportCase(root, args);
      break;
    }
    case "doctor": {
      await cmdDoctorCase(root, args);
      break;
    }
    case "logs": {
      await cmdLogsCase(root, args);
      break;
    }
    case "notify":
      await cmdNotifyCase(root, args);
      break;
    case "history": {
      await cmdHistoryCase(root, args);
      break;
    }
    case "tick": // vocabulary-ok: command name stays
      await runTrailCommand(root, args);
      break;
    case "diff":
      await (await import("./cli/cli-query-commands.js")).cmdDiff(root, args);
      break;
    case "queue":
      await (await import("./cli/cli-query-commands.js")).cmdQueue(root, args);
      break;
    case "reviews":
      await (await import("./cli/cli-review-commands.js")).cmdReviews(root, args);
      break;
    case "backlog":
      await (await import("./cli/cli-query-commands.js")).cmdBacklog(root, args);
      break;
    case "quarantine":
      await (await import("./cli/cli-query-commands.js")).cmdQuarantine(root, args);
      break;
    case "archive":
      await cmdArchiveCase(root, args);
      break;
    case "bug": {
      await cmdBugCase(root, args);
      break;
    }
    case "plan": {
      await cmdPlanCase(root, args);
      break;
    }
    case "questions":
      await (await import("./cli/cli-question-commands.js")).cmdQuestions(root, args);
      break;
    case "brief":
      await (await import("./cli/cli-brief-command.js")).cmdBrief(root, args);
      break;
    case "role":
      await (await import("./cli/cli-role-command.js")).cmdRole(root, args);
      break;
    case "prompt":
      await cmdPromptCase(root, args);
      break;
    case "reset-counters":
    // Fall through: the seven marker commands share one guard+dispatch shape — unknown-args
    // rejection against the command's flag set, the ready-repo gate, then the
    // operator-commands core — so runMarkerCommand holds it once instead of seven copies
    // drifting. The case labels here are exactly MarkerCommand's members, which is what
    // makes the cast below exhaustive.
    case "wake":
    case "abort":
    case "pause":
    case "resume":
    case "reclaim":
    case "restart": {
      await (await import("./cli/cli-marker-commands.js")).runMarkerCommand(root, command, args);
      break;
    }
    case "retire": {
      await cmdRetireCase(root, args);
      break;
    }
    case "revert": {
      await cmdRevertCase(root, args);
      break;
    }
    case "stop": {
      await cmdStopCase(root, args);
      break;
    }
    case "completion": {
      // Works outside a repo (no requireReadyRepo): the body lives in
      // cli-completion-command.ts, beside its data (src/cli/completion.ts), and is imported
      // lazily like every command body so the dispatcher never compiles the completion
      // subgraph until `tumwater completion` is asked for.
      await (await import("./cli/cli-completion-command.js")).cmdCompletion(root, args);
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      await cmdVersionCase(args);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined: {
      await cmdHelpCase(args);
      break;
    }
    default: {
      const suggestion = suggestCommand(command);
      fail(
        `unknown command: ${JSON.stringify(command)}${didYouMean(suggestion)} (try \`tumwater help\`)`,
      );
    }
  }
}

main().catch((err: unknown) => {
  // An error reaches this catch when a command body throws it, rather than reporting through
  // fail() like the arg parsers and the repo gate do. Its message is what the operator needs,
  // but a genuine bug's stack is the only clue to where it was thrown, and fail() below drops
  // it. TUMWATER_DEBUG (a developer aid, not a supported feature) echoes the stack first,
  // through the same terminal-control strip fail() applies so a value in the trace cannot
  // drive the terminal.
  if (process.env.TUMWATER_DEBUG && err instanceof Error && err.stack)
    process.stderr.write(stripTerminalControls(err.stack) + "\n");
  fail(errorMessage(err));
});
