#!/usr/bin/env node
import {
  parseCountFlag,
} from "./cli-args.js";
import {
  grepFlagSpec,
  GUI_FLAG_SPECS,
  JSON_FLAG,
  LAST_FLAG,
  N_FLAG,
  rejectUnknownArgs,
  ROLE_FLAG,
  RUN_FLAG_SPECS,
  sinceFlagSpec,
  FORCE_FLAG,
} from "./cli-flag-specs.js";
import { fail, say, sayJsonOrRender } from "./cli-output.js";
import { parsePromptArgs, peelPositionals } from "./cli-command-args.js";
import { cmdConfig, CONFIG_USAGE } from "./config-commands.js";
import { cmdRetire, cmdStop } from "./operator-commands.js";
import { cmdPrompt } from "./prompt-commands.js";
import {
  cmdBacklog,
  cmdDiff,
  cmdQuestions,
  cmdRole,
  cmdStatus,
  requireReadyRepo,
} from "./cli-query-commands.js";
import { cmdLogs, GREP_VALUE_ERROR } from "./log-commands.js";
import { bugTitleOf, fileBug, filePlan, fileAndAnnounce, planTitleOf } from "./backlog-write.js";

import { runMarkerCommand, type MarkerCommand } from "./cli-marker-commands.js";
import { repoToplevel } from "./git.js";
import { runDoctor } from "./doctor.js";
import { renderDoctor } from "./doctor-render.js";
import { cmdHistory, HISTORY_GREP_VALUE_ERROR } from "./history.js";
import { cmdTick, TICK_USAGE } from "./tick-detail.js";
import { cmdReport } from "./report.js";

import { didYouMean } from "./suggest.js";
import { errorMessage } from "./text.js";
import { HELP, helpTopic, suggestCommand } from "./help.js";
import { PACKAGE_JSON, nodeFloorProblem, packageEnginesNode, packageVersion } from "./version.js";

