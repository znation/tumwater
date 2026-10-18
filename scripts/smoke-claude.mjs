// Opt-in live check for the claude backend (plans/agent-backends.md "Testing", PLANS.md
// "Agent backends, part 7c/7"). The fake-claude suite replays canned stream-json; this script
// drives the REAL `claude` on PATH in a throwaway git repo, so a regression the fake cannot
// see — an old CLI that refuses a default model, an isolation bug that loads the operator's
// personal config, a resume that stopped finding its transcript — fails here by hand instead
// of in the team. It costs a few cents of API-equivalent spend on a subscription and needs a
// logged-in CLI, so it is NOT part of `npm test` (which strips TUMWATER_CLAUDE_BIN/CLAUDECODE
// and must stay green on a machine with no claude installed).
//
// Every check prints a named PASS/FAIL and the script exits nonzero on the FIRST failure.
// Run the compiled build first: `npm run build && npm run smoke:claude`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireDistBuild } from "./live-fixture.mjs";

requireDistBuild(
  "../dist/src/agent/run-agent.js",
  "smoke:claude drives the compiled claude backend",
);

// run-agent registers the backends on import, so this import brings `claude` online too.
const { runAgent } = await import("../dist/src/agent/run-agent.js");
const { defaultConfig } = await import("../dist/src/config/config.js");
const { routeModel } = await import("../dist/src/config/model-selector.js");
const { readSessions } = await import("../dist/src/agent/session-ledger.js");
const { claudeBackend } = await import("../dist/src/agent/claude/claude-backend.js");
const { claudeEnv } = await import("../dist/src/agent/claude/claude-env.js");
const { observeClaudeAccount, readClaudeAccount } = await import(
  "../dist/src/agent/claude/claude-account.js"
);

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

/** Compare dotted numeric versions; 2.1.295 vs 2.1.280 -> positive. */
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10));
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The billing `claude auth status` and the environment imply, mirroring
 * claude-account.ts's seedBilling: an API key or a third-party provider env wins, otherwise
 * the login names it (a claude.ai OAuth or a subscription type is `subscription`). Undefined
 * when no answer can be derived (not logged in, probe failed). */
function expectedBilling(bin, env) {
  if (process.env.ANTHROPIC_API_KEY) return "api";
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK ||
    process.env.CLAUDE_CODE_USE_VERTEX ||
    process.env.CLAUDE_CODE_USE_FOUNDRY
  ) {
    return "api";
  }
  const out = spawnSync(bin, ["auth", "status"], { env, encoding: "utf8", timeout: 10_000 });
  if (out.status !== 0 || typeof out.stdout !== "string") return undefined;
  let doc;
  try {
    doc = JSON.parse(out.stdout);
  } catch {
    return undefined;
  }
  if (doc.loggedIn !== true) return undefined;
  return doc.subscriptionType !== undefined || doc.authMethod === "claude.ai"
    ? "subscription"
    : "api";
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tw-smoke-claude-"));
const REPO = path.join(ROOT, "repo");
fs.mkdirSync(REPO);
spawnSync("git", ["init", "-q"], { cwd: REPO });
// claude resolves symlinks in its cwd, and its project slug must match the adapter's run.cwd.
const CWD = fs.realpathSync(REPO);
const SESSIONS = path.join(ROOT, "sessions");
// The three tier defaults, read from the same routing the config uses instead of listed
// again, so this check cannot drift from the models a seam resolves.
const MODEL = Object.fromEntries(
  ["small", "default", "strong"].map((tier) => [tier, routeModel(undefined, undefined, "claude", tier).model]),
);
const BASE = { ...defaultConfig(), agent: "claude", model: MODEL.default };

