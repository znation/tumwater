import fs from "node:fs";
import path from "node:path";
import { pathPrepend, RUN_MARKER, writeScript } from "./fake-commands.js";
import { tmpdir } from "../fixtures/repo-fixtures.js";

// --- The fake codex shim (fakeCodexReplay), the twin of fake-opencode.ts ---
// Every codex run in the suite goes through this PATH shim: it replays canned `exec --json`
// lines, records each run's argv and stdin, records the thread id the stream names in a
// per-test ledger file, and writes a matching rollout under `$CODEX_HOME/sessions/…` so the
// adapter's rollout read (the authority for this run's usage) runs against the same fake the
// test controls. No test reaches a real codex (see PRINCIPLES.md).

// A shim on PATH runs only when nothing outranks PATH in resolveBinFrom, and
// TUMWATER_CODEX_BIN does. The test runner drops it (suiteEnv in test/test-runner.ts); this
// covers a test file run directly with `node --test`.
delete process.env.TUMWATER_CODEX_BIN;

/** One installed fake-codex replay. `argvFile`/`stdinFile` accumulate one `RUN_MARKER`-
 * delimited block per run; `ledgerFile` holds the thread ids the runs' streams named, one per
 * run; `envFile` holds the CODEX_* env of the last run. A test deletes a written rollout to
 * exercise the not-resumable path (it knows the `configDir` it pointed `backends.codex` at).
 * `restore` removes the shim from PATH. */
interface FakeCodexReplay {
  argvFile: string;
  stdinFile: string;
  ledgerFile: string;
  envFile: string;
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

/** Install a fake `codex` that runs in the worktree as cwd, records each run's argv, stdin and
 * CODEX_* env, replays `lines` (native `exec --json`) on stdout, records the stream's thread
 * id, and writes a rollout under `$CODEX_HOME/sessions/…/rollout-…-<id>.jsonl` whose records
 * carry that thread id. `opts.cannedRollout` (a JSONL string with `@THREAD@` as the turn id)
 * replaces the default rollout, so a test can pin a specific usage/window reading; `opts` may
 * name a day directory to write under (defaults to `2026-10-21`), which the filler ignores.
 * `opts.exitCode` makes the `exec` command exit nonzero after replaying. Sets no env; a caller
 * that needs a temp `$HOME` overrides it itself and points `backends.codex.configDir` at it. */
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
  const rolloutTemplate = path.join(dir, "rollout-template.jsonl");
  fs.writeFileSync(rolloutTemplate, opts.cannedRollout ?? DEFAULT_ROLLOUT);
  const exitTail = opts.exitCode !== undefined ? `exit ${opts.exitCode}` : `cat "$streamFile"`;
  const body = [
    `argvFile="${argvFile}"`,
    `stdinFile="${stdinFile}"`,
    `ledgerFile="${ledgerFile}"`,
    `envFile="${envFile}"`,
    `streamFile="${streamFile}"`,
    `rolloutTemplate="${rolloutTemplate}"`,
    `cmd="$1"`,
    `case "$cmd" in`,
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
    `esac`,
  ].join("\n");
  writeScript(path.join(dir, "codex"), body);
  const restore = pathPrepend(dir);
  return { argvFile, stdinFile, ledgerFile, envFile, restore };
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
