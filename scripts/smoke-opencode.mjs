// Opt-in live check for the opencode backend (plans/opencode-backend.md "H2", PLANS.md
// "OpenCode backend, part 7/7"). The fake-opencode suite replays canned captures; this script
// drives the REAL `opencode` on PATH in a throwaway git repo, so a regression the fake cannot
// see — a version OpenCode refuses, a config that leaks the operator's global server into team
// runs, a resume that stopped finding its session, the MCP first-request gap — fails here by
// hand instead of in the team. It needs a working OpenCode install and reaches the real CLI, so
// it is NOT part of `npm test` (which must stay green on a machine with no opencode installed).
//
// Every check prints a named PASS/FAIL and the script exits nonzero on the FIRST failure.
// Run the compiled build first: `npm run build && npm run smoke:opencode`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireDistBuild } from "./live-fixture.mjs";

requireDistBuild(
  "../dist/src/agent/agent-run.js",
  "smoke:opencode drives the compiled opencode backend",
);

// agent-run registers the backends on import, so this import brings `opencode` online too.
const { runAgent } = await import("../dist/src/agent/agent-run.js");
const { defaultConfig } = await import("../dist/src/config/config.js");
const { readSessions } = await import("../dist/src/agent/session-ledger.js");
const { opencodeBackend } = await import("../dist/src/agent/opencode/opencode-backend.js");
const { readOpencodeCache, writeOpencodeCache } = await import(
  "../dist/src/agent/opencode/opencode-catalog.js"
);
const { opencodeModelsPath } = await import("../dist/src/paths.js");

/** A named check that aborts the run on failure, so the first FAIL is the last output. */
class SmokeFailure extends Error {}

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`PASS ${name}`);
    return;
  }
  console.log(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  throw new SmokeFailure(name);
}

