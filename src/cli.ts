#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { enabledRoleIds, loadConfig } from "./config.js";
import { currentBranch, hasCommits, isGitRepo } from "./git.js";
import { initProject } from "./init.js";
import { enqueuePrompt } from "./inbox.js";
import { formatEvent, logEvent, readEvents, subscribeEvents } from "./events.js";
import { orchestratorAlive, runOrchestrator } from "./orchestrator.js";
import { renderStatus, snapshot } from "./status.js";
import { runTui } from "./tui.js";
import { startGui } from "./gui.js";
import { eventsLogPath } from "./paths.js";

const HELP = `automaton — autonomous development harness built on pi

Usage:
  automaton init <prompt...>        Initialize this repo (or --file <prompt.md>)
  automaton run                     Run all enabled loops (headless; Ctrl+C stops)
  automaton tui                     Dashboard + prompt input (observes a running \`automaton run\`)
  automaton gui [--port N]          Same dashboard in the browser (default port 7180)
  automaton status                  One-shot status table
  automaton logs [-f] [-n N]        Show (and follow) harness events
  automaton prompt <text...>        Queue a prompt for the director loop
  automaton help | version

The harness runs inside a git repo. Each role loop owns a persistent worktree and branch
under .automaton/, does one task per tick with pi, commits, and merges to main. Loops back
off while the project is quiet and wake when main moves. Everything is local: no remotes.
`;

function fail(message: string): never {
  process.stderr.write(`automaton: ${message}\n`);
  process.exit(1);
}

async function resolveMainBranch(root: string): Promise<string> {
  const branch = await currentBranch(root);
  if (!branch) fail("the repo's primary checkout is detached; check out your main branch first");
  return branch;
}

async function requireReadyRepo(root: string): Promise<void> {
  if (!(await isGitRepo(root))) fail("not a git repository (run `git init` first)");
  if (!fs.existsSync(path.join(root, "automaton.json"))) {
    fail("not initialized (run `automaton init <prompt>` first)");
  }
  if (!(await hasCommits(root))) fail("the repo has no commits yet; `automaton init` creates the first one");
}

async function cmdInit(root: string, args: string[]): Promise<void> {
  let prompt: string;
  const fileFlag = args.indexOf("--file");
  if (fileFlag >= 0) {
    const file = args[fileFlag + 1];
    if (!file) fail("--file needs a path");
    prompt = fs.readFileSync(file, "utf8");
  } else {
    prompt = args.join(" ");
  }
  const result = await initProject(root, prompt);
  if (result.created.length === 0) {
    process.stdout.write("already initialized; nothing to do\n");
    return;
  }
  process.stdout.write(`created ${result.created.join(", ")}${result.committed ? " (committed)" : ""}\n`);
  process.stdout.write("next: `automaton run` in one terminal, `automaton tui` in another\n");
}

async function cmdRun(root: string): Promise<void> {
  await requireReadyRepo(root);
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
  process.stdout.write(`automaton running on branch ${mainBranch} — Ctrl+C to stop\n`);
  process.stdout.write(`loops: ${enabled.join(", ")}\n`);
  process.stdout.write("watch: `automaton tui` or `automaton logs -f` in another terminal; events stream below\n\n");
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
  const limit = nFlag >= 0 ? parseInt(args[nFlag + 1] ?? "50", 10) : 50;
  for (const e of readEvents(root, limit)) process.stdout.write(formatEvent(e) + "\n");
  if (!follow) return;
  const file = eventsLogPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  let offset = fs.statSync(file).size;
  fs.watchFile(file, { interval: 500 }, () => {
    const size = fs.statSync(file).size;
    if (size <= offset) {
      offset = size;
      return;
    }
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
      try {
        process.stdout.write(formatEvent(JSON.parse(line)) + "\n");
      } catch {
        // Torn write; the next change event re-reads from the new offset.
      }
    }
  });
  await new Promise(() => {}); // Follow until Ctrl+C.
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const root = process.cwd();
  switch (command) {
    case "init":
      await cmdInit(root, args);
      break;
    case "run":
      await cmdRun(root);
      break;
    case "tui":
      await requireReadyRepo(root);
      await runTui(root);
      break;
    case "gui": {
      await requireReadyRepo(root);
      const portFlag = args.indexOf("--port");
      const port = portFlag >= 0 ? parseInt(args[portFlag + 1] ?? "", 10) : 7180;
      if (!Number.isFinite(port)) fail("--port needs a number");
      await startGui(root, port);
      process.stdout.write(`automaton gui at http://127.0.0.1:${port} — Ctrl+C to stop\n`);
      await new Promise(() => {}); // Serve until Ctrl+C.
      break;
    }
    case "status":
      await requireReadyRepo(root);
      process.stdout.write(renderStatus(root, snapshot(root)) + "\n");
      break;
    case "logs":
      await requireReadyRepo(root);
      await cmdLogs(root, args);
      break;
    case "prompt": {
      await requireReadyRepo(root);
      const text = args.join(" ").trim();
      if (!text) fail("prompt text required");
      enqueuePrompt(root, text);
      logEvent(root, { loop: "director", type: "prompt_enqueued", preview: text.slice(0, 80) });
      process.stdout.write("queued for the director loop\n");
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
      fail(`unknown command: ${command} (try \`automaton help\`)`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
