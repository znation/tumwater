import fs from "node:fs";
import path from "node:path";
import { pathPrepend, RUN_MARKER, writeScript } from "./fake-commands.js";
import { tmpdir } from "../fixtures/repo-fixtures.js";
import { opencodeCaptures } from "../fixtures/opencode-events.js";

// --- The fake opencode shim (fakeOpencodeReplay), the twin of fake-claude.ts ---
// Every opencode run in the suite goes through this PATH shim: it replays canned
// `run --format json` lines, records each run's argv, stdin and OPENCODE_* environment,
// stores the run's session id in a per-test ledger file, and serves `session export` from
// that ledger (exit 1 for an id it does not know) — so a continue's existence check and the
// post-run reconciling export both run against the same fake the test controls. No test
// reaches a real opencode (see PRINCIPLES.md).

// A shim on PATH runs only when nothing outranks PATH in resolveBinFrom, and
// TUMWATER_OPENCODE_BIN does. The test runner drops it (suiteEnv in test/test-runner.ts); this
// covers a test file run directly with `node --test`.
delete process.env.TUMWATER_OPENCODE_BIN;

/** One installed fake-opencode replay. `argvFile`/`stdinFile` accumulate one `RUN_MARKER`-
 * delimited block per run; `exportsFile` grows one line per `session export` invocation
 * (absent or empty when none ran); `ledgerFile` holds the session ids a `run` recorded, which
 * is what the fake's own `session export` accepts; `envFile` holds the OPENCODE_* env of the
 * last run. `restore` removes the shim from PATH. */
export interface FakeOpencodeReplay {
  argvFile: string;
  stdinFile: string;
  /** One line per `session export` call (`export <id>`); empty when none was invoked. */
  exportsFile: string;
  /** The session ids a `run` recorded, one per line — the fake's own store of "known" ids. */
  ledgerFile: string;
  /** The OPENCODE_* environment the last run spawned with. */
  envFile: string;
  restore: () => void;
}

/** The canned export the fake prints for a session it knows: edit-run's real
 * `session export` (cost 0, input 3223, output 433, cacheRead 7680) — the accepted numbers
 * of part 4/7, so tests assert the run's reconciled tokens against them. */
const DEFAULT_EXPORT = opencodeCaptures.editRunExport;

/** Install a fake `opencode` that runs in the worktree as cwd, records each run's argv, stdin
 * and OPENCODE_* env, stores the run's `--session` id in a per-test ledger, replays `lines`
 * (native `run --format json`) on stdout for `run`, and serves `session export <id>` from the
 * ledger (printing `opts.cannedExport` for a known id, exiting 1 otherwise) and `session
 * delete <id>` as a no-op. `opts`:
 * - `failExport`: the `session export` command always exits 1, even for a known id.
 * - `exitCode`: the `run` command exits with this code after replaying instead of 0.
 * - `hang`: the `run` command replays then sleeps forever (for the quiet-watchdog tests).
 * Sets no env; a caller that needs a temp `$HOME` overrides it itself. */
export function fakeOpencodeReplay(
  lines: readonly string[],
  opts: { failExport?: boolean; exitCode?: number; hang?: boolean; cannedExport?: string } = {},
): FakeOpencodeReplay {
  const dir = tmpdir("fake-opencode-");
  const streamFile = path.join(dir, "stream.ndjson");
  fs.writeFileSync(streamFile, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  const argvFile = path.join(dir, "runs.argv");
  const stdinFile = path.join(dir, "runs.stdin");
  const exportsFile = path.join(dir, "exports.log");
  const ledgerFile = path.join(dir, "known-sessions");
  const envFile = path.join(dir, "runs.env");
  const exportFile = path.join(dir, "canned-export.json");
  fs.writeFileSync(exportFile, opts.cannedExport ?? DEFAULT_EXPORT);
  const failExport = opts.failExport ? `exit 1` : "";
  const runTail =
    opts.hang ? `cat "$streamFile"\nexec sleep 60` :
    opts.exitCode !== undefined ? `exit ${opts.exitCode}` :
    `cat "$streamFile"`;
  const body = [
    `argvFile="${argvFile}"`,
    `stdinFile="${stdinFile}"`,
    `exportsFile="${exportsFile}"`,
    `ledgerFile="${ledgerFile}"`,
    `envFile="${envFile}"`,
    `streamFile="${streamFile}"`,
    `exportFile="${exportFile}"`,
    `cmd="$1"`,
    `case "$cmd" in`,
    `  run)`,
    `    id=""`,
    `    prev=""`,
    `    for a in "$@"; do case "$prev" in --session) id="$a";; esac; prev="$a"; done`,
    `    { printf '%s\\n' "$@"; echo "${RUN_MARKER}"; } >> "$argvFile"`,
    `    cat >> "$stdinFile"; echo "${RUN_MARKER}" >> "$stdinFile"`,
    `    env | grep -E '^OPENCODE(_|$)' | sort > "$envFile"`,
    `    printf '%s\\n' "$id" >> "$ledgerFile"`,
    runTail,
    `    ;;`,
    `  session)`,
    `    sub="$2"`,
    `    sid="$3"`,
    `    case "$sub" in`,
    `      export)`,
    `        printf 'export %s\\n' "$sid" >> "$exportsFile"`,
    failExport,
    `        if grep -Fqx "$sid" "$ledgerFile"; then cat "$exportFile"; else exit 1; fi`,
    `        ;;`,
    `      delete)`,
    `        :`,
    `        ;;`,
    `    esac`,
    `    ;;`,
    `esac`,
  ].join("\n");
  writeScript(path.join(dir, "opencode"), body);
  const restore = pathPrepend(dir);
  return { argvFile, stdinFile, exportsFile, ledgerFile, envFile, restore };
}

/** Run one async block with a fake opencode replay installed for its duration, restoring
 * afterwards even when the block throws — the opencode twin of withClaudeReplay. The block
 * receives the installed replay. `opts` is fakeOpencodeReplay's own options. */
export async function withOpencodeReplay<T>(
  lines: readonly string[],
  optsOrFn: FakeOpencodeOptions | ((fake: FakeOpencodeReplay) => Promise<T>),
  maybeFn?: (fake: FakeOpencodeReplay) => Promise<T>,
): Promise<T> {
  const opts = typeof optsOrFn === "function" ? undefined : optsOrFn;
  const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn!;
  const fake = fakeOpencodeReplay(lines, opts);
  try {
    return await fn(fake);
  } finally {
    fake.restore();
  }
}

interface FakeOpencodeOptions {
  failExport?: boolean;
  exitCode?: number;
  hang?: boolean;
  cannedExport?: string;
}

/** Read back a run-block log written by the fake's RUN_MARKER: fake-commands' readRunBlocks,
 * re-exported for the opencode tests that import it beside fakeOpencodeReplay. */
export { readRunBlocks } from "./fake-commands.js";
