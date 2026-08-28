#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enabledRoleIds, loadConfig } from "./config.js";
import { allRoleIds } from "./roles.js";
import { loadLoopState, orchestratorAlive, saveLoopState, zeroCounters } from "./state.js";
import { createTranscriptRenderer, formatTranscript } from "./transcript.js";
import { currentBranch, hasCommits, isGitRepo } from "./git.js";
import { initProject } from "./init.js";
import { submitPrompt } from "./inbox.js";
import { readEvents, subscribeEvents } from "./events.js";
import { formatEvent } from "./event-format.js";
import { runOrchestrator } from "./orchestrator.js";
import { findOnPath, statOrNull } from "./files.js";
import { followFile, readCompleteLines } from "./tail.js";
import { snapshot } from "./status.js";
import { renderStatus } from "./status-render.js";
import { runTui } from "./tui.js";
import { startGui } from "./gui.js";
import { eventsLogPath, piLogPath, resetRequestPath } from "./paths.js";

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
  tumwater logs --role <id> [-f]   Show (and follow) that loop's pi transcript
  tumwater prompt <text...>        Queue a prompt for the director loop
  tumwater reset-counters [--role <id>]   Zero ticks/commits/tokens/cost (fresh observation window)
  tumwater help | version

The harness runs inside a git repo. Each role loop owns a persistent worktree and branch
under .tumwater/, does one task per tick with pi, commits, and merges to main. Loops back
off while the project is quiet and wake when main moves. Everything is local: no remotes.
`;

function fail(message: string): never {
  process.stderr.write(`tumwater: ${message}\n`);
  process.exit(1);
}

/** Parse a `-n`-style count flag value: a positive integer, or fail with a clear message.
 * Unvalidated, NaN/0/negative limits make readEvents' `slice(-limit)` dump the whole log
 * (or drop leading lines) instead of showing the requested tail. */
function parseCountFlag(flag: string, raw: string | undefined): number {
  if (raw === undefined) fail(`${flag} needs a value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} needs a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}

/** External IPv4 addresses of this machine's network interfaces, for printing the URLs a
 * `gui --all-interfaces` server is reachable at. IPv6 and internal (loopback) addresses are
 * skipped: the loopback URL is printed separately, and bracketed IPv6 URLs are rarely what
 * someone types on another device. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** Parse the `--port` flag value: an integer in 1..65535, or fail with a clear message.
 * Port 0 would make Node pick an ephemeral port while the CLI prints :0 — a URL that
 * cannot be opened; out-of-range values only fail later via Node's raw RangeError. */
function parsePortFlag(raw: string | undefined): number {
  if (raw === undefined) fail("--port needs a value");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    fail(`--port must be an integer between 1 and 65535 (got ${JSON.stringify(raw)})`);
  return n;
}

/** Parse an optional `--role <id>` flag: the validated role id, or null when absent.
 * Shared by every command that scopes to one loop so their validation and error messages
 * cannot drift. */
function parseRoleFlag(args: string[]): string | null {
  const i = args.indexOf("--role");
  if (i < 0) return null;
  const role = args[i + 1];
  if (!role) fail("--role needs a role id (e.g. `--role feature`)");
  if (!allRoleIds().includes(role)) fail(`unknown role: ${role} (valid ids: ${allRoleIds().join(", ")})`);
  return role;
}

/** One flag in a command's fixed argument vocabulary: every spelling it accepts and whether
 * it takes one following token as its value (named for the error message). */
interface FlagSpec {
  /** Every accepted spelling, e.g. ["-f", "--follow"]. */
  names: string[];
  /** True when the flag consumes one following token as its value. */
  value?: boolean;
  /** How the value is named in error messages (e.g. "<id>"); defaults to "<value>". */
  valueName?: string;
}

/** Fail when any argument was not consumed by this command's known flags — a misspelled flag
 * (e.g. `--rol` instead of `--role`) would otherwise be silently ignored and the command runs
 * with default behavior, which is worse than an error: `reset-counters --rol x` zeroed every
 * loop instead of one, and `gui --portt 8080` served on the default port. Valueless flags claim
 * one token; valued flags claim two (a trailing flag with no value claims only itself — the
 * command's own parser reports the missing value first). Duplicates keep their existing
 * behavior: the first occurrence wins. */
