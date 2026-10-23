import fs from "node:fs";
import path from "node:path";
import { pathPrepend, RUN_MARKER, writeScript } from "./fake-commands.js";
import { tmpdir } from "../fixtures/repo-fixtures.js";

// --- The fake codex shim (fakeCodexReplay), the twin of fake-opencode.ts ---
// Every codex run in the suite goes through this PATH shim: it replays canned `exec --json`
// lines, records each run's argv and stdin, records the thread id the stream names in a
// per-test ledger file, and writes a matching rollout under `$CODEX_HOME/sessions/…` so the
// adapter's rollout read (the authority for this run's usage) runs against the same fake the
// test controls. Since part 5/9, the adapter's async `prepare` asks the same binary for the
// write guard's trust through `--version` and `-c … app-server` before each run, so the shim
// answers those too (see appServerJs below). No test reaches a real codex (see PRINCIPLES.md).

// A shim on PATH runs only when nothing outranks PATH in resolveBinFrom, and
// TUMWATER_CODEX_BIN does. The test runner drops it (suiteEnv in test/test-runner.ts); this
// covers a test file run directly with `node --test`.
delete process.env.TUMWATER_CODEX_BIN;

/** One installed fake-codex replay. `argvFile`/`stdinFile` accumulate one `RUN_MARKER`-
 * delimited block per run; `ledgerFile` holds the thread ids the runs' streams named, one per
 * run; `envFile` holds the CODEX_* env of the last run; `serverCallsFile` counts `app-server`
 * starts (a run's `prepare` warms trust — a cache hit spawns none). A test deletes a written
 * rollout to exercise the not-resumable path (it knows the `configDir` it pointed
 * `backends.codex` at). `restore` removes the shim from PATH. */
interface FakeCodexReplay {
  argvFile: string;
  stdinFile: string;
  ledgerFile: string;
  envFile: string;
  serverCallsFile: string;
  restore: () => void;
}

/** The default rollout a fresh run leaves, keyed to the stream's thread id (a `@THREAD@`
 * placeholder the fake substitutes): a `plus` plan with a two-window rate limit at 50%/40%,
 * so a run's post-run reading carries run_usage, a subscription billing line, and the two
 * rate_limit windows. */
const DEFAULT_ROLLOUT = [
  '{"type":"event_msg","payload":{"type":"task_started","turn_id":"@THREAD@"}}',
  '{"type":"turn_context","payload":{"type":"turn_context","turn_id":"@THREAD@","model":"gpt-6-luna"}}',
  '{"type":"token_usage_record","payload":{"type":"token_usage_record","turn_id":"@THREAD@","turn_token_usage":{"input_tokens":1000,"cached_input_tokens":300,"cache_write_input_tokens":0,"output_tokens":40}}}',
  '{"type":"event_msg","payload":{"type":"token_count","turn_id":"@THREAD@","rate_limits":{"plan_type":"plus","primary":{"used_percent":50,"window_minutes":300,"resets_at":1792555493},"secondary":{"used_percent":40,"window_minutes":10080,"resets_at":1793142293},"rate_limit_reached_type":null}}}',
].join("\n");

/** The node script that serves the trust lookup's `app-server`: answers `--version`, and for
 * `-c … app-server` reads the JSON-RPC lines and answers `initialize` with `{}` and
 * `hooks/list` with one sessionFlags preToolUse hook whose `command` is parsed from the `-c`
 * argument and whose `currentHash` is `sha256:` of it (plans/codex-write-guard.md "Trust
 * (parts 4–5)"). Each app-server start appends to `callsFile`; `hang` leaves it alive (writing
 * its pid to `pidFile`) for the timeout test; `mismatch` lists the hook under a `user` source
 * so the session-flag match fails. Shared by the run replay and the standalone server fake. */
