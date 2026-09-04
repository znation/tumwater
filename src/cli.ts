#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { enabledRoleIds, loadConfig } from "./config.js";
import {
  fail,
  parseCountFlag,
  parseInitArgs,
  parsePortFlag,
  parsePromptArgs,
  parseRoleFlag,
  rejectUnknownArgs,
} from "./cli-args.js";
import { loadLoopState, orchestratorAlive, saveLoopState, zeroCounters } from "./state.js";
import { createTranscriptRenderer } from "./transcript.js";
import { readTranscriptTail } from "./transcript-tail.js";
import { GIT_MISSING_MESSAGE, currentBranch, hasCommits, isGitRepo } from "./git.js";
import { initProject } from "./init.js";
import {
  type CancelOutcome,
  cancelPrompt,
  promptPreview,
  queuedPrompts,
  submitPrompt,
} from "./inbox.js";
import { readEvents, subscribeEvents } from "./events.js";
import { formatEvent } from "./event-format.js";
import { runOrchestrator } from "./orchestrator.js";
import { ensureParentDir, findOnPath } from "./files.js";
import { followFile } from "./tail.js";
import { snapshot } from "./status.js";
import { renderStatus } from "./status-render.js";
import { runTui } from "./tui.js";
import { lanAddresses, startGui } from "./gui.js";
import { abortRequestPath, eventsLogPath, piLogPath, resetRequestPath } from "./paths.js";

const HELP = `tumwater — autonomous development harness built on pi

Usage:
  tumwater init <prompt...>        Initialize this repo (or --file <prompt.md>)
  tumwater run                     Run all enabled loops (headless; Ctrl+C stops)
  tumwater tui                     Dashboard + prompt input (observes a running \`tumwater run\`)
  tumwater gui [--port N] [--all-interfaces]
                                   Same dashboard in the browser (default port 7180,
                                   localhost only; --all-interfaces serves the whole
                                   network — no auth, anyone reaching it can prompt
                                   the director)
  tumwater status                  One-shot status table
  tumwater logs [-f] [-n N]        Show (and follow) harness events
  tumwater logs --role <id> [-f] [-n N]
                                   Show (and follow) that loop's pi transcript
  tumwater prompt <text...>        Queue a prompt for the director loop
  tumwater prompt --list           Show queued prompts, numbered in execution order
  tumwater prompt --cancel <n>     Remove the Nth queued prompt (as shown by --list)
  tumwater reset-counters [--role <id>]   Zero ticks/commits/tokens/cost (fresh observation window)
  tumwater abort --role <id>             Abort that loop's in-flight tick (work discarded; the loop keeps running)
  tumwater help | version

The harness runs inside a git repo. Each role loop owns a persistent worktree and branch
under .tumwater/, does one task per tick with pi, commits, and merges to main. Loops back
off while the project is quiet and wake when main moves. Everything is local: no remotes.
`;

async function resolveMainBranch(root: string): Promise<string> {
  const branch = await currentBranch(root);
  if (!branch) fail("the repo's primary checkout is detached; check out your main branch first");
  return branch;
}

async function requireReadyRepo(root: string): Promise<void> {
  // Fail fast on a missing binary: without this, the probe below reads as "not a git
  // repository" — pointing at the wrong fix for a machine with no git installed.
  if (!findOnPath("git")) fail(GIT_MISSING_MESSAGE);
  if (!(await isGitRepo(root))) fail("not a git repository (run `git init` first)");
  if (!fs.existsSync(path.join(root, "tumwater.json"))) {
    fail("not initialized (run `tumwater init <prompt>` first)");
  }
  if (!(await hasCommits(root))) fail("the repo has no commits yet; `tumwater init` creates the first one");
}

async function cmdInit(root: string, args: string[]): Promise<void> {
  const prompt = parseInitArgs(args);
  const result = await initProject(root, prompt);
  if (result.created.length === 0) {
    process.stdout.write("already initialized; nothing to do\n");
    return;
  }
  process.stdout.write(`created ${result.created.join(", ")}${result.committed ? " (committed)" : ""}\n`);
  process.stdout.write("next: `tumwater run` in one terminal, `tumwater tui` in another\n");
}

async function cmdRun(root: string): Promise<void> {
  await requireReadyRepo(root);
  // Fail fast instead of starting loops whose every tick dies with "spawn pi ENOENT".
  if (!findOnPath("pi")) {
    fail("pi not found on PATH — install it (https://github.com/badlogic/pi-mono) or add its bin directory to your PATH");
  }
  if (orchestratorAlive(root)) fail("an orchestrator is already running for this repo");
  const config = loadConfig(root);
  const mainBranch = await resolveMainBranch(root);
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
  process.stdout.write(`tumwater running on branch ${mainBranch} — Ctrl+C to stop\n`);
  process.stdout.write(`loops: ${enabled.join(", ")}\n`);
  process.stdout.write("watch: `tumwater tui` or `tumwater logs -f` in another terminal; events stream below\n\n");
  const unsubscribe = subscribeEvents((e) => process.stdout.write(formatEvent(e) + "\n"));
  try {
    await runOrchestrator({ root, config, mainBranch, signal: controller.signal });
  } finally {
    unsubscribe();
  }
}

