// Opt-in live check for the codex backend (plans/codex-backend.md "Hand steps" H2, PLANS.md
// "Codex backend, part 9d/9"). The fake-codex suite replays canned captures; this script
// drives the REAL `codex` on PATH in a throwaway git repo, so a regression the fake cannot
// see — a CLI too old to accept the gated model, an isolation bug that loads the operator's
// personal config (the first-request token ceiling), a resume that stopped finding its
// session, the rate-limit windows the rollout carries — fails here by hand instead of in the
// team. It needs a working Codex install logged into a ChatGPT subscription and reaches the
// real CLI, so it is NOT part of `npm test` (which must stay green on a machine with no codex
// installed).
//
// Every check prints a named PASS/FAIL and the script exits nonzero on the FIRST failure.
// `--help` (or `--dry-run`) lists every step without spawning codex. Run the compiled build
// first: `npm run build && npm run smoke:codex`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireDistBuild } from "./live-fixture.mjs";

requireDistBuild(
  "../dist/src/agent/run-agent.js",
  "smoke:codex drives the compiled codex backend",
);

// run-agent registers the backends on import, so this import brings `codex` online too.
const { runAgent } = await import("../dist/src/agent/run-agent.js");
const { defaultConfig } = await import("../dist/src/config/config.js");
const { routeModel } = await import("../dist/src/config/model-selector.js");
const { readSessions } = await import("../dist/src/agent/session-ledger.js");
const { codexBackend } = await import("../dist/src/agent/codex/codex-backend.js");

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

/** Compare dotted numeric versions; 0.163.0 vs 0.162.0 -> positive. */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10));
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const DRY_RUN = process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("--dry-run");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tw-smoke-codex-"));
const REPO = path.join(ROOT, "repo");
fs.mkdirSync(REPO);
spawnSync("git", ["init", "-q"], { cwd: REPO });
// codex resolves symlinks in its cwd, and the session ledger must live under a .tumwater
// root so the adapter resolves the team root of the throwaway layout (same shape as opencode's
// smoke: SESSIONS = ROOT/.tumwater/sessions).
const CWD = fs.realpathSync(REPO);
const SESSIONS = path.join(ROOT, ".tumwater", "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });
// The default tier model, read from the same routing a seam uses instead of listed again.
const MODEL = routeModel(undefined, undefined, "codex", "default").model;
const BASE = { ...defaultConfig(), agent: "codex", model: MODEL };

let logSeq = 0;
/** One live run through the real adapter, exactly as a tick builds it. */
function runCodex({ prompt, sessionName, continueSession = false, signal, notesPath, onAgentWarning }) {
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
    ...(onAgentWarning !== undefined ? { onAgentWarning } : {}),
  });
}

/** The newest ledger record, or undefined when the ledger is empty. */
function newestSession() {
  return readSessions(SESSIONS).at(-1);
}

