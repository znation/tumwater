#!/usr/bin/env node
import fs from "node:fs";
import {
  fail,
  parseCountFlag,
  parsePortFlag,
  parsePromptArgs,
  DURATION_FLAG,
  rejectUnknownArgs,
  ROLE_FLAG,
  RUN_FLAG_SPECS,
} from "./cli-args.js";
import { cmdAbort, cmdConfig, cmdPause, cmdResetCounters, cmdResume, cmdStop, cmdWake, requestWake } from "./operator-commands.js";
import { cmdLogs } from "./ui/log-commands.js";
import { cmdInit, cmdRun } from "./cli-run.js";
import { repoToplevel } from "./git.js";
import { repoNotReady } from "./startup-gate.js";
import {
  type CancelOutcome,
  cancelRolePrompt,
  promptPreview,
  queuedPrompts,
  queuedRolePrompts,
  submitRolePrompt,
} from "./inbox.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { renderBacklogMarkdown } from "./ui/backlog-report.js";
import { cmdHistory } from "./ui/history.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, renderReportMarkdown } from "./ui/report.js";
import { collectReport } from "./report-data.js";
import { collectFailureReport } from "./failure-data.js";
import { renderFailureMarkdown } from "./failure-report.js";
import { snapshot } from "./ui/status.js";
import { renderStatus } from "./ui/status-render.js";
import { runTui } from "./ui/tui.js";
import { lanAddresses, startGui } from "./ui/gui.js";
import { statusPayload } from "./ui/status-payload.js";
import { errorMessage } from "./text.js";
import { knownRoleIds, loadConfig } from "./config.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { HELP, helpTopic } from "./help.js";

// The CLI's help text and its per-command topic parser live in help.ts — importing cli.ts
// would run main(), so tests pin the topics against help.ts directly.

/** Fail fast on the first unmet repo precondition (startup-gate.ts's repoNotReady — the repo
 * half of `tumwater run`'s startup gate, shared by every repo-bound command). */
async function requireReadyRepo(root: string): Promise<void> {
  const notReady = await repoNotReady(root);
  if (notReady !== null) fail(notReady);
}