let logSeq = 0;
/** One live run through the real adapter, exactly as a tick builds it. */
function runClaude({ model, prompt, sessionName, continueSession = false, signal, onToolCallStart, notesPath }) {
  logSeq += 1;
  return runAgent({
    cwd: CWD,
    prompt,
    config: { ...BASE, model },
    sessionDir: SESSIONS,
    sessionName,
    rawLogFile: path.join(ROOT, `raw-${logSeq}.jsonl`),
    nativeLogFile: path.join(ROOT, `native-${logSeq}.jsonl`),
    kind: "author",
    continueSession,
    ...(notesPath !== undefined ? { notesPath } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(onToolCallStart !== undefined ? { onToolCallStart } : {}),
  });
}

/** The newest ledger record, or undefined when the ledger is empty. */
function newestSession() {
  return readSessions(SESSIONS).at(-1);
}

let exitCode = 0;
try {
  const resolved = claudeBackend.resolveBin(BASE);
  // The scrubbed environment a real run gets — using it for the probes too keeps the
  // "spawned from inside a Claude Code session" auth bug out of the smoke harness itself.
  const probeEnv = claudeEnv(process.env, { quietTimeoutSeconds: 0 });

  // 1. The CLI is present and new enough for the gated default models (finding 9: an old CLI
  //    refuses Opus and misprices Haiku, and team runs never auto-update).
  const versionOut = spawnSync(resolved.bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const version = /(\d+\.\d+\.\d+)/.exec(versionOut.stdout ?? "")?.[1];
  const floor = claudeBackend.minVersion?.(MODEL.default) ?? "0.0.0";
  check(
    `claude CLI present and >= ${floor}`,
    version !== undefined && compareVersions(version, floor) >= 0,
    versionOut.error?.message ?? `version=${version ?? versionOut.stdout?.trim() ?? "<none>"}`,
  );

  // 2. One call on each default model, so a CLI too old for one fails here and not in the
  //    team. Cheapest first.
  for (const tier of ["small", "default", "strong"]) {
    const result = await runClaude({
      model: MODEL[tier],
      prompt: "Reply with exactly SMOKE_MODEL_OK and nothing else.",
      sessionName: `model-${tier}`,
    });
    check(
      `default model ${tier} (${MODEL[tier]}) runs`,
      result.ok && !result.configError && result.finalText.includes("SMOKE_MODEL_OK"),
      result.errorMessage ?? result.finalText,
    );
  }

  // 3. An isolated multi-turn run: the second turn is what loaded the operator's config in
  //    the regression (finding 1), so the cost ceiling is the isolation assertion. Under
  //    isolation the same three-turn run cost $0.025; with ~/.claude loaded it cost $0.79.
  const multi = await runClaude({
    model: MODEL.default,
    prompt: [
      "This is an isolated smoke test. Make exactly three separate Bash tool calls, one at a time, waiting for each result:",
      "1. `printf alpha > smoke.txt`",
      "2. `printf beta >> smoke.txt`",
      "3. `cat smoke.txt`",
      "After the third tool result, reply with exactly SMOKE_THREE_DONE and nothing else.",
    ].join("\n"),
    sessionName: "isolation",
  });
  check(
    "isolated multi-turn run stays under $0.10",
    multi.ok && multi.costUsd < 0.1 && multi.turns >= 2,
    `cost=$${multi.costUsd} turns=${multi.turns} ${multi.errorMessage ?? ""}`,
  );

  // 4. Billing matches `claude auth status`, and a subscription run leaves a window reading in
  //    claude-account.json (the account file part 6b/7 throttles on).
  const billing = expectedBilling(resolved.bin, probeEnv);
  check(
    "reported billing matches claude auth status",
    billing !== undefined && multi.billing === billing,
    `run=${multi.billing ?? "<none>"} auth=${billing ?? "<unknown>"}`,
  );
  if (billing === "subscription") {
    observeClaudeAccount(ROOT, multi);
    const account = readClaudeAccount(ROOT);
    check(
      "subscription run records a usage window",
      account?.billing === "subscription" && Object.keys(account.windows).length > 0,
      JSON.stringify(account ?? null),
    );
  }

  // 5. Resume the isolation session: the ledger's newest record must keep the same id, which
  //    only happens when claude's transcript was found and `--resume <id>` was passed.
  const recorded = newestSession();
  const resumed = await runClaude({
    model: MODEL.default,
    prompt: "Reply with exactly SMOKE_RESUMED and nothing else.",
    sessionName: "isolation",
    continueSession: true,
  });
  check(
    "--resume reuses the isolation session",
    recorded !== undefined &&
      resumed.ok &&
      newestSession()?.id === recorded.id,
    `before=${recorded?.id ?? "<none>"} after=${newestSession()?.id ?? "<none>"} ${resumed.errorMessage ?? ""}`,
  );

  // 6. SIGTERM mid-tool call (finding 3) and a resume that keeps the session. runAgent's
  //    AbortSignal path is the harness's own SIGTERM-to-the-process-group kill.
  const controller = new AbortController();
  let toolStarted = false;
  const killed = await runClaude({
    model: MODEL.default,
    prompt:
      "Use the Bash tool to run `sleep 60`, wait for it to finish, then reply with exactly SMOKE_WAKE.",
    sessionName: "sigterm",
    signal: controller.signal,
    onToolCallStart: () => {
      if (toolStarted) return;
      toolStarted = true;
      setTimeout(() => controller.abort(), 500);
    },
  });
  check(
    "SIGTERM mid-tool call kills the run",
    killed.aborted === true,
    `aborted=${killed.aborted} ${killed.errorMessage ?? ""}`,
  );
  const killedRecord = newestSession();
  const resumedAfterKill = await runClaude({
    model: MODEL.default,
    prompt: "Reply with exactly SMOKE_AFTER_KILL and nothing else.",
    sessionName: "sigterm",
    continueSession: true,
  });
  check(
    "a killed session resumes",
    killedRecord !== undefined &&
      resumedAfterKill.ok &&
      newestSession()?.id === killedRecord.id,
    `before=${killedRecord?.id ?? "<none>"} after=${newestSession()?.id ?? "<none>"} ${resumedAfterKill.errorMessage ?? ""}`,
  );

  // 7. An unknown model classifies as a permanent configuration error, so the team holds the
  //    pin instead of retrying a request that can never succeed.
  const unknown = await runClaude({
    model: "claude-smoke-unknown-9-9",
    prompt: "Reply with exactly SMOKE_UNKNOWN and nothing else.",
    sessionName: "unknown",
  });
  check(
    "an unknown model classifies as configError",
    unknown.configError === true,
    `configError=${unknown.configError} ${unknown.errorMessage ?? ""}`,
  );

  // 8. A run carrying a notebook saves its note through `tumwater-notes` (part 2/4): the
  //    command is first on PATH, so a prompt that asks the run to write its end-of-run note
  //    through the heredoc lands in the notes file, which this check reads back.
  const notesFile = path.join(ROOT, "note.md");
  const noted = await runClaude({
    model: MODEL.default,
    prompt: [
      "Write your end-of-run role note by running exactly this shell command and nothing else:",
      "tumwater-notes write <<'TUMWATER_NOTES'",
      "smoke note marker",
      "TUMWATER_NOTES",
      "Then reply with exactly SMOKE_NOTE_DONE and nothing else.",
    ].join("\n"),
    sessionName: "note",
    notesPath: notesFile,
  });
  const noteText = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : "";
  check(
    "a notes-carrying run saves its note through tumwater-notes",
    noted.ok && noteText.includes("smoke note marker"),
    `ok=${noted.ok} note=${JSON.stringify(noteText)} ${noted.errorMessage ?? ""}`,
  );

  console.log("SMOKE PASS");
} catch (err) {
  exitCode = 1;
  if (!(err instanceof SmokeFailure)) console.error(err);
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
process.exit(exitCode);
