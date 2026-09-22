#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { enabledRoleIds, loadConfig } from "./config.js";
import {
  fail,
  parseBranchFlag,
  parseCountFlag,
  parseInitArgs,
  parsePortFlag,
  parsePromptArgs,
  rejectUnknownArgs,
} from "./cli-args.js";
import { cmdAbort, cmdPause, cmdResetCounters, cmdResume, cmdWake } from "./operator-commands.js";
import { cmdLogs } from "./ui/log-commands.js";
import { orchestratorAlive } from "./fleet-state.js";
import {
  GIT_MISSING_MESSAGE,
  branchExists,
  currentBranch,
  hasCommits,
  isGitRepo,
  listBranches,
  repoToplevel,
} from "./git.js";
import {
  DETACHED_HEAD_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_INITIALIZED_MESSAGE,
  NO_COMMITS_MESSAGE,
  PI_MISSING_MESSAGE,
} from "./readiness.js";
import type { TumwaterConfig } from "./types.js";
import { initProject } from "./init.js";
import {
  type CancelOutcome,
  cancelPrompt,
  promptPreview,
  queuedPrompts,
  submitPrompt,
} from "./inbox.js";
import { logEvent, subscribeEvents } from "./events.js";
import { formatEvent } from "./ui/event-format.js";
import { runOrchestrator } from "./orchestrator.js";
import { createRedeployer, RESTART_EXIT_CODE } from "./redeploy.js";
import { spawnRunChild, SUPERVISED_ENV, superviseRun } from "./supervisor.js";
import { renderDoctor, runDoctor } from "./doctor.js";
import { findOnPath } from "./files.js";
import { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS, collectReport, renderReportMarkdown } from "./ui/report.js";
import { collectFailureReport } from "./failure-data.js";
import { renderFailureMarkdown } from "./failure-report.js";
import { snapshot } from "./ui/status.js";
import { renderStatus } from "./ui/status-render.js";
import { runTui } from "./ui/tui.js";
import { lanAddresses, startGui } from "./ui/gui.js";
import { statusPayload } from "./ui/status-payload.js";
import { errorMessage, shortSha } from "./text.js";

const HELP = `tumwater — autonomous development harness built on pi

Usage:
  tumwater init <prompt...>        Initialize this repo (--file <prompt.md>, --branch <name>)
  tumwater run [--branch <name>]   Run all enabled loops (headless; Ctrl+C stops)
  tumwater tui                     Dashboard + prompt input (observes a running \`tumwater run\`)
  tumwater gui [--port N] [--all-interfaces]
                                   Same dashboard in the browser (default port 7180,
                                   localhost only; --all-interfaces serves the whole
                                   network — no auth, anyone reaching it can prompt
                                   the director)
  tumwater status [--json]         One-shot status table (--json prints machine-readable
                                   fleet state — the GUI's /api/status payload minus the
                                   serving process's serverBuildSha)
  tumwater report [--days N]       Markdown usage report — tokens/ticks/commits per day (default 14 days)
  tumwater report --failures [--days N]
                                   Markdown failure digest — tick outcomes, deltas, clustered errors, and fleet state changes (default 14 days)
  tumwater doctor                  Pre-flight check: node, git, repo, config, fallback model, pi, locks, build (read-only; exit 0/1)
  tumwater logs [-f] [-n N]        Show (and follow) harness events
  tumwater logs --role <id> [-f] [-n N] [--prompt]
                                   Show (and follow) that loop's pi transcript
                                   (--prompt also shows each run's exact prompt text)
  tumwater prompt <text...>        Queue a prompt for the director loop
  tumwater prompt --list           Show queued prompts, numbered in execution order
  tumwater prompt --cancel <n>     Remove the Nth queued prompt (as shown by --list)
  tumwater reset-counters [--role <id>]   Zero ticks/commits/tokens/cost (fresh observation window)
  tumwater wake [--role <id>]             Wake a backed-off fleet — the named roles (or all) tick within one poll
  tumwater abort --role <id>              Abort that loop's in-flight tick (work discarded; the loop keeps running)
  tumwater pause                   Stop role loops starting new ticks (in-flight finish; the director keeps running)
  tumwater resume                  Lift a fleet pause
  tumwater help | version

The harness runs inside a git repo. Each role loop owns a persistent worktree and branch
under .tumwater/, does one task per tick with pi, commits, and merges to main. Loops back
off while the project is quiet and wake when main moves. Everything is local: no remotes.
`;