function appServerJs(opts: {
  callsFile: string;
  pidFile: string;
  version: string;
  mismatch: boolean;
  hang: boolean;
  errorReply?: unknown;
  noise?: boolean;
  exitEarly?: boolean;
  versionHang?: boolean;
}): string {
  const { callsFile, pidFile, version, mismatch, hang, errorReply, noise, exitEarly, versionHang } = opts;
  const source = mismatch ? "user" : "sessionFlags";
  return [
    'const fs = require("node:fs");',
    'const crypto = require("node:crypto");',
    `const CALLS = ${JSON.stringify(callsFile)};`,
    `const PID = ${JSON.stringify(pidFile)};`,
    `const VERSION = ${JSON.stringify(version)};`,
    `const SOURCE = ${JSON.stringify(source)};`,
    `const HANG = ${hang};`,
    `const ERROR = ${JSON.stringify(errorReply ?? null)};`,
    `const NOISE = ${noise === true};`,
    `const EXIT_EARLY = ${exitEarly === true};`,
    `const VERSION_HANG = ${versionHang === true};`,
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") {',
    "  if (VERSION_HANG) { setTimeout(function () {}, 60000); return; }",
    '  process.stdout.write(VERSION + "\\n");',
    "  process.exit(0);",
    "}",
    'fs.appendFileSync(CALLS, "start\\n");',
    "fs.writeFileSync(PID, String(process.pid));",
    'if (NOISE) process.stdout.write("codex: hello from codex\\n");',
    "if (HANG) { setTimeout(function () {}, 60000); }",
    'const toml = args[1] ?? "";',
    "const command = parseCommand(toml);",
    'const key = "/<session-flags>/config.toml:pre_tool_use:0:0";',
    'const currentHash = "sha256:" + crypto.createHash("sha256").update(command).digest("hex");',
    "const hook = { source: SOURCE, eventName: \"preToolUse\", command: command, key: key, currentHash: currentHash };",
    'process.stdin.setEncoding("utf8");',
    'let buf = "";',
    'process.stdin.on("data", function (chunk) {',
    "    if (HANG) return; // Hang mode answers nothing, so the lookup times out and kills us.",
    "  buf += chunk;",
    '  let nl = buf.indexOf("\\n");',
    "  while (nl >= 0) {",
    '    const line = buf.slice(0, nl).trim();',
    '    buf = buf.slice(nl + 1);',
    "    if (line) {",
    "      let msg;",
    '      try { msg = JSON.parse(line); } catch (e) { nl = buf.indexOf("\\n"); continue; }',
    '      if (msg.method === "initialize") {',
    '        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
    '      } else if (msg.method === "hooks/list") {',
    '        if (EXIT_EARLY) { process.exit(0); }',
    '        if (ERROR !== null) {',
    '          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: ERROR }) + "\\n");',
    '        } else {',
    '          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { data: [{ hooks: [hook] }] } }) + "\\n");',
    '        }',
    "      }",
    "    }",
    '    nl = buf.indexOf("\\n");',
    "  }",
    "});",
    "function parseCommand(toml) {",
    '  const idx = toml.indexOf("command=");',
    '  if (idx < 0) return "";',
    '  const open = toml.indexOf(\'"\', idx);',
    '  if (open < 0) return "";',
    '  let out = "";',
    "  let i = open + 1;",
    "  while (i < toml.length) {",
    "    const c = toml[i];",
    '    if (c === \'"\') return out;',
    '    if (c === "\\\\") {',
    "      const n = toml[i + 1];",
    '      if (n === "\\\\") { out += "\\\\"; i += 2; continue; }',
    '      if (n === \'"\') { out += \'"\'; i += 2; continue; }',
    '      if (n === "u") { out += String.fromCodePoint(parseInt(toml.slice(i + 2, i + 6), 16)); i += 6; continue; }',
    "      out += n; i += 2; continue;",
    "    }",
    "    out += c; i += 1;",
    "  }",
    "  return out;",
    "}",
  ].join("\n");
}

/** Install a fake `codex` that runs in the worktree as cwd, records each run's argv, stdin and
 * CODEX_* env, replays `lines` (native `exec --json`) on stdout, records the stream's thread
 * id, and writes a rollout under `$CODEX_HOME/sessions/…/rollout-…-<id>.jsonl` whose records
 * carry that thread id. The same binary also answers the trust lookup's `--version` and
 * `-c … app-server` (appServerJs), so a part-5/9 run's `prepare` warms the guard's trust.
 * `opts.cannedRollout` (a JSONL string with `@THREAD@` as the turn id) replaces the default
 * rollout, so a test can pin a specific usage/window reading; `opts.exitCode` makes the `exec`
 * command exit nonzero after replaying. Sets no env; a caller that needs a temp `$HOME`
 * overrides it itself and points `backends.codex.configDir` at it. */
