#!/usr/bin/env node
import fs from "node:fs";
import {
  fail,
  say,
  DURATION_FLAG,
  rejectUnknownArgs,
  ROLE_FLAG,
  RUN_FLAG_SPECS,
} from "./cli-args.js";
import { cmdAbort, cmdConfig, cmdPause, cmdPrompt, cmdResetCounters, cmdResume, cmdStop, cmdWake } from "./ui/operator-commands.js";
import { cmdLogs } from "./ui/log-commands.js";
import { cmdInit, cmdRun } from "./cli-run.js";
import { repoToplevel } from "./git.js";
import { repoNotReady } from "./startup-gate.js";
import { runDoctor } from "./doctor.js";
import { renderDoctor } from "./ui/doctor-report.js";
import { renderBacklogMarkdown } from "./ui/backlog-report.js";
import { cmdHistory } from "./ui/history.js";
import { cmdReport } from "./ui/report.js";
import { snapshot } from "./ui/status.js";
import { renderStatus } from "./ui/status-render.js";
import { runTui } from "./ui/tui.js";
import { cmdGui } from "./ui/gui.js";
import { statusPayload } from "./ui/status-payload.js";
import { errorMessage } from "./text.js";
import { HELP, helpTopic } from "./help.js";

// The CLI's help text and its per-command topic parser live in help.ts — importing cli.ts
// would run main(), so tests pin the topics against help.ts directly.

/** Fail fast on the first unmet repo precondition (startup-gate.ts's repoNotReady — the repo
 * half of `tumwater run`'s startup gate, shared by every repo-bound command). */
async function requireReadyRepo(root: string): Promise<void> {
  const notReady = await repoNotReady(root);
  if (notReady !== null) fail(notReady);
}

/** The marker commands that share runMarkerCommand's guard+dispatch shape below. */
type MarkerCommand = "reset-counters" | "wake" | "abort" | "pause" | "resume";

/** The marker-writing core of each marker command, keyed by its CLI name (the consumer half
 * lives in operator-commands.ts). One map so a new marker command registers its core beside
 * its case label instead of growing another copy of the guard sequence. */
const markerCommandCores: Record<MarkerCommand, (root: string, args: string[]) => Promise<void>> = {
  "reset-counters": cmdResetCounters,
  wake: cmdWake,
  abort: cmdAbort,
  pause: cmdPause,
  resume: cmdResume,
};

/** The shared shape of the five marker commands (reset-counters, wake, abort, pause, resume):
 * reject unknown args (each takes only the optional --role flag), gate on a ready repo, then
 * dispatch to its operator-commands core. One copy of the guard sequence so the five cannot
 * drift on validation order or gating. */
async function runMarkerCommand(root: string, command: MarkerCommand, args: string[]): Promise<void> {
  // `pause` alone accepts `--for <duration>` (the timed pause); the other marker commands keep
  // the plain --role vocabulary, so a stray --for fails fast instead of being silently ignored.
  rejectUnknownArgs(command, args, command === "pause" ? [ROLE_FLAG, DURATION_FLAG] : [ROLE_FLAG]);
  await requireReadyRepo(root);
  await markerCommandCores[command](root, args);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  // The repo root, not the cwd: every command must behave identically from any subdirectory
  // of the repo it targets (.tumwater/ and tumwater.json live at the toplevel, and
  // readBranchHead's ref-file fast path needs a root that actually holds .git). Outside a
  // repository the probe fails and cwd is used as before, so doctor outside a repo still
  // reports why the environment is not ready.
  const root = (await repoToplevel(process.cwd())) ?? process.cwd();
  switch (command) {
    case "init":
      await cmdInit(root, args);
      break;
    case "run":
      rejectUnknownArgs("run", args, RUN_FLAG_SPECS);
      await cmdRun(root, args);
      break;
    case "tui":
      rejectUnknownArgs("tui", args, []);
      await requireReadyRepo(root);
      await runTui(root);
      break;
    case "gui":
      rejectUnknownArgs("gui", args, [
        { names: ["--port"], value: true, valueName: "<n>" },
        { names: ["--all-interfaces"] },
        { names: ["--token"], value: true, valueName: "<secret>" },
      ]);
      await requireReadyRepo(root);
      await cmdGui(root, args);
      break;
    case "status":
      rejectUnknownArgs("status", args, [{ names: ["--json"] }]);
      await requireReadyRepo(root);
      if (args.includes("--json")) {
        // Machine-readable fleet state — the document GET /api/status serves minus the
        // serving process's own `serverBuildSha`, printed with no server. A query, not a
        // health verdict: exit 0 on any successful read and let scripts interpret fields
        // themselves ("running": false is data, not failure).
        say(JSON.stringify(statusPayload(root), null, 2));
      } else {
        say(renderStatus(root, snapshot(root), process.stdout.isTTY ? process.stdout.columns : undefined));
      }
      break;
    case "config": {
      // One format, no flags: an operator who wants to see what they wrote reads
      // tumwater.json; this prints the resolved config the fleet loads, nothing else.
      rejectUnknownArgs("config", args, []);
      // An initialized repo always has tumwater.json, so this gate doubles as "a config
      // exists to print" — the command never runs outside a project.
      await requireReadyRepo(root);
      await cmdConfig(root);
      break;
    }
    case "report": {
      // No requireReadyRepo gate: the report aggregates files that degrade to zeros when
      // missing, so it runs (and prints an all-zero window) in any directory.
      rejectUnknownArgs("report", args, [
        { names: ["--days"], value: true, valueName: "<n>" },
        { names: ["--failures"] },
        { names: ["--since"], value: true, valueName: "<duration>" },
        { names: ["--json"] },
      ]);
      // --since is handled before the day-shape reads: it is a rival shape (totals over a
      // trailing window vs a series over whole days), not a modifier of either.
      await cmdReport(root, args);
      break;
    }
    case "doctor": {
      // No requireReadyRepo gate: doctor's job is to report WHY the environment isn't ready,
      // so it must run outside a git repo and print fail lines rather than throwing.
      rejectUnknownArgs("doctor", args, []);
      const report = await runDoctor(root);
      say(renderDoctor(report));
      if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1; // Warnings never fail the exit.
      break;
    }
    case "logs":
      rejectUnknownArgs("logs", args, [
        { names: ["-f", "--follow"] },
        { names: ["-n"], value: true, valueName: "<count>" },
        { names: ["--since"], value: true, valueName: "<duration>" },
        { names: ["--grep"], value: true, valueName: "<text>" },
        ROLE_FLAG,
        { names: ["--prompt"] },
      ]);
      await requireReadyRepo(root);
      await cmdLogs(root, args);
      break;
    case "history":
      rejectUnknownArgs("history", args, [
        { names: ["-n"], value: true, valueName: "<count>" },
        ROLE_FLAG,
      ]);
      await requireReadyRepo(root);
      await cmdHistory(root, args);
      break;
    case "backlog": {
      // No requireReadyRepo gate: the entry readers degrade to [] on a missing file, so the
      // command prints three empty sections in any directory (report's rationale, not config's).
      rejectUnknownArgs("backlog", args, []);
      say(renderBacklogMarkdown(root));
      break;
    }
    case "prompt":
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
      const pkg = JSON.parse(
        fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      say(pkg.version);
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
        if (topic === null)
          fail(`no help topic: ${name} (try \`tumwater help\` for the full command list)`);
        say(topic);
      } else {
        process.stdout.write(HELP);
      }
      break;
    }
    default:
      fail(`unknown command: ${command} (try \`tumwater help\`)`);
  }
}

main().catch((err: unknown) => {
  fail(errorMessage(err));
});