/** The branch the fleet targets: `--branch <name>` wins, then `baseBranch` in config, then
 * whatever the primary checkout has checked out — the branch-agnostic default. An explicit
 * value must exist: failing at startup with the branches that do exist beats failing at the
 * first `git worktree add`. */
async function resolveMainBranch(
  root: string,
  config: TumwaterConfig,
  branchArg: string | null,
): Promise<string> {
  const explicit = branchArg ?? config.baseBranch ?? null;
  if (explicit !== null) {
    if (!(await branchExists(root, explicit))) {
      const existing = (await listBranches(root)).join(", ") || "none";
      fail(`branch ${explicit} does not exist (branches: ${existing})`);
    }
    return explicit;
  }
  const branch = await currentBranch(root);
  if (!branch) fail(DETACHED_HEAD_MESSAGE);
  return branch;
}

async function requireReadyRepo(root: string): Promise<void> {
  // Fail fast on a missing binary: without this, the probe below reads as "not a git
  // repository" — pointing at the wrong fix for a machine with no git installed.
  if (!findOnPath("git")) fail(GIT_MISSING_MESSAGE);
  if (!(await isGitRepo(root))) fail(NOT_A_REPO_MESSAGE);
  if (!fs.existsSync(path.join(root, "tumwater.json"))) {
    fail(NOT_INITIALIZED_MESSAGE);
  }
  if (!(await hasCommits(root))) fail(NO_COMMITS_MESSAGE);
}

async function cmdInit(root: string, args: string[]): Promise<void> {
  const { prompt, branch } = parseInitArgs(args);
  const result = await initProject(root, prompt, branch ?? undefined);
  if (result.created.length === 0) {
    process.stdout.write("already initialized; nothing to do\n");
    return;
  }
  if (result.repoInitialized && result.branch) {
    process.stdout.write(`initialized a new git repository on branch ${result.branch}\n`);
  }
  process.stdout.write(`created ${result.created.join(", ")}${result.committed ? " (committed)" : ""}\n`);
  process.stdout.write("next: `tumwater run` in one terminal, `tumwater tui` in another\n");
}

async function cmdRun(root: string, args: string[]): Promise<void> {
  await requireReadyRepo(root);
  // Fail fast instead of starting loops whose every tick dies with "spawn pi ENOENT".
  if (!findOnPath("pi")) {
    fail(PI_MISSING_MESSAGE);
  }
  if (orchestratorAlive(root)) fail("an orchestrator is already running for this repo");
  if (!process.env[SUPERVISED_ENV]) {
    // `args` are the flags after the command token — forward them so the child generation
    // targets the same branch (or whatever else the invocation named).
    await superviseRunCommand(args);
    return;
  }
  const config = loadConfig(root);
  const mainBranch = await resolveMainBranch(root, config, parseBranchFlag(args));
  const controller = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stdout.write("\nstopping — waiting for in-flight ticks (Ctrl+C again to force)\n");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const enabled = enabledRoleIds(config);
  const redeploy = await createRedeployer(root, (e) => logEvent(root, e));
  const build = redeploy ? ` · build ${shortSha(redeploy.build.sha)}` : "";
  // Name the resolved root when it differs from the cwd: an operator who started the fleet
  // from a subdirectory must see where .tumwater/ actually lives.
  const rootNote = root !== process.cwd() ? ` · root ${root}` : "";
  process.stdout.write(`tumwater running on branch ${mainBranch}${build}${rootNote} — Ctrl+C to stop\n`);
  process.stdout.write(`loops: ${enabled.join(", ")}\n`);
  process.stdout.write("watch: `tumwater tui` or `tumwater logs -f` in another terminal; events stream below\n\n");
  const unsubscribe = subscribeEvents((e) => process.stdout.write(formatEvent(e) + "\n"));
  let exit;
  try {
    exit = await runOrchestrator({ root, config, mainBranch, signal: controller.signal, redeploy });
  } finally {
    unsubscribe();
  }
  // A self-redeploy swapped the new build into dist/: hand the terminal back to the supervisor,
  // which respawns this same script — now the new code — as the next generation.
  if (exit.restart) process.exit(RESTART_EXIT_CODE);
}

/** The supervisor half of `tumwater run` (src/supervisor.ts): spawn the orchestrator as a child
 * generation and respawn it whenever it exits RESTART_EXIT_CODE after redeploying itself. Ctrl+C
 * reaches the child directly from the terminal, so only SIGTERM is forwarded; the supervisor's
 * own exit code is whatever the last generation's was. */
