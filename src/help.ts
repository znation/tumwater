/** The CLI's help text and its per-command view. Moved out of cli.ts so the topic parser is
 * testable without importing that module (whose top-level main() would run on import): the
 * full text is one template literal, and helpStanzas/helpTopic derive `tumwater help
 * <command>` from it by splitting the usage block on its `  tumwater <command>` lines, so a
 * topic can never drift out of sync with the full listing. */
import { suggestClosest } from "./text.js";

export const HELP = `tumwater — autonomous development harness built on pi

Usage:
  tumwater init <prompt...>        Initialize this repo (--file <prompt.md>, --adopt: brief in
                                   TUMWATER.md, --branch <name> seeds a new repo only,
                                   --template <id> seeds a starter brief+backlog (--list-templates
                                   lists them), --dry-run: write nothing)
  tumwater run [--branch <name>] [--once] [--role <id>]
                                   Run all enabled loops (headless; Ctrl+C stops);
                                   --once runs one full round of ticks, drains the
                                   landings it produced, and exits (for cron/CI);
                                   --once --role <id> scopes that round to one loop
  tumwater tui                     Dashboard + prompt input (observes a running \`tumwater run\`)
  tumwater gui [--port N] [--all-interfaces] [--token <secret>]
                                   Same dashboard in the browser (default port 7180,
                                   localhost only; --all-interfaces serves the whole
                                   network — without --token there is no auth, anyone
                                   reaching it can prompt the director)
  tumwater status [--json]         One-shot status table (--json prints machine-readable
                                   fleet state — the GUI's /api/status payload minus the
                                   serving process's serverBuildSha)
  tumwater report [--days N] [--json]
                                   Markdown usage report — tokens/ticks/commits per day (default
                                   14 days); totals also include landing runs (reviewer + conflict
                                   resolution); --json prints machine-readable usage data — the
                                   collector's own payload, not the Markdown render
  tumwater report --failures [--days N]
                                   Markdown failure digest — tick outcomes, deltas,
                                   clustered errors, and fleet state changes (default
                                   14 days)
  tumwater report --since <duration> [--json]
                                   Totals over a trailing window (capped at 7d) —
                                   tokens/ticks/commits/cost since a point in time; totals
                                   also include landing runs (reviewer + conflict
                                   resolution); not combinable with --days or --failures
  tumwater doctor [--json]         Pre-flight check: node, git, repo, config, fallback
                                   model, pi, locks, build, orphans, mach ports
                                   (read-only; exit 0/1; --json prints the report object —
                                   header, the checks array with level, name, and detail,
                                   and verdict)
  tumwater config [get <key> | set <key> <value>]
                                   Show the effective config (defaults + tumwater.json) as
                                   JSON; get one key's resolved value as JSON; set one
                                   top-level key — quietHours ("23:00-07:00" or ""),
                                   maxDailyCostUsd, fallbackModel, among others
                                   (JSON-parsed when parseable, else a literal string) —
                                   and confirm it
  tumwater logs [-f] [-n N] [--since <duration>] [--grep <text>] [--json]
                                   Show (and follow) harness events; --since shows the
                                   events of the past window (capped at 7d); --grep shows
                                   only events whose type or rendered line matches,
                                   case-insensitively (-n bounds the scanned window, not
                                   the printed rows); --json prints each event as one
                                   JSON object per line (NDJSON) — the raw event objects
                                   as stored in the log, instead of the rendered text
  tumwater logs --role <id> [-f] [-n N] [--prompt]
                                   Show (and follow) that loop's pi transcript
                                   (--prompt also shows each run's exact prompt text)
  tumwater history [--role <id>] [-n N] [--since <duration>] [--grep <text>] [--json]
                                   One row per completed tick, newest first — time, loop,
                                   tick number, result, duration, tokens/cost, and the
                                   summary (or error), each row one line; --since <duration>
                                   shows the window's ticks instead of the last N (capped at
                                   7d, like logs --since); --grep <text> keeps only rows whose
                                   line matches, case-insensitively (like logs --grep);
                                   --json prints the rows as machine-readable history data —
                                   ts, tokens, and costUsd kept raw, the GUI's /api/history payload
  tumwater tick <role> <n> [--json]
                                   One completed tick's full event trail — a summary header
                                   (result or in-flight, duration, tokens/cost, the pinned
                                   commit sha) then every event of that tick's block in time
                                   order; a still-running tick shows its events so far, marked
                                   in flight; --json prints the collector's payload as
                                   machine-readable data
  tumwater diff [--json]           One line per loop holding pending work — the ahead-of-main
                                   commit count and uncommitted-file count, no patch; roles
                                   with no worktree or nothing pending are skipped, and a
                                   missing baseline prints the per-role view's degradation
                                   line; --json prints the {mainBranch, roles} roster
  tumwater diff --role <id> [--json]
                                   Show the change that loop holds: its branch's unlanded
                                   commits (one line each, plus the ahead-of-main patch) and
                                   its worktree's uncommitted edits (the file list, plus the
                                   patch — staged and unstaged alike); a loop with no worktree
                                   yet prints \`no worktree for <id>\`; --json prints the
                                   collector's payload as machine-readable data
  tumwater backlog [--json]        Show planned features, open bugs, and open questions (the
                                   dashboards' backlog view); --json prints machine-readable
                                   backlog data — the three entry arrays as {title, body}, the
                                   same data the Markdown view renders
  tumwater role <id> [--json]      Show one loop's standing prompt and resolved settings — its
                                   find text, the roles.<id>.instructions override, the resolved
                                   provider/model (naming the budget fallback pair when one is
                                   configured), the min-tick interval, enabled/paused state, and
                                   the next tick's assembled prompt (the oldest queued prompt appears in it
                                   and is NOT consumed — one is dequeued per tick); --json prints the collector's payload
                                   as machine-readable data
  tumwater prompt <text...>        Queue a prompt for the director loop
  tumwater prompt --file <path>    Queue a prompt read from a file ("-" reads stdin)
  tumwater prompt --role <id> <text...>
                                   Queue a prompt for that loop's next tick (wakes it)
  tumwater prompt --list [--json]  Show queued prompts, numbered, grouped by loop
                                   (--json prints the {prompts} array as
                                   machine-readable data)
  tumwater prompt --cancel <n>     Remove the Nth queued prompt as --list shows them; when
                                   several loops show that N, name one with --role <id>
  tumwater reset-counters [--role <id>]
                                   Zero lifetime ticks/commits/tokens/cost (fresh
                                   observation window; today's budget spend is kept — the
                                   daily cap cannot be reset past)
  tumwater wake [--role <id>]      Wake a backed-off fleet — the named roles (or all) tick
                                   within one poll
  tumwater abort --role <id>       Abort that loop's in-flight tick (work discarded; the loop
                                   keeps running)
  tumwater pause [--role <id>] [--for <dur>] [--reason <text>]
                                   Stop role loops (or just the named loop) starting new
                                   ticks; --reason states why the whole FLEET is paused (no
                                   per-role reason); --for auto-resumes (capped at 90d)
  tumwater resume [--role <id>]    Lift a fleet or per-role pause
  tumwater stop                    Stop a running fleet (drains in-flight ticks, like Ctrl+C)
  tumwater help [<command>]        Show all commands, or one command's usage
  tumwater version                 Print the version

The harness runs inside a git repo. Each role loop owns a persistent worktree and branch
under .tumwater/, does one task per tick with pi, commits, and merges to main. Loops back
off while the project is quiet and wake when main moves. Everything is local: no remotes.
`;

