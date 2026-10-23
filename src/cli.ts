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
import type { OrphanKillReport } from "./doctor/doctor-orphans.js";
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
  typeFlagSpec,
  DRY_RUN_FLAG,
  FORCE_FLAG,
  FOLLOW_FLAG,
  STOP_CANCEL_FLAG,
  STOP_IN_FLAG,
  REPROBE_FLAG,
  PROBLEMS_FLAG,
  KILL_ORPHANS_FLAG,
} from "./cli/cli-flag-specs.js";
import { fail, say, sayJsonOrRender } from "./cli/cli-output.js";
import { historyTrailForm, parseDoctorChecks, parsePromptArgs, peelPositionals } from "./cli/cli-command-args.js";
import { refuseTeamWorkspace, requireReadyRepo } from "./cli/cli-repo-gate.js";
import { repoToplevel } from "./git/git.js";

import { didYouMean } from "./text/suggest.js";
import { errorMessage, gotSuffix, stripTerminalControls } from "./text/text.js";
import { typoSuffix } from "./text/suggest.js";
import { completionConfigKeys, completionModels, completionRoleIds, completionScript, SUPPORTED_SHELLS, type CompletionShell } from "./cli/completion.js";
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
      rejectUnknownArgs("start", args, START_FLAG_SPECS);
      await (await import("./cli/cli-start.js")).cmdStart(root, args);
      break;
    case "tui":
      rejectUnknownArgs("tui", args, []);
      await requireReadyRepo(root);
      // Imported lazily: the TUI module pulls in ink (the one runtime dependency the
      // tree carries), and an install whose node_modules is absent must still reach
      // every other command's own broken-install reporting instead of dying on import.
      const { runTui } = await import("./ui/tui/tui.js");
      await runTui(root);
      break;
    case "gui":
      rejectUnknownArgs("gui", args, GUI_FLAG_SPECS);
      await requireReadyRepo(root);
      await (await import("./gui/gui-command.js")).cmdGui(root, args);
      break;
    case "status":
      await (await import("./cli/cli-query-commands.js")).cmdStatus(root, args);
      break;
    case "config": {
      const { cmdConfig, CONFIG_USAGE } = await import("./cli/config-commands.js");
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
      break;
    }
    case "report": {
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
      break;
    }
    case "doctor": {
      // No requireReadyRepo gate: doctor's job is to report WHY the environment isn't ready,
      // so it must run outside a git repo and print fail lines rather than throwing.
      const { positionals: checkNames, rest: doctorFlags } = peelPositionals(args);
      rejectUnknownArgs("doctor", doctorFlags, [JSON_FLAG, REPROBE_FLAG, PROBLEMS_FLAG, KILL_ORPHANS_FLAG]);
      const only = parseDoctorChecks(checkNames);
      const { runDoctor } = await import("./doctor/doctor.js");
      let orphanKill: OrphanKillReport | undefined;
      if (args.includes("--kill-orphans")) {
        const { killOrphans, orphanKillLines } = await import("./doctor/doctor-orphans.js");
        orphanKill = await killOrphans(root);
        // The text form prints the kill before the report; --json keeps stdout one document.
        if (!args.includes("--json")) {
          for (const line of orphanKillLines(orphanKill)) say(line);
          say("");
        }
      }
      const { renderDoctor, renderDoctorProblems, problemsOnly } = await import(
        "./doctor/doctor-render.js"
      );
      // The terminal probes unclaimed-verified models by default (7-day cache); --reprobe
      // forces every claimed model. The TUI/GUI call runDoctor with the default "never", so a
      // refresh never spends a model call.
      const probeImages = args.includes("--reprobe") ? "all" : "missing";
      const report = await runDoctor(root, undefined, undefined, probeImages, only);
      // --json prints the collector's own payload (the DoctorReport object), not a re-parse of
      // the render — the `report --json` precedent. The exit-code contract below holds in both
      // forms: 1 when any check fails, 0 otherwise; warnings never fail the exit.
      // --problems keeps the full report for the render (it counts the hidden ok rows) and
      // hands --json the filtered one; the exit code below reads the full report either way.
      // --kill-orphans adds the kill result to the JSON object as `orphanKill`.
      const withKill = <T extends object>(payload: T) => (orphanKill === undefined ? payload : { ...payload, orphanKill });
      if (args.includes("--problems"))
        sayJsonOrRender(args, args.includes("--json") ? withKill(problemsOnly(report)) : report, renderDoctorProblems);
      else sayJsonOrRender(args, args.includes("--json") ? withKill(report) : report, renderDoctor);
      if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1; // Warnings never fail the exit.
      break;
    }
    case "logs": {
      const { cmdLogs, GREP_VALUE_ERROR, TYPE_VALUE_ERROR } = await import("./cli/log-commands.js");
      rejectUnknownArgs("logs", args, [
        FOLLOW_FLAG,
        N_FLAG,
        sinceFlagSpec("logs --since"),
        untilFlagSpec("logs --until"),
        grepFlagSpec(GREP_VALUE_ERROR),
        typeFlagSpec(TYPE_VALUE_ERROR),
        JSON_FLAG,
        COUNT_FLAG,
        ROLE_FLAG,
        LOGS_TRANSCRIPT_FLAG,
        PROMPT_FLAG,
      ]);
      await requireReadyRepo(root);
      await cmdLogs(root, args);
      break;
    }
    case "notify":
      rejectUnknownArgs("notify", args, [{ names: ["--test"] }]);
      await requireReadyRepo(root);
      await (await import("./cli/notify-command.js")).cmdNotify(root, args);
      break;
    case "history": {
      const { cmdHistory, HISTORY_GREP_VALUE_ERROR, HISTORY_RESULT_VALUE_ERROR, HISTORY_MODEL_VALUE_ERROR, HISTORY_BY_VALUE_ERROR } = await import("./history/history.js");
      if (historyTrailForm(args)) {
        await runTrailCommand(root, args);
        break;
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
    case "backlog":
      await (await import("./cli/cli-query-commands.js")).cmdBacklog(root, args);
      break;
    case "archive":
      rejectUnknownArgs("archive", args, [JSON_FLAG]);
      await requireReadyRepo(root);
      await (await import("./backlog/backlog-cli.js")).cmdArchive(root, args);
      break;
    case "bug": {
      const { OPERATOR_FILE_KINDS, bugWakeText, cancelBug, editBug, editBugFromText, fileBug, fileBugFromText } =
        await import("./backlog/backlog-write.js");
      const { moveEntryToTop, releaseEntry } = await import("./backlog/backlog-release.js");
      const { bugTitleOf, cancelAndAnnounce, releaseAndAnnounce, topAndAnnounce, editAndAnnounce, fileAndAnnounce } =
        await import("./backlog/backlog-cli.js");
      const { listAndAnnounce, showAndAnnounce } = await import("./backlog/backlog-cli-view.js");
      const usage = 'tumwater bug "<symptom>"';
      if (args.includes("--show")) {
        showAndAnnounce(root, args, "bug");
        break;
      }
      if (args.includes("--list")) {
        listAndAnnounce(root, args, "bug", "BUGS.md", "Open");
        break;
      }
      if (args.includes("--edit")) {
        await editAndAnnounce(root, args, "bug", (n, positionals) => editBug(root, n, positionals.join(" "), usage), (n, text) =>
          editBugFromText(root, n, text, usage),
        );
        break;
      }
      if (args.includes("--cancel")) {
        await cancelAndAnnounce(root, args, "bug", (n) => cancelBug(root, n));
        break;
      }
      if (args.includes("--top")) {
        await topAndAnnounce(root, args, "bug", (n) => moveEntryToTop(root, "bug", n));
        break;
      }
      if (args.includes("--release")) {
        await releaseAndAnnounce(root, args, "bug", (n) => releaseEntry(root, "bug", n), OPERATOR_FILE_KINDS.bug.role);
        break;
      }
      await fileAndAnnounce(
        root,
        args,
        "bug",
        (positionals) => fileBug(root, positionals.join(" "), usage),
        OPERATOR_FILE_KINDS.bug.role,
        bugWakeText,
        bugTitleOf,
        (text) => fileBugFromText(root, text, usage),
      );
      break;
    }
    case "plan": {
      const { OPERATOR_FILE_KINDS, cancelPlan, editPlan, editPlanFromText, filePlan, filePlanFromText, planWakeText } =
        await import("./backlog/backlog-write.js");
      const { moveEntryToTop, releaseEntry } = await import("./backlog/backlog-release.js");
      const { cancelAndAnnounce, releaseAndAnnounce, topAndAnnounce, editAndAnnounce, fileAndAnnounce, planTitleOf } =
        await import("./backlog/backlog-cli.js");
      const { listAndAnnounce, showAndAnnounce } = await import("./backlog/backlog-cli-view.js");
      const usage = 'tumwater plan "<title>" [body...]';
      if (args.includes("--show")) {
        showAndAnnounce(root, args, "plan");
        break;
      }
      if (args.includes("--list")) {
        listAndAnnounce(root, args, "plan", "PLANS.md", "Planned");
        break;
      }
      if (args.includes("--edit")) {
        await editAndAnnounce(root, args, "plan", (n, positionals) =>
          editPlan(root, n, positionals[0] ?? "", positionals.slice(1).join(" "), usage),
        (n, text) => editPlanFromText(root, n, text, usage),
        );
        break;
      }
      if (args.includes("--cancel")) {
        await cancelAndAnnounce(root, args, "plan", (n) => cancelPlan(root, n));
        break;
      }
      if (args.includes("--top")) {
        await topAndAnnounce(root, args, "plan", (n) => moveEntryToTop(root, "plan", n));
        break;
      }
      if (args.includes("--release")) {
        await releaseAndAnnounce(root, args, "plan", (n) => releaseEntry(root, "plan", n), OPERATOR_FILE_KINDS.plan.role);
        break;
      }
      await fileAndAnnounce(
        root,
        args,
        "plan",
        (positionals) => filePlan(root, positionals[0] ?? "", positionals.slice(1).join(" "), usage),
        OPERATOR_FILE_KINDS.plan.role,
        planWakeText,
        planTitleOf,
        (text) => filePlanFromText(root, text, usage),
      );
      break;
    }
    case "questions":
      await (await import("./cli/question-commands.js")).cmdQuestions(root, args);
      break;
    case "brief":
      await (await import("./cli/brief-command.js")).cmdBrief(root, args);
      break;
    case "role":
      await (await import("./cli/cli-query-commands.js")).cmdRole(root, args);
      break;
    case "prompt":
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
      // Not a marker command (it acts immediately, not via a request file), but it shares the
      // marker commands' gate shape: unknown-args rejection, then the ready-repo gate.
      rejectUnknownArgs("retire", args, [ROLE_FLAG, FORCE_FLAG, DRY_RUN_FLAG, JSON_FLAG]);
      await requireReadyRepo(root);
      await (await import("./operator/operator-commands.js")).cmdRetire(root, args);
      break;
    }
    case "revert": {
      // Acts immediately on the primary checkout under the primary-worktree lock; the
      // positionals (a sha, or a run) are validated inside cmdRevert.
      await requireReadyRepo(root);
      await (await import("./operator/operator-commands.js")).cmdRevert(root, args);
      break;
    }
    case "stop": {
      // Bare stop signals the recorded orchestrator pid; `--in`/`--cancel` schedule or drop a
      // deferred stop. Anything else is a mistake and fails before a signal is ever sent.
      rejectUnknownArgs("stop", args, [STOP_IN_FLAG, STOP_CANCEL_FLAG]);
      await requireReadyRepo(root);
      await (await import("./operator/operator-commands.js")).cmdStop(root, args);
      break;
    }
    case "completion": {
      // Works outside a repo: no requireReadyRepo.
      if (args.length === 1 && args[0] === "--roles") {
        for (const id of completionRoleIds(root)) say(id);
        break;
      }
      if (args.length === 1 && args[0] === "--config-keys") {
        for (const key of completionConfigKeys(root)) say(key);
        break;
      }
      if (args.length === 1 && args[0] === "--models") {
        for (const m of completionModels(root)) say(m);
        break;
      }
      const shell = args[0];
      // A wrong word count names the count, not a bad shell. A single near-miss shell word gets
      // the same typoSuffix `logs --type`/`history --result` give, so `completion zs` reads
      // "did you mean `zsh`?" while a far-off value (`tcsh`) stays hint-free.
      if (args.length === 0) fail("completion needs a shell: bash, zsh, or fish");
      if (args.length > 1)
        fail(`completion takes one shell: bash, zsh, or fish (got ${args.length} words: ${args.join(" ")})`);
      if (!SUPPORTED_SHELLS.includes(shell as CompletionShell))
        fail(`completion takes one shell: bash, zsh, or fish${gotSuffix(shell)}${typoSuffix(shell ?? "", SUPPORTED_SHELLS)}`);
      say(completionScript(shell as CompletionShell));
      break;
    }
    case "version":
    case "--version":
    case "-v": {
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
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined: {
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
            `no help topic: ${name}${didYouMean(suggestion)} (try \`tumwater help\` for the full command list)`,
          );
        }
        say(topic);
      } else {
        process.stdout.write(HELP);
      }
      break;
    }
    default: {
      const suggestion = suggestCommand(command);
      fail(
        `unknown command: ${command}${didYouMean(suggestion)} (try \`tumwater help\`)`,
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