/** The free model this whole check exists to guard (design "Goal"). */
const FREE_MODEL = "opencode/deepseek-v4.1-flash-free";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tw-smoke-opencode-"));
const REPO = path.join(ROOT, "repo");
fs.mkdirSync(REPO);
spawnSync("git", ["init", "-q"], { cwd: REPO });
// opencode resolves symlinks in its cwd.
const CWD = fs.realpathSync(REPO);
// Sessions live under `ROOT/.tumwater/sessions`, the same shape a real team run uses, so
// teamRootOf resolves the throwaway ROOT (not the platform temp dir) and the run's shared
// opencode db and catalog cache are the throwaway ones seeded below.
const SESSIONS = path.join(ROOT, ".tumwater", "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });
const BASE = { ...defaultConfig(), agent: "opencode", model: FREE_MODEL };

let logSeq = 0;
/** One live run through the real adapter, exactly as a run builds it. */
function runOpencode({ prompt, sessionName, continueSession = false, signal, notesPath }) {
  logSeq += 1;
  return runAgent({
    cwd: CWD,
    prompt,
    config: BASE,
    sessionDir: SESSIONS,
    sessionName,
    rawLogFile: path.join(ROOT, `raw-${logSeq}.jsonl`),
    nativeLogFile: path.join(ROOT, `native-${logSeq}.jsonl`),
    kind: "author",
    continueSession,
    ...(signal !== undefined ? { signal } : {}),
    ...(notesPath !== undefined ? { notesPath } : {}),
  });
}

/** The newest ledger record, or undefined when the ledger is empty. */
function newestSession() {
  return readSessions(SESSIONS).at(-1);
}

let exitCode = 0;
try {
  const resolved = opencodeBackend.resolveBin(BASE);

  // 0. The CLI is present; a version below 2.0.32 (or a 1.x binary) would refuse the invocations
  //    below, so the harness's own gate is exercised first.
  const versionOut = spawnSync(resolved.bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const version = /v(\d+\.\d+\.\d+)/.exec(versionOut.stdout ?? "")?.[1];
  check(
    "opencode CLI present (v2)",
    version !== undefined && Number.parseInt(version.split(".")[0], 10) === 2,
    versionOut.error?.message ?? `version=${version ?? versionOut.stdout?.trim() ?? "<none>"}`,
  );

  // Seed the catalog cache for the free model so the run prices against it and the last check
  // can assert free-ness. The real seed (startup gate) fetches models.dev; this only needs the
  // free model to be in view.
  writeOpencodeCache(ROOT, {
    fetchedAt: Date.now(),
    cliVersion: version,
    models: {
      [FREE_MODEL]: { free: true, context: 200_000 },
    },
  });

  // 1. A three-step run on the free model that reads, edits and checks a file — the exact
  //    production invocation shape (design "Goal").
  fs.writeFileSync(path.join(CWD, "README.md"), "hello\n");
  const three = await runOpencode({
    prompt: [
      "This is an isolated smoke test. Make exactly three separate tool calls, one at a time:",
      "1. Read the README.md in the current directory.",
      "2. Edit it: append the line `smoke-opencode ran here`.",
      "3. Check it: run `cat README.md`.",
      "After the third tool result, reply with exactly SMOKE_THREE_DONE and nothing else.",
    ].join("\n"),
    sessionName: "three",
  });
  check(
    "three-step read/edit/check run on the free model",
    three.ok && !three.configError && three.finalText.includes("SMOKE_THREE_DONE"),
    three.errorMessage ?? three.finalText,
  );
  check(
    "the free model run costs $0",
    three.costUsd === 0,
    `cost=$${three.costUsd} ${three.errorMessage ?? ""}`,
  );
  check(
    "tokens came from the run_usage export",
    // The final step's usage only reaches the parser through the post-run export (design §6):
    // a nonzero prompt/output token count means run_usage was reconciled.
    three.promptTokens > 0 && three.outputTokens > 0,
    `prompt=${three.promptTokens} output=${three.outputTokens}`,
  );

  // 2. Resume the session: the ledger's newest record must keep the same id (the existence
  //    check found the session and `--session <id>` was passed, not a fresh session).
  const recorded = newestSession();
  const resumed = await runOpencode({
    prompt: [
      "The smoke test earlier told you it ran `smoke-opencode ran here`. Reply with exactly ",
      "SMOKE_RESUMED and nothing else.",
    ].join(""),
    sessionName: "three",
    continueSession: true,
  });
  check(
    "--session reuses the three-step session",
    recorded !== undefined && resumed.ok && newestSession()?.id === recorded.id,
    `before=${recorded?.id ?? "<none>"} after=${newestSession()?.id ?? "<none>"} ${resumed.errorMessage ?? ""}`,
  );

  // 3. SIGTERM during a long `node` shell command, then no marked process survives (finding 18:
  //    a background command is killed when the run ends, so the run's process group is swept).
  //
  //    OpenCode reports a tool call only once it has ENDED (the translator's tool_execution_start
  //    fires at step_finish), so onToolCallStart never fires for a command that never ends and the
  //    run would hang. Wait instead for the command to announce itself through its own marker —
  //    the node -e writes its pid the moment it is running — then SIGTERM the run's group.
  const marks = path.join(ROOT, "marks");
  fs.mkdirSync(marks);
  const killPid = path.join(marks, "pid");
  const controller = new AbortController();
  const runPromise = runOpencode({
    prompt: [
      "Use the shell tool to run this foreground command and wait for it to finish:",
      `node -e "require('fs').writeFileSync('${killPid}', String(process.pid)); setInterval(()=>{},1000)"`,
      "Then reply with exactly SMOKE_WAKE and nothing else.",
    ].join("\n"),
    sessionName: "sigterm",
    signal: controller.signal,
  });
  // Poll for the node command's own pid marker; once it is live the run is mid-command, so
  // abort (SIGTERM the run's group) and the sweep reaps the marked foreground process.
  let sawMark = false;
  const markDeadline = Date.now() + 60_000;
  while (Date.now() < markDeadline) {
    if (fs.existsSync(killPid)) {
      sawMark = true;
      controller.abort();
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!sawMark) controller.abort();
  const killed = await runPromise;
  // Give the SIGTERM a moment to sweep the group before probing the marked process.
  await new Promise((r) => setTimeout(r, 500));
  // The shell tool ran and marked a pid, and the run was aborted mid-command (a slow command);
  // then the marked node process must be gone.
  check(
    "SIGTERM mid-command aborts the run",
    sawMark && killed.aborted === true,
    `${sawMark ? "" : "shell tool never marked a pid; "}${killed.errorMessage ?? ""}`,
  );
  const pid = Number.parseInt(fs.readFileSync(killPid, "utf8"), 10);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  check("no marked process survives the SIGTERM", !alive, `pid ${pid} still alive`);

  // 4. The real usage pattern: a run that reads a file, runs a command, and then saves a role
  //    note before it ends, through the `tumwater-notes` command on PATH (no MCP server).
  const notesPath = path.join(ROOT, "role-notes.md");
  fs.writeFileSync(path.join(CWD, "file.txt"), "x\n");
  const noted = await runOpencode({
    prompt: [
      "Read file.txt, run `printf ok > ran.txt`, and before you end write your role note by ",
      "running exactly this shell command and nothing else:",
      "tumwater-notes write <<'TUMWATER_NOTES'",
      "SMOKE_NOTE_SAVED",
      "TUMWATER_NOTES",
    ].join("\n"),
    sessionName: "notes",
    notesPath,
  });
  check(
    "a run can read and run commands",
    noted.ok === true && fs.existsSync(path.join(CWD, "ran.txt")),
    noted.errorMessage ?? "",
  );
  const noteText = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : "";
  check(
    "end-of-run role note is saved",
    noted.ok === true && noteText.includes("SMOKE_NOTE_SAVED"),
    `notes=${JSON.stringify(noteText)} ${noted.errorMessage ?? ""}`,
  );

  // 5. The catalog cache still calls the model free (design §7): the free-ness that let the cost
  //    checks above pass must be what the running team sees.
  const cache = readOpencodeCache(ROOT);
  const entry = cache.models[FREE_MODEL];
  check(
    "catalog cache calls the model free",
    entry !== undefined && entry.free === true,
    `cache at ${opencodeModelsPath(ROOT)} entry=${JSON.stringify(entry)}`,
  );

  console.log("SMOKE PASS");
} catch (err) {
  exitCode = 1;
  if (!(err instanceof SmokeFailure)) console.error(err);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
process.exit(exitCode);