/** The listed command closest to a mistyped one, or null when nothing is close enough to
 * suggest. Case-insensitive closest-match over the commands helpStanzas(HELP) names, capped
 * at two edits — a typo's distance, not a different word's — so only a near miss gets a hint
 * and the suggestion can never fire as an auto-correction. Deriving the candidates from the
 * help text (not a hand-kept list) means a new command is suggestible the tick it gains a
 * stanza; the distance mechanics are text.ts's suggestClosest, shared with the config-key
 * suggestion. */
export function suggestCommand(input: string, help: string = HELP): string | null {
  return suggestClosest(input, [...new Set(helpStanzas(help).map((s) => s.command))]);
}

/** One usage stanza: the command its `  tumwater <command>` line names and that line plus
 * its deeper-indented description continuations, verbatim. */
interface HelpStanza {
  /** The command token from the stanza's first line (e.g. "gui", "report", "help"). */
  command: string;
  /** The stanza's lines, verbatim from HELP. */
  text: string;
}

/** Split HELP's usage block into per-command stanzas. A stanza starts at a two-space-indented
 * `tumwater <command>` line; any further indented line continues it, and a column-0 line (the
 * closing paragraph) ends it. A command with several usage forms (report, prompt, logs) yields
 * one stanza per form. */
export function helpStanzas(help: string = HELP): HelpStanza[] {
  const stanzas: HelpStanza[] = [];
  let current: HelpStanza | null = null;
  for (const line of help.split("\n")) {
    const start = /^ {2}tumwater (\S+)/.exec(line);
    if (start?.[1]) {
      current = { command: start[1], text: line };
      stanzas.push(current);
    } else if (current && /^ ./.test(line)) {
      current.text += "\n" + line; // Deeper-indented continuation of the current stanza.
    } else {
      current = null; // Column-0 or blank line: outside the usage block.
    }
  }
  return stanzas;
}

/** The usage text for one command — every stanza whose command matches, then a pointer back to
 * the full list — or null when nothing in the help names that command. */
export function helpTopic(command: string, help: string = HELP): string | null {
  const matches = helpStanzas(help).filter((s) => s.command === command);
  if (matches.length === 0) return null;
  return matches.map((s) => s.text).join("\n") + "\n\nSee `tumwater help` for the full command list.";
}