async function cmdLogs(root: string, args: string[]): Promise<void> {
  const follow = args.includes("-f") || args.includes("--follow");
  const nFlag = args.indexOf("-n");
  const limit = nFlag >= 0 ? parseCountFlag("-n", args[nFlag + 1]) : 50;
  const role = parseRoleFlag(args);
  if (role !== null) {
    await cmdLogsTranscript(root, role, limit, follow);
    return;
  }
  for (const e of readEvents(root, limit)) process.stdout.write(formatEvent(e) + "\n");
  if (!follow) return;
  const file = eventsLogPath(root);
  ensureParentDir(file);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  followFile(file, fs.statSync(file).size, (lines) => {
    for (const line of lines.filter(Boolean)) {
      try {
        process.stdout.write(formatEvent(JSON.parse(line)) + "\n");
      } catch {
        // Non-JSON noise; skip.
      }
    }
  });
  await new Promise(() => {}); // Follow until Ctrl+C.
}

/** `tumwater logs --role <id>`: print (and optionally follow) one loop's pi transcript —
 * run separators, abbreviated thinking, assistant text, and tool calls. Read-only; the raw
 * log is pi's streaming event stream, so only complete renderable events are shown. */
async function cmdLogsTranscript(root: string, role: string, limit: number, follow: boolean): Promise<void> {
  const file = piLogPath(root, role);

  const printEntry = (lines: string[]) => {
    if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");
  };

  // Initial window: the last `limit` entries of what is on disk. readTranscriptTail scans back
  // from EOF only as far as needed instead of re-reading the whole (up to logMaxBytes) file,
  // and its offset stops at the last complete newline, so a torn trailing line is re-read once
  // it completes instead of lost.
  let offset = 0;
  const tail = readTranscriptTail(file, limit); // null when there's no log yet (or it's empty).
  if (!tail) {
    process.stdout.write(`no transcript yet for ${role}\n`);
  } else {
    for (const entry of tail.entries) printEntry(entry);
    offset = tail.end;
  }
  if (!follow) return;

  // Follow from where the initial window stopped, so each turn prints exactly once when its
  // message_end lands (torn trailing lines are held back by followFile). A fresh renderer:
  // readTranscriptTail's formatTranscript already flushed any pending separator for what was on disk.
  const renderer = createTranscriptRenderer();
  followFile(file, offset, (lines) => {
    for (const line of lines) printEntry(renderer.feed(line));
  });
  await new Promise(() => {}); // Follow until Ctrl+C.
}

/** `tumwater reset-counters [--role <id>]`: zero the per-loop counters shown in the
 * dashboards so a fresh observation window can begin. Zeroes each target's state file
 * directly (works while the harness is not running) and drops a marker that a running fleet
 * consumes within one poll cycle — it must also zero the runners' in-memory copies, or their
 * next save resurrects the pre-reset values. Scheduling fields and pi session continuity are
 * untouched: loops keep sleeping/waking exactly as before. */
async function cmdResetCounters(root: string, args: string[]): Promise<void> {
  const config = loadConfig(root);
  const role = parseRoleFlag(args);
  const targets = role ? [role] : Object.keys(config.roles); // Default: every role in the config.
  for (const r of targets) saveLoopState(root, zeroCounters(loadLoopState(root, r)));
  const markerFile = resetRequestPath(root);
  ensureParentDir(markerFile);
  fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), roles: targets }, null, 2));
  process.stdout.write(`counters reset for ${targets.join(", ")} — a running fleet picks this up within ~2s\n`);
}

/** `tumwater abort --role <id>`: kill one loop's in-flight tick right now. The CLI cannot
 * reach into the orchestrator process, so the request rides on disk like reset-counters':
 * a per-role marker file a running fleet consumes within one poll cycle (the runner's
 * abortTick kills the pi child and resets the worktree to main). Requires a live harness —
 * with no fleet there is nothing to consume the marker. The loop stays enabled: it backs
 * off normally and later ticks proceed as usual. */
async function cmdAbort(root: string, args: string[]): Promise<void> {
  const role = parseRoleFlag(args);
  if (!role) fail("abort requires --role <id> (e.g. `--role feature`)");
  if (!orchestratorAlive(root)) fail("no harness is running — start it with `tumwater run` first");
  const markerFile = abortRequestPath(root, role);
  ensureParentDir(markerFile);
  fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now() }, null, 2));
  process.stdout.write(`abort requested for ${role} — a running fleet applies it within ~2s\n`);
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const root = process.cwd();
  switch (command) {
    case "init":
      await cmdInit(root, args);
      break;
    case "run":
      rejectUnknownArgs("run", args, []);
      await cmdRun(root);
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
      rejectUnknownArgs("status", args, []);
      await requireReadyRepo(root);
      process.stdout.write(
        renderStatus(root, snapshot(root), process.stdout.isTTY ? process.stdout.columns : undefined) + "\n",
      );
      break;
    case "logs":
      rejectUnknownArgs("logs", args, [
        { names: ["-f", "--follow"] },
        { names: ["-n"], value: true, valueName: "<count>" },
        { names: ["--role"], value: true, valueName: "<id>" },
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
          fail(err instanceof Error ? err.message : String(err));
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
    case "abort": {
      rejectUnknownArgs("abort", args, [{ names: ["--role"], value: true, valueName: "<id>" }]);
      await requireReadyRepo(root);
      await cmdAbort(root, args);
      break;
    }
    case "version":
    case "--version":
    case "-v": {
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
      process.stdout.write(HELP);
      break;
    default:
      fail(`unknown command: ${command} (try \`tumwater help\`)`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