let exitCode = 0;
try {
  const steps = [];
  const step = (name, run) => steps.push({ name, run });

  step("codex CLI present (>= 0.163.0)", async () => {
    const resolved = codexBackend.resolveBin(BASE);
    const versionOut = spawnSync(resolved.bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
    const version = /(\d+\.\d+\.\d+)/.exec(versionOut.stdout ?? "")?.[1];
    check(
      "codex CLI present (>= 0.163.0)",
      version !== undefined && compareVersions(version, "0.163.0") >= 0,
      versionOut.error?.message ?? `version=${version ?? versionOut.stdout?.trim() ?? "<none>"}`,
    );
  });

  step("a fresh run reads, edits and checks a file", async () => {
    fs.writeFileSync(path.join(CWD, "README.md"), "hello\n");
    const three = await runCodex({
      prompt: [
        "This is an isolated smoke test. Make exactly three separate tool calls, one at a time, waiting for each result:",
        "1. Read the README.md in the current directory.",
        "2. Edit it (with apply_patch): append the line `smoke-codex ran here`.",
        "3. Check it: run `cat README.md`.",
        "After the third tool result, reply with exactly SMOKE_THREE_DONE and nothing else.",
      ].join("\n"),
      sessionName: "three",
    });
    check(
      "a fresh run reads, edits and checks a file",
      three.ok && !three.configError && three.finalText.includes("SMOKE_THREE_DONE"),
      three.errorMessage ?? three.finalText,
    );
    check(
      "the edit and the command landed in the worktree",
      fs.readFileSync(path.join(CWD, "README.md"), "utf8").includes("smoke-codex ran here"),
      fs.readFileSync(path.join(CWD, "README.md"), "utf8"),
    );
  });

  step("--session resumes the three-step session", async () => {
    const recorded = newestSession();
    check(
      "the three-step run recorded a session",
      recorded !== undefined,
      "the ledger has no session to resume",
    );
    const resumed = await runCodex({
      prompt: [
        "The smoke test earlier told you it ran `smoke-codex ran here`. Reply with exactly ",
        "SMOKE_RESUMED and nothing else.",
      ].join(""),
      sessionName: "three",
      continueSession: true,
    });
    check(
      "--session resumes the three-step session",
      resumed.ok && newestSession()?.id === recorded.id,
      `before=${recorded.id} after=${newestSession()?.id ?? "<none>"} ${resumed.errorMessage ?? ""}`,
    );
  });

  step("a SIGTERM mid-command aborts and reaps the marked process", async () => {
    const marks = path.join(ROOT, "marks");
    fs.mkdirSync(marks);
    const killPid = path.join(marks, "pid");
    const controller = new AbortController();
    const runPromise = runCodex({
      prompt: [
        "Use the shell tool to run this foreground command and wait for it to finish:",
        `node -e "require('fs').writeFileSync('${killPid}', String(process.pid)); setInterval(()=>{},1000)"`,
        "Then reply with exactly SMOKE_WAKE and nothing else.",
      ].join("\n"),
      sessionName: "sigterm",
      signal: controller.signal,
    });
    let sawMark = false;
    const markDeadline = Date.now() + 120_000;
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
    await new Promise((r) => setTimeout(r, 500));
    check(
      "a SIGTERM mid-command aborts the run",
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
  });

  step("a run saves its end-of-run note through tumwater-notes", async () => {
    const notesPath = path.join(ROOT, "role-notes.md");
    fs.writeFileSync(path.join(CWD, "file.txt"), "x\n");
    const noted = await runCodex({
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
      "a run can read files and run commands",
      noted.ok === true && fs.existsSync(path.join(CWD, "ran.txt")),
      noted.errorMessage ?? "",
    );
    const noteText = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8") : "";
    check(
      "end-of-run role note is saved",
      noted.ok === true && noteText.includes("SMOKE_NOTE_SAVED"),
      `notes=${JSON.stringify(noteText)} ${noted.errorMessage ?? ""}`,
    );
  });

  step("the first request stays under 10,000 input tokens (isolation)", async () => {
    // A single-turn run's whole cost is the first request, so promptTokens is the number the
    // plan pins: ~8,059 on 0.163.0, far under the 10,000 ceiling that a regression loading the
    // operator's personal config blows past (plans/codex-backend.md "Risks", the base prompt).
    const iso = await runCodex({
      prompt: "Reply with exactly SMOKE_ISOLATED and nothing else.",
      sessionName: "isolation",
    });
    check(
      "a minimal run stays under 10k first-request tokens",
      iso.ok === true && iso.promptTokens < 10_000,
      `prompt=${iso.promptTokens} preEdit=${iso.preEditPromptTokens} ${iso.errorMessage ?? ""}`,
    );
  });

  step("a 90s command runs to completion without codex_command_abandoned", async () => {
    // A command longer than the model would naturally wait for, polled to completion: if codex
    // ends its turn while the check still runs (finding 19) the translator marks the open
    // command `codex_command_abandoned`, so the assertion is that the marker file lands (the
    // command finished inside the run) and the warning stays absent. The run resolves when the
    // model replies after the command; a hard deadline guards against a hung model or CLI.
    const doneMark = path.join(ROOT, "long-done");
    let sawAbandoned = false;
    const controller = new AbortController();
    const runPromise = runCodex({
      prompt: [
        "Use the shell tool to run this foreground command and wait for it to finish:",
        `node -e "setTimeout(()=>{require('fs').writeFileSync('${doneMark}','1')},90000)"`,
        "Then reply with exactly SMOKE_LONG_DONE and nothing else.",
      ].join("\n"),
      sessionName: "long",
      signal: controller.signal,
      onAgentWarning: (w) => {
        if (w === "codex_command_abandoned") sawAbandoned = true;
      },
    });
    const runResult = await Promise.race([
      runPromise,
      new Promise((resolve) =>
        setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, 180_000),
      ),
    ]);
    const slow = runResult === undefined;
    check(
      "a 90s command runs to completion without codex_command_abandoned",
      !slow && fs.existsSync(doneMark) && !sawAbandoned,
      `${slow ? "run exceeded 180s and was aborted; " : ""}${sawAbandoned ? "codex_command_abandoned; " : ""}${slow || !fs.existsSync(doneMark) ? "marker missing; command did not finish inside the run" : ""}`,
    );
  });

  step("the rollout reports a five_hour and a seven_day window", async () => {
    // The run's afterRun read the authoritative rollout under the team home (codexHome for the
    // run config), so the two codex rate windows surface on the result only when the rollout's
    // `token_count` carried both (plans/codex-backend.md §7, decision 7). Missing either is a
    // rollout-format regression the fake suite cannot see.
    const read = await runCodex({
      prompt: "Reply with exactly SMOKE_WINDOW and nothing else.",
      sessionName: "windows",
    });
    const types = (read.rateWindows ?? []).map((w) => w.type);
    check(
      "the rollout reports a five_hour window",
      read.billing === "subscription" && types.includes("five_hour"),
      `windows=${types.join(",") || "<none>"} billing=${read.billing ?? "<none>"} ${read.errorMessage ?? ""}`,
    );
    check(
      "the rollout reports a seven_day window",
      types.includes("seven_day"),
      `windows=${types.join(",") || "<none>"} ${read.errorMessage ?? ""}`,
    );
  });

  if (DRY_RUN) {
    console.log("smoke:codex dry run — no codex spawned. Steps:");
    for (const s of steps) console.log(`  ${s.name}`);
    console.log("SMOKE DRY RUN");
  } else {
    for (const s of steps) await s.run();
    console.log("SMOKE PASS");
  }
} catch (err) {
  exitCode = 1;
  if (!(err instanceof SmokeFailure)) console.error(err);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
process.exit(exitCode);