async function superviseRunCommand(runArgs: string[]): Promise<void> {
  const controller = new AbortController();
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true; // The child got the same SIGINT from the terminal and stops on its own.
  });
  process.on("SIGTERM", () => {
    stopping = true;
    controller.abort(); // Not delivered to the child by the kernel — forward it.
  });
  const code = await superviseRun(
    {
      spawnChild: (signal) => spawnRunChild(signal, runArgs),
      stopping: () => stopping,
      onRespawn: (generation) =>
        process.stdout.write(`\nrestarting on the new build (generation ${generation})\n\n`),
      onCrashLoop: () =>
        process.stderr.write("tumwater: the harness restarted itself too many times in a minute — giving up\n"),
    },
    controller.signal,
  );
  process.exit(code);
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
      rejectUnknownArgs("run", args, [{ names: ["--branch"], value: true, valueName: "<name>" }]);
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
      ]);
      await requireReadyRepo(root);
      const portFlag = args.indexOf("--port");
      const port = portFlag >= 0 ? parsePortFlag(args[portFlag + 1]) : 7180;
      const allInterfaces = args.includes("--all-interfaces");
      try {
        await startGui(root, port, allInterfaces);
      } catch (err) {
        // A taken port is the common listen failure; Node's raw EADDRINUSE does not
        // suggest the fix. Other errors (EACCES on privileged ports, …) pass through.
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE")
          fail(
            `port ${port} is already in use — stop that process or pick another port with \`tumwater gui --port <n>\``,
          );
        throw err;
      }
      process.stdout.write(`tumwater gui at http://127.0.0.1:${port} — Ctrl+C to stop\n`);
      if (allInterfaces) {
        // Name the concrete URLs teammates can open, and say what exposure means: the
        // dashboard has no auth, and its prompt box steers the fleet.
        for (const addr of lanAddresses()) process.stdout.write(`             also at http://${addr}:${port}\n`);
        process.stdout.write(`listening on ALL interfaces — no auth; anyone reaching it can prompt the director\n`);
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
        { names: ["--role"], value: true, valueName: "<id>" },
        { names: ["--prompt"] },
      ]);
      await requireReadyRepo(root);
      await cmdLogs(root, args);
      break;
    case "prompt": {
      await requireReadyRepo(root);
      const parsed = parsePromptArgs(args);
      if (parsed.mode === "list") {
        // Full text, verbatim: this is the inspection command that tells you what a queued
        // prompt actually says before you cancel it.
        const prompts = queuedPrompts(root);
        if (prompts.length === 0) {
          process.stdout.write("nothing queued for the director\n");
        } else {
          prompts.forEach((p, i) => process.stdout.write(`${i + 1}. ${p}\n`));
        }
        break;
      }
      if (parsed.mode === "cancel") {
        let outcome: CancelOutcome;
        try {
          outcome = cancelPrompt(root, parsed.position);
        } catch (err) {
          fail(errorMessage(err));
        }
        if (outcome.status === "gone") {
          // A concurrent dequeue is a normal race, not an error: report it and exit clean.
          process.stdout.write(`prompt ${parsed.position} is no longer queued — the director already took it\n`);
        } else {
          process.stdout.write(`cancelled: ${promptPreview(outcome.text)}\n`);
        }
        break;
      }
      submitPrompt(root, parsed.text);
      process.stdout.write("queued for the director loop\n");
      break;
    }
    case "reset-counters": {
      rejectUnknownArgs("reset-counters", args, [{ names: ["--role"], value: true, valueName: "<id>" }]);
      await requireReadyRepo(root);
      await cmdResetCounters(root, args);
      break;
    }
    case "wake": {
      rejectUnknownArgs("wake", args, [{ names: ["--role"], value: true, valueName: "<id>" }]);
      await requireReadyRepo(root);
      await cmdWake(root, args);
      break;
    }
    case "abort": {
      rejectUnknownArgs("abort", args, [{ names: ["--role"], value: true, valueName: "<id>" }]);
      await requireReadyRepo(root);
      await cmdAbort(root, args);
      break;
    }
    case "pause": {
      rejectUnknownArgs("pause", args, []);
      await requireReadyRepo(root);
      await cmdPause(root);
      break;
    }
    case "resume": {
      rejectUnknownArgs("resume", args, []);
      await requireReadyRepo(root);
      await cmdResume(root);
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
    case undefined:
      // `help` selects nothing (there is no per-command help), so any argument is a mistake
      // and fails rather than printing usage as though it were that token's help.
      rejectUnknownArgs("help", args, []);
      process.stdout.write(HELP);
      break;
    default:
      fail(`unknown command: ${command} (try \`tumwater help\`)`);
  }
}

main().catch((err: unknown) => {
  fail(errorMessage(err));
});