// The CLI's help text and its per-command topic parser live in help.ts — importing cli.ts
// would run main(), so tests pin the topics against help.ts directly.

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
  // `tumwater help <command>` derives from the full listing — and exits 0. Intercepted once
  // here, before any command parses its arguments or gates on a ready repo, so the flag
  // cannot collide with a command's real flags (a command's arg gate never sees it) and every
  // command gains the convention at once — `help` included, whose own topic it answers
  // (a `--help` topic lookup would only fail: the listing names no such command); a command
  // with no topic falls through to its ordinary dispatch, where an unknown argument is
  // still named.
  if (
    command !== undefined &&
    command !== "--help" &&
    command !== "-h" &&
    (args.includes("--help") || args.includes("-h"))
  ) {
    const topic = helpTopic(command);
    if (topic !== null) {
      say(topic);
      return;
    }
  }
  // The repo root, not the cwd: every command must behave identically from any subdirectory
  // of the repo it targets (.tumwater/ and tumwater.json live at the toplevel, and
  // readBranchHead's ref-file fast path needs a root that actually holds .git). Outside a
  // repository the probe fails and cwd is used as before, so doctor outside a repo still
  // reports why the environment is not ready.
  const root = (await repoToplevel(process.cwd())) ?? process.cwd();
  switch (command) {
    case "init":
      // Imported lazily: cli-run pulls the whole fleet-booting subgraph (orchestrator,
      // supervisor, redeploy, launch-services — the run path's machinery), and every other
      // command's spawn pays module compilation for it unless the dispatch defers that load
      // to the commands that actually boot or serve a fleet.
      await (await import("./cli-run.js")).cmdInit(root, args);
      break;
    case "run":
      rejectUnknownArgs("run", args, RUN_FLAG_SPECS);
      await (await import("./cli-run.js")).cmdRun(root, args);
      break;
    case "tui":
      rejectUnknownArgs("tui", args, []);
      await requireReadyRepo(root);
      // Imported lazily: the TUI module pulls in ink (the one runtime dependency the
      // tree carries), and an install whose node_modules is absent must still reach
      // every other command's own broken-install reporting instead of dying on import.
      const { runTui } = await import("./ui/tui.js");
      await runTui(root);
      break;
    case "gui":
      rejectUnknownArgs("gui", args, GUI_FLAG_SPECS);
      await requireReadyRepo(root);
      await (await import("./gui-command.js")).cmdGui(root, args);
      break;
    case "status":
      await cmdStatus(root, args);
      break;
    case "config": {
      // Subcommand arity before the ready-repo gate, so a malformed get/set fails with its
      // usage no matter the directory: bare config takes nothing, `get` exactly one key,
      // `set` exactly a key and a value. cmdConfig dispatches on the (now well-shaped) args.
      if (args.length > 0) {
        if (args[0] !== "get" && args[0] !== "set")
          fail(CONFIG_USAGE);
        if (args[0] === "get" && args.length !== 2) fail("usage: tumwater config get <key>");
        if (args[0] === "set" && args.length !== 3) fail("usage: tumwater config set <key> <value>");
      }
      // An initialized repo always has tumwater.json, so this gate doubles as "a config
      // exists to print" — the command never runs outside a project.
      await requireReadyRepo(root);
      await cmdConfig(root, args);
      break;
    }
    case "report": {
      // No requireReadyRepo gate: the report aggregates files that degrade to zeros when
      // missing, so it runs (and prints an all-zero window) in any directory.
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
        JSON_FLAG,
      ]);
      // --since is handled before the day-shape reads: it is a rival shape (totals over a
      // trailing window vs a series over whole days), not a modifier of either.
      await cmdReport(root, args);
      break;
    }
    case "doctor": {
      // No requireReadyRepo gate: doctor's job is to report WHY the environment isn't ready,
      // so it must run outside a git repo and print fail lines rather than throwing.
      rejectUnknownArgs("doctor", args, [JSON_FLAG]);
      const report = await runDoctor(root);
      // --json prints the collector's own payload (the DoctorReport object), not a re-parse of
      // the render — the `report --json` precedent. The exit-code contract below holds in both
      // forms: 1 when any check fails, 0 otherwise; warnings never fail the exit.
      sayJsonOrRender(args, report, renderDoctor);
      if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1; // Warnings never fail the exit.
      break;
    }
    case "logs":
      rejectUnknownArgs("logs", args, [
        { names: ["-f", "--follow"] },
        N_FLAG,
        sinceFlagSpec("logs --since"),
        grepFlagSpec(GREP_VALUE_ERROR),
        JSON_FLAG,
        ROLE_FLAG,
        { names: ["--prompt"] },
      ]);
      await requireReadyRepo(root);
      await cmdLogs(root, args);
      break;
    case "history":
      rejectUnknownArgs("history", args, [
        N_FLAG,
        sinceFlagSpec("history --since"),
        grepFlagSpec(HISTORY_GREP_VALUE_ERROR),
        JSON_FLAG,
        ROLE_FLAG,
      ]);
      await requireReadyRepo(root);
      await cmdHistory(root, args);
      break;
    case "tick": {
      // Positional-first command (the role command's pattern): the <role> <n> tokens peel off,
      // the flags that remain go through rejectUnknownArgs (only --json is admitted), and
      // cmdTick owns the arity and value validation — a missing role, an unknown id, a
      // non-positive or non-numeric n, or a stray extra positional fails there with the usage.
      const { positionals, rest } = peelPositionals(args);
      rejectUnknownArgs("tick", rest, [JSON_FLAG, LAST_FLAG]);
      // Arity before the ready-repo gate (the config subcommands' precedent): a malformed
      // invocation fails with its usage no matter the directory. cmdTick keeps the guard too —
      // in-process callers reach it without this dispatcher. One positional is the --last
      // form (<role>), two is the numbered pair (<role> <n>); cmdTick picks the arity by the
      // flag, so the gate stays loose here and the rivals check lives there.
      if (positionals.length < 1 || positionals.length > 2) fail(`usage: ${TICK_USAGE}`);
      await requireReadyRepo(root);
      await cmdTick(root, positionals, rest.includes("--json"), rest.includes("--last"));
      break;
    }
    case "diff":
      await cmdDiff(root, args);
      break;
    case "backlog":
      await cmdBacklog(root, args);
      break;
    case "bug": {
      const usage = 'tumwater bug "<symptom>"';
      await fileAndAnnounce(
        root,
        args,
        "bug",
        (positionals) => fileBug(root, positionals.join(" "), usage),
        "bugfix",
        (title) =>
          `Operator filed a new bug with \`tumwater bug\`: "${title}" — it is under BUGS.md ## Open; fix it.`,
        bugTitleOf,
      );
      break;
    }
    case "plan": {
      const usage = 'tumwater plan "<title>" [body...]';
      await fileAndAnnounce(
        root,
        args,
        "plan",
        (positionals) => filePlan(root, positionals[0] ?? "", positionals.slice(1).join(" "), usage),
        "feature",
        (title) =>
          `Operator requested a plan with \`tumwater plan\`: "${title}" — it is under PLANS.md ## Planned; flesh out the plan stub.`,
        planTitleOf,
      );
      break;
    }
    case "questions":
      await cmdQuestions(root, args);
      break;
    case "role":
      await cmdRole(root, args);
      break;
    case "prompt":
      // Parse before the gate: prompt's positionals are free-form, so rejectUnknownArgs
      // cannot run here, and without this pre-parse `tumwater prompt --role` outside an
      // initialized repo would report "not a git repository" instead of the flag error —
      // the same masking every other command's spec-based missing-value check avoids.
      // cmdPrompt re-running the parse below cannot drift from what this pre-parse accepted,
      // and --file's reads are idempotent across the two parses (a file is re-read; the
      // stdin read is memoized in cli-command-args.ts, so a drained pipe is not re-read
      // as an empty prompt).
      parsePromptArgs(args);
      await requireReadyRepo(root);
      await cmdPrompt(root, args);
      break;
    case "reset-counters":
    // Fall through: the five marker commands share one guard+dispatch shape — unknown-args
    // rejection against the optional --role flag, the ready-repo gate, then the
    // operator-commands core — so runMarkerCommand holds it once instead of five copies
    // drifting. The case labels above are exactly MarkerCommand's members, which is what
    // makes the cast below exhaustive.
    case "wake":
    case "abort":
    case "pause":
    case "resume": {
      await runMarkerCommand(root, command as MarkerCommand, args);
      break;
    }
    case "retire": {
      // Not a marker command (it acts immediately, not via a request file), but it shares the
      // marker commands' gate shape: unknown-args rejection, then the ready-repo gate.
      rejectUnknownArgs("retire", args, [ROLE_FLAG, FORCE_FLAG, JSON_FLAG]);
      await requireReadyRepo(root);
      await cmdRetire(root, args);
      break;
    }
    case "stop": {
      // No flags: stop is a bare signal to the recorded orchestrator pid, so any argument is
      // a mistake and fails before a signal is ever sent.
      rejectUnknownArgs("stop", args, []);
      await requireReadyRepo(root);
      await cmdStop(root);
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
        fail(problem ?? "package.json carries no version field (the running harness's install looks broken)");
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
      if (args.length > 1) fail("help takes at most one command name");
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
  fail(errorMessage(err));
});