function rejectUnknownArgs(command: string, args: string[], specs: FlagSpec[]): void {
  if (args.length === 0) return;
  const claim = new Map<string, number>();
  for (const spec of specs) for (const name of spec.names) claim.set(name, spec.value ? 2 : 1);
  const consumed = new Array<boolean>(args.length).fill(false);
  for (let i = 0; i < args.length; i++) {
    if (consumed[i]) continue;
    const arg = args[i] ?? ""; // Unreachable fallback: the loop bound guarantees a token here.
    const n = claim.get(arg);
    if (n === undefined) {
      const valid = specs
        .map((s) => s.names.join("/") + (s.value ? ` ${s.valueName ?? "<value>"}` : ""))
        .join(", ");
      fail(
        specs.length === 0
          ? `tumwater ${command} takes no arguments`
          : `unknown argument: ${arg} (valid flags for tumwater ${command}: ${valid})`,
      );
    }
    for (let j = 0; j < n && i + j < args.length; j++) consumed[i + j] = true;
  }
}

async function resolveMainBranch(root: string): Promise<string> {
  const branch = await currentBranch(root);
  if (!branch) fail("the repo's primary checkout is detached; check out your main branch first");
  return branch;
}

async function requireReadyRepo(root: string): Promise<void> {
  if (!(await isGitRepo(root))) fail("not a git repository (run `git init` first)");
  if (!fs.existsSync(path.join(root, "tumwater.json"))) {
    fail("not initialized (run `tumwater init <prompt>` first)");
  }
  if (!(await hasCommits(root))) fail("the repo has no commits yet; `tumwater init` creates the first one");
}

/** `tumwater init` argument handling. Every other command runs rejectUnknownArgs, but init's
 * positionals are free-form prompt text, so that helper (which rejects ANY unconsumed token)
 * can't be used wholesale. The rules instead: a double-dash token must be `--file`, given at
 * most once; with `--file` present nothing else may follow it; single-dash positionals are
 * prompt content, not flags. Without these checks a misspelled --file would be baked into the
 * initial prompt — injected into every tick of every loop until someone edits README.md.
 */
function parseInitArgs(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--file") {
      fail(`unknown argument: ${arg} (valid flags for tumwater init: --file <path>)`);
    }
  }
  const fileFlag = args.indexOf("--file");
  if (fileFlag >= 0) {
    if (args.filter((a) => a === "--file").length > 1) fail("--file may only be given once");
    const file = args[fileFlag + 1];
    if (!file) fail("--file needs a path");
    const extra = args.find((_, i) => i !== fileFlag && i !== fileFlag + 1);
    if (extra !== undefined) {
      fail(`unexpected argument ${JSON.stringify(extra)} — with --file the prompt comes from the file`);
    }
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      // A raw ENOENT/EISDIR names the path but not its role; say this was the --file prompt.
      fail(`cannot read prompt file ${JSON.stringify(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return args.join(" ");
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  const size = statOrNull(file)?.size ?? 0; // No log yet → 0.

  const printEntry = (lines: string[]) => {
    if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");
  };

  // Initial window: the last `limit` entries of what is on disk. The offset stops at the
  // last complete newline, so a torn trailing line is re-read once it completes instead of lost.
  let offset = 0;
  if (size > 0) {
    const { lines, end } = readCompleteLines(file, 0, size);
    for (const entry of formatTranscript(lines).slice(-limit)) printEntry(entry);
    offset = end;
  } else {
    process.stdout.write(`no transcript yet for ${role}\n`);
  }
  if (!follow) return;

  // Follow from where the initial window stopped, so each turn prints exactly once when its
  // message_end lands (torn trailing lines are held back by followFile). A fresh renderer:
  // formatTranscript already flushed any pending separator for what was on disk.
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
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), roles: targets }, null, 2));
  process.stdout.write(`counters reset for ${targets.join(", ")} — a running fleet picks this up within ~2s\n`);
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
      const text = args.join(" ").trim();
      if (!text) fail("prompt text required");
      submitPrompt(root, text);
      process.stdout.write("queued for the director loop\n");
      break;
    }
    case "reset-counters": {
      rejectUnknownArgs("reset-counters", args, [{ names: ["--role"], value: true, valueName: "<id>" }]);
      await requireReadyRepo(root);
      await cmdResetCounters(root, args);
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
