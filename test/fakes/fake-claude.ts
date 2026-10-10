import fs from "node:fs";
import path from "node:path";
import { pathPrepend, RUN_MARKER, writeScript } from "./fake-commands.js";
import { tmpdir } from "../fixtures/repo-fixtures.js";

// --- The fake claude shim (fakeClaudeReplay/readRunBlocks), the twin of fake-pi.ts ---
// Every claude run in the suite goes through this PATH shim: it replays canned
// `--output-format stream-json` lines, records each run's argv and stdin (delimited by the
// same `RUN_MARKER` block marker fake-pi uses), and creates the transcript file at claude's
// real layout under $HOME, so the adapter's resume check finds what a real run would have
// written. No test reaches a real claude (see PRINCIPLES.md).

// A shim on PATH runs only when nothing outranks PATH in resolveBinFrom, and
// TUMWATER_CLAUDE_BIN does. The test runner drops it (suiteEnv in test/test-runner.ts); this
// covers a test file run directly with `node --test`.
delete process.env.TUMWATER_CLAUDE_BIN;

/** One installed fake-claude replay. `argvFile`/`stdinFile` accumulate one `RUN_MARKER`-delimited
 * block per run; `restore` removes the shim from PATH. */
interface FakeClaudeReplay {
  argvFile: string;
  stdinFile: string;
  restore: () => void;
}

/** Install a fake `claude` that runs in the worktree as cwd, records each run's argv and stdin,
 * creates the transcript file for the run's `--session-id`/`--resume` id under `$HOME`, and
 * replays `lines` (native stream-json) on stdout. The transcript path mirrors the adapter's
 * `claudeTranscriptPath` (the directory is `$HOME/.claude/projects/<slug>/<id>.jsonl`), so a
 * `continueSession` run's `resumableSession` check sees a real file. `extraScript` appends
 * shell lines before the replay — for a test's own probes (recording an env var, exiting
 * nonzero). Sets no env; a caller that needs a temp `$HOME` overrides it itself. */
export function fakeClaudeReplay(
  lines: readonly string[],
  opts: { extraScript?: readonly string[] } = {},
): FakeClaudeReplay {
  const dir = tmpdir("fake-claude-");
  const streamFile = path.join(dir, "stream.ndjson");
  fs.writeFileSync(streamFile, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  const argvFile = path.join(dir, "runs.argv");
  const stdinFile = path.join(dir, "runs.stdin");
  const body = [
    `argvFile="${argvFile}"`,
    `stdinFile="${stdinFile}"`,
    `streamFile="${streamFile}"`,
    `id=""`,
    `prev=""`,
    `for a in "$@"; do case "$prev" in --session-id|--resume) id="$a";; esac; prev="$a"; done`,
    `slug="$(printf '%s' "$(pwd)" | sed 's/[^A-Za-z0-9]/-/g')"`,
    `mkdir -p "$HOME/.claude/projects/$slug"`,
    `: > "$HOME/.claude/projects/$slug/$id.jsonl"`,
    `{ printf '%s\\n' "$@"; echo "${RUN_MARKER}"; } >> "$argvFile"`,
    `cat >> "$stdinFile"; echo "${RUN_MARKER}" >> "$stdinFile"`,
    ...(opts.extraScript ?? []),
    `cat "$streamFile"`,
  ].join("\n");
  writeScript(path.join(dir, "claude"), body);
  const restore = pathPrepend(dir);
  return { argvFile, stdinFile, restore };
}

/** Read back a run-block log written by fakeClaudeReplay's RUN_MARKER: fake-commands'
 * readRunBlocks, the single home of the split, re-exported here for the claude tests that
 * import it beside fakeClaudeReplay. Used for both argv and stdin logs. */
export { readRunBlocks } from "./fake-commands.js";