/** The marker commands that share runRoleCommand's guard+dispatch shape below. */
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
async function runRoleCommand(root: string, command: MarkerCommand, args: string[]): Promise<void> {
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
    case "gui": {
      rejectUnknownArgs("gui", args, [
        { names: ["--port"], value: true, valueName: "<n>" },
        { names: ["--all-interfaces"] },
        { names: ["--token"], value: true, valueName: "<secret>" },
      ]);
      await requireReadyRepo(root);
      const portFlag = args.indexOf("--port");
      const port = portFlag >= 0 ? parsePortFlag(args[portFlag + 1]) : 7180;
      const allInterfaces = args.includes("--all-interfaces");
      // A valueless or empty --token is a CLI error, not an open server: an operator who
      // asked for protection must never silently get none. A flag-looking value is the
      // same mistake in disguise — a valued flag claims the next token even when it is a
      // known flag, so `--token --all-interfaces` would serve with the literal secret
      // "--all-interfaces" (--all-interfaces still takes effect, since it is read straight
      // from args) while the real secret sits unreached after another flag.
      const tokenFlag = args.indexOf("--token");
      const token = tokenFlag >= 0 ? (args[tokenFlag + 1] ?? "") : "";
      if (tokenFlag >= 0 && !token) fail("--token requires a non-empty secret (e.g. `--token s3cret`)");
      if (tokenFlag >= 0 && token.startsWith("--"))
        fail(
          `--token got the flag-looking value "${token}" instead of a secret — write the secret as its own argument (e.g. \`tumwater gui --token s3cret --all-interfaces\`)`,
        );
      try {
        await startGui(root, port, allInterfaces, token);
      } catch (err) {
        // A taken port is the common listen failure; Node's raw EADDRINUSE does not
        // suggest the fix. Other errors (EACCES on privileged ports, …) pass through.
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE")
          fail(
            `port ${port} is already in use — stop that process or pick another port with \`tumwater gui --port <n>\``,
          );
        throw err;
      }
      const tokenSuffix = token ? `/?token=${encodeURIComponent(token)}` : "";
      process.stdout.write(`tumwater gui at http://127.0.0.1:${port}${tokenSuffix} — Ctrl+C to stop\n`);
      if (allInterfaces) {
        // Name the concrete URLs teammates can open (token included, so they are openable
        // as printed), and say what exposure means: without a token the dashboard has no
        // auth and its prompt box steers the fleet; with one, the token is the gate.
        for (const addr of lanAddresses())
          process.stdout.write(`             also at http://${addr}:${port}${tokenSuffix}\n`);
        process.stdout.write(
          token
            ? `listening on ALL interfaces — token-protected; prompting the director requires the token\n`
            : `listening on ALL interfaces — no auth; anyone reaching it can prompt the director\n`,
        );
      }
      await new Promise(() => {}); // Serve until Ctrl+C.
      break;
    }
    case "status":
      rejectUnknownArgs("status", args, [{ names: ["--json"] }]);
      await requireReadyRepo(root);
      if (args.includes("--json")) {
        // Machine-readable fleet state — the document GET /api/status serves minus the
        // serving process's own `serverBuildSha`, printed with no server. A query, not a
        // health verdict: exit 0 on any successful read and let scripts interpret fields
        // themselves ("running": false is data, not failure).
        process.stdout.write(JSON.stringify(statusPayload(root), null, 2) + "\n");
      } else {
        process.stdout.write(
          renderStatus(root, snapshot(root), process.stdout.isTTY ? process.stdout.columns : undefined) + "\n",
        );
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
      ]);
      const daysFlag = args.indexOf("--days");
      let days = REPORT_DEFAULT_DAYS;
      if (daysFlag >= 0) {
        days = parseCountFlag("--days", args[daysFlag + 1]);
        // /api/report clamps its ?days= param to the same bound; an explicit flag fails fast
        // instead — a typo'd "3650" must not build a ten-year series (one entry per day), and
        // a huge value would grow it until the process runs out of memory. parseCountFlag has
        // already rejected 0, non-decimals, and a missing value.
        if (days > REPORT_MAX_DAYS)
          fail(`--days must be between 1 and ${REPORT_MAX_DAYS} (got ${JSON.stringify(args[daysFlag + 1])})`);
      }
      process.stdout.write(
        (args.includes("--failures")
          ? renderFailureMarkdown(collectFailureReport(root, days))
          : renderReportMarkdown(collectReport(root, days))) + "\n",
      );
      break;
    }
    case "doctor": {
      // No requireReadyRepo gate: doctor's job is to report WHY the environment isn't ready,
      // so it must run outside a git repo and print fail lines rather than throwing.
      rejectUnknownArgs("doctor", args, []);
      const report = await runDoctor(root);
      process.stdout.write(renderDoctor(report) + "\n");
      if (report.checks.some((c) => c.level === "fail")) process.exitCode = 1; // Warnings never fail the exit.
      break;
    }
    case "logs":
      rejectUnknownArgs("logs", args, [
        { names: ["-f", "--follow"] },
        { names: ["-n"], value: true, valueName: "<count>" },
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
      process.stdout.write(renderBacklogMarkdown(root) + "\n");
      break;
    }
    case "prompt": {
      await requireReadyRepo(root);
      const parsed = parsePromptArgs(args);
      // `--role <id>` scopes every mode to one loop's queue; the value is validated here, where
      // the live config is readable, with the same message every other --role consumer uses.
      // The director is always valid: its queue is the historical inbox (inbox.ts).
      let role: string | null = null;
      if (parsed.role !== null) {
        const valid = knownRoleIds(loadConfig(root));
        if (!valid.includes(parsed.role)) fail(`unknown role: ${parsed.role} (valid ids: ${valid.join(", ")})`);
        role = parsed.role;
      }
      if (parsed.mode === "list") {
        // Full text, verbatim: this is the inspection command that tells you what a queued
        // prompt actually says before you cancel it. Grouped by loop — the director first (its
        // queue is the shared one every pre-1/2 prompt landed in), then each role with queued
        // prompts — so a per-role queue's position numbering stays unambiguous.
        if (role !== null) {
          const prompts = queuedRolePrompts(root, role);
          if (prompts.length === 0) {
            process.stdout.write(`nothing queued for ${role}\n`);
          } else {
            process.stdout.write(`${role}:\n`);
            prompts.forEach((p, i) => process.stdout.write(`${i + 1}. ${p}\n`));
          }
          break;
        }
        const sections: string[] = [];
        const director = queuedPrompts(root);
        if (director.length > 0) {
          sections.push(`director:\n${director.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
        }
        for (const r of knownRoleIds(loadConfig(root))) {
          if (r === DIRECTOR_ROLE) continue;
          const prompts = queuedRolePrompts(root, r);
          if (prompts.length > 0) {
            sections.push(`${r}:\n${prompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
          }
        }
        if (sections.length === 0) {
          process.stdout.write("nothing queued\n");
        } else {
          process.stdout.write(sections.join("\n") + "\n");
        }
        break;
      }
      if (parsed.mode === "cancel") {
        const target = role ?? DIRECTOR_ROLE;
        let outcome: CancelOutcome;
        try {
          outcome = cancelRolePrompt(root, target, parsed.position);
        } catch (err) {
          fail(errorMessage(err));
        }
        if (outcome.status === "gone") {
          // A concurrent dequeue is a normal race, not an error: report it and exit clean.
          process.stdout.write(`prompt ${parsed.position} is no longer queued — ${target} already took it\n`);
        } else {
          process.stdout.write(`cancelled: ${promptPreview(outcome.text)}\n`);
        }
        break;
      }
      const target = role ?? DIRECTOR_ROLE;
      submitRolePrompt(root, target, parsed.text);
      if (role === null) {
        process.stdout.write("queued for the director loop\n");
      } else {
        process.stdout.write(`queued for the ${role} loop\n`);
      }
      // A live fleet sees the prompt now instead of whenever the sleeping loop's backoff next
      // expires: wake just the targeted role (requestWake's marker is safe with no fleet
      // running — the same contract as `tumwater wake`).
      process.stdout.write(requestWake(root, [target]) + "\n");
      break;
    }
    case "reset-counters":
    // Fall through: the five marker commands share one guard+dispatch shape — unknown-args
    // rejection against the optional --role flag, the ready-repo gate, then the
    // operator-commands core — so runRoleCommand holds it once instead of five copies
    // drifting. The case labels above are exactly MarkerCommand's members, which is what
    // makes the cast below exhaustive.
    case "wake":
    case "abort":
    case "pause":
    case "resume": {
      await runRoleCommand(root, command as MarkerCommand, args);
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
      process.stdout.write(pkg.version + "\n");
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
        process.stdout.write(topic + "\n");
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