function fakeCodexReplay(
  lines: readonly string[],
  opts: { cannedRollout?: string; exitCode?: number } = {},
): FakeCodexReplay {
  const dir = tmpdir("fake-codex-");
  const streamFile = path.join(dir, "stream.ndjson");
  fs.writeFileSync(streamFile, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  const argvFile = path.join(dir, "runs.argv");
  const stdinFile = path.join(dir, "runs.stdin");
  const ledgerFile = path.join(dir, "threads");
  const envFile = path.join(dir, "runs.env");
  const serverCallsFile = path.join(dir, "server.calls");
  const pidFile = path.join(dir, "server.pid");
  const rolloutTemplate = path.join(dir, "rollout-template.jsonl");
  fs.writeFileSync(rolloutTemplate, opts.cannedRollout ?? DEFAULT_ROLLOUT);
  const appScript = path.join(dir, "app-server.js");
  fs.writeFileSync(appScript, appServerJs({ callsFile: serverCallsFile, pidFile, version: "0.163.0", mismatch: false, hang: false }));
  const exitTail = opts.exitCode !== undefined ? `exit ${opts.exitCode}` : `cat "$streamFile"`;
  const body = [
    `argvFile="${argvFile}"`,
    `stdinFile="${stdinFile}"`,
    `ledgerFile="${ledgerFile}"`,
    `envFile="${envFile}"`,
    `streamFile="${streamFile}"`,
    `rolloutTemplate="${rolloutTemplate}"`,
    `appScript="${appScript}"`,
    `case "$1" in`,
    `  exec)`,
    `    { printf '%s\\n' "$@"; echo "${RUN_MARKER}"; } >> "$argvFile"`,
    `    cat >> "$stdinFile"; echo "${RUN_MARKER}" >> "$stdinFile"`,
    `    env | grep -E '^(CODEX(_|$)|PATH=|TUMWATER_NOTES_PATH=)' | sort > "$envFile"`,
    `    # The thread id the stream names (its first thread.started), used to name and key the rollout.`,
    `    thread=$(sed -n 's/.*"thread_id":"\\([^"]*\\)".*/\\1/p' "$streamFile" | head -1)`,
    `    if [ -n "$thread" ]; then`,
    `      printf '%s\\n' "$thread" >> "$ledgerFile"`,
    `      if [ -n "$CODEX_HOME" ]; then`,
    `        mkdir -p "$CODEX_HOME/sessions/2026-10-21"`,
    `        sed "s/@THREAD@/$thread/g" "$rolloutTemplate" > "$CODEX_HOME/sessions/2026-10-21/rollout-0000-$thread.jsonl"`,
    `      fi`,
    `    fi`,
    exitTail,
    `    ;;`,
    `  --version)`,
    `    printf '%s\\n' "0.163.0"`,
    `    ;;`,
    `  -c)`,
    `    exec node "$appScript" "$@"`,
    `    ;;`,
    `esac`,
  ].join("\n");
  writeScript(path.join(dir, "codex"), body);
  const restore = pathPrepend(dir);
  return { argvFile, stdinFile, ledgerFile, envFile, serverCallsFile, restore };
}

/** Run one async block with a fake codex replay installed for its duration, restoring
 * afterwards even when the block throws — the codex twin of withOpencodeReplay. The block
 * receives the installed replay. `opts` is fakeCodexReplay's own options. */
export async function withCodexReplay<T>(
  lines: readonly string[],
  optsOrFn: FakeCodexOptions | ((fake: FakeCodexReplay) => Promise<T>),
  maybeFn?: (fake: FakeCodexReplay) => Promise<T>,
): Promise<T> {
  const opts = typeof optsOrFn === "function" ? undefined : optsOrFn;
  const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn!;
  const fake = fakeCodexReplay(lines, opts);
  try {
    return await fn(fake);
  } finally {
    fake.restore();
  }
}

interface FakeCodexOptions {
  cannedRollout?: string;
  exitCode?: number;
}

/** Read back a run-block log written by the fake's RUN_MARKER: fake-commands' readRunBlocks,
 * re-exported for the codex tests that import it beside fakeCodexReplay. */
export { readRunBlocks } from "./fake-commands.js";

/** Something the test can hand the trust lookup as its `bin` directly, plus the ledger files
 * the lookup's probes write: `callsFile` counts app-server starts (a cache hit spawns none);
 * `pidFile` records the app-server's pid before it hangs, so the timeout test can prove the
 * child is gone afterwards. `restore` removes the fake's directory. */
interface FakeCodexServer {
  bin: string;
  callsFile: string;
  pidFile: string;
  restore: () => void;
}

/** Options for fakeCodexAppServer: the version `--version` prints (a different one makes the
 * trust cache look up again), whether the app-server hangs (the timeout case), and whether the
 * listed hook should not match the guard's command (so the no-match rejection can be tested).
 * `errorReply` answers hooks/list with a JSON-RPC `error` instead of a result — a string or a
 * `{message}` object, the two shapes lookupCodexHookTrust's describeError handles; `noise`
 * prints one non-JSON line before answering (the lookup's ignore-noise branch); `exitEarly`
 * answers the initialize handshake and exits 0 before hooks/list (the early-exit rejection);
 * `versionHang` makes the `--version` probe hang (so the whole lookup's deadline is tested). */
interface FakeCodexServerOptions {
  version?: string;
  hang?: boolean;
  mismatch?: boolean;
  /** hooks/list answers with this JSON-RPC `error` value instead of a result — a string or a
   * `{message}` object, the two shapes lookupCodexHookTrust's describeError handles. */
  errorReply?: unknown;
  /** The app-server prints one non-JSON line before answering anything, to exercise the
   * lookup's ignore-noise branch (a notice or prompt on the stream is not its reply). */
  noise?: boolean;
  /** The app-server answers the initialize handshake and then exits 0 without answering
   * hooks/list, to exercise the early-exit rejection. */
  exitEarly?: boolean;
  /** The `--version` probe hangs (never prints, never exits), for the test that the whole
   * lookup — version probe plus app-server — settles within the one deadline. */
  versionHang?: boolean;
}

/** A fake `codex` that answers the trust lookup (plans/codex-write-guard.md "Trust (parts
 * 4–5)"): `--version` prints the configured version, and `-c … app-server` serves the
 * JSON-RPC handshake (appServerJs). Each app-server start appends a line to `callsFile`;
 * `opts.hang` leaves it alive (writing its pid to `pidFile`) for the timeout test; `opts.mismatch`
 * lists the hook under a `user` source so the lookup's session-flag match fails; `opts.errorReply`
 * answers hooks/list with a JSON-RPC error instead of a result, `opts.noise` prints a non-JSON
 * line before answering (ignored), `opts.exitEarly` exits after the handshake, before
 * hooks/list, and `opts.versionHang` makes the `--version` probe hang. The bin is returned as
 * an absolute path the test passes as `bin`, never installed on PATH. */
export function fakeCodexAppServer(opts: FakeCodexServerOptions = {}): FakeCodexServer {
  const dir = tmpdir("fake-codex-server-");
  const callsFile = path.join(dir, "server.calls");
  const pidFile = path.join(dir, "server.pid");
  const version = opts.version ?? "0.163.0";
  const script = path.join(dir, "app-server.js");
  fs.writeFileSync(script, appServerJs({ callsFile, pidFile, version, mismatch: opts.mismatch === true, hang: opts.hang === true, errorReply: opts.errorReply, noise: opts.noise, exitEarly: opts.exitEarly, versionHang: opts.versionHang }));
  // The pid is stamped in the shim before node starts, so the timeout test can read it the
  // moment the lookup settles, however slowly node itself cold-starts under parallel load.
  writeScript(path.join(dir, "codex"), `echo $$ > "${pidFile}"; exec node ${script} "$@"`);
  return {
    bin: path.join(dir, "codex"),
    callsFile,
    pidFile,
    restore: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
