/** The CLI's help text and its per-command view. Moved out of cli.ts so the topic parser is
 * testable without importing that module (whose top-level main() would run on import): the
 * full text is one template literal, and helpStanzas/helpTopic derive `tumwater help
 * <command>` from it by splitting the usage block on its `  tumwater <command>` lines, so a
 * topic can never drift out of sync with the full listing. */
import { suggestClosest } from "../text/suggest.js";

// vocabulary: plain

/** Machine names HELP quotes verbatim; the scripting series renames them. */
const SUMMARY_JSON_KEYS = "{ loops, total }"; // vocabulary-ok: --json keys until the scripting series

export const HELP = `tumwater — an autonomous development team, built on pi

Usage:
  tumwater init <prompt...>        Initialize this repo (--file <prompt.md>, --adopt: brief in
                                   TUMWATER.md, --branch <name> seeds a new repo only,
                                   --template <id> seeds a starter brief+backlog (--list-templates
                                   lists them), --dry-run: write nothing)
  tumwater start [--branch <name>] [--once] [--for <duration>] [--role <id>] [--gui] [--tui]
                                   Start the team: every enabled role runs in turn (headless;
                                   Ctrl+C finishes current work, then stops);
                                   --once does one round of runs, finishes the
                                   merges it produced, and exits (for cron/CI);
                                   exits 3 when a run ended in error, review failed,
                                   a merge conflicted or was blocked, or main's check is failing;
                                   --once --role <id> limits that round to one role;
                                   --for <duration> runs for that window then finishes current work, prints a per-role summary
                                   (one window across self-redeploys),
                                   and exits like Ctrl+C would (for an overnight
                                   trial, a demo, a CI step);
                                   --gui also serves the browser dashboard at
                                   http://127.0.0.1:7180 (the \`tumwater gui\`
                                   defaults — see that command for --port and --token);
                                   --tui also hosts the TUI in this terminal
                                   (the \`tumwater tui\` view — quitting it stops the
                                   team like Ctrl+C)
  tumwater tui                     Dashboard + inbox input (watches a running \`tumwater start\`)
  tumwater gui [--port N] [--all-interfaces] [--token <secret>]
                                   Same dashboard in the browser (default port 7180,
                                   localhost only; --all-interfaces serves the whole
                                   network — without --token there is no auth, anyone
                                   reaching it can message the director)
  tumwater status [--json]         One-shot status table (--json prints machine-readable
                                   team state — the GUI's /api/status payload minus the
                                   serving process's serverBuildSha)
  tumwater report [--days N] [--role <id>] [--json]
                                   Markdown usage report — tokens/runs/commits per day (default
                                   14 days); totals also include merge runs (reviewer + conflict
                                   resolution); --role <id> scopes the report to one role's runs,
                                   tokens, cost, and commits (merge runs and backlog tallies
                                   omitted); --json prints machine-readable usage data — the
                                   collector's own payload, not the Markdown render
  tumwater report --failures [--days N] [--since <duration>] [--role <id>] [--json]
                                   Markdown failure digest — run outcomes, deltas,
                                   clustered errors, and team state changes (default
                                   14 days); --role <id> scopes the digest to one role's
                                   rows; --since windows the digest over a trailing
                                   span (capped at 7d)
  tumwater report --failures --since <duration> [--role <id>] [--json]
                                   The failure digest over a trailing window, compared
                                   against the equal-length window before it
  tumwater report --since <duration> [--role <id>] [--json]
                                   Totals over a trailing window (capped at 7d) —
                                   tokens/runs/commits/cost since a point in time; totals
                                   also include merge runs (reviewer + conflict
                                   resolution); --role <id> scopes the totals to one role
                                   (merge runs and backlog tallies omitted); not
                                   combinable with --days
  tumwater doctor [--json] [--reprobe]
                                   Pre-flight check: node, git, repo, config, fallback
                                   model, pi, locks, update, orphans, macOS port leak
                                   (read-only; exit 0/1; --json prints the report object —
                                   header, the checks array with level, name, and detail,
                                   and verdict; probes image-input models — --reprobe
                                   re-probes every one, bypassing the 7-day cache)
  tumwater config [get <key> | set <key> <value> | unset <key>]
                                   Show the effective config (defaults + tumwater.json) as
                                   JSON; get one key's resolved value as JSON; set one
                                   top-level key — quietHours ("23:00-07:00" or ""),
                                   quietHoursPerRole (per-role windows), maxDailyCostUsd,
                                   fallback, among others
                                   (JSON-parsed when parseable, else a literal string) —
                                   and confirm it; unset one key, removing its value so it
                                   reverts to its default or disappears from its map or
                                   section. Dotted keys (maxDailyCostUsdPerRole.feature
                                   1.5, roles.qa.model x) merge one entry into the existing
                                   map or role entry; bare keys replace the whole value.
                                   roles still merges the built-in catalog per entry, so
                                   disable a role with roles.<id>.enabled false, not by
                                   omitting it
  tumwater logs [-f/--follow] [-n N] [--since <duration>] [--grep <text>] [--type <event type>] [--count] [--json]
                                   Show (and follow) tumwater events; --since shows the
                                   events of the past window (capped at 7d); --grep shows
                                   only events whose type or rendered line matches,
                                   case-insensitively (-n bounds the scanned window, not
                                   the printed rows); --type shows only events of that
                                   exact event type, and an older event name matches its current one (it
                                   composes with --since); --count
                                   prints one \`N \u00d7 <type>\` line per present event type
                                   (most-frequent first) over the selected window instead
                                   of the rows; --json
                                   prints each event as one
                                   JSON object per line (NDJSON) — the raw event objects
                                   as stored in the log, instead of the rendered text
                                   (with --count, one JSON object mapping type \u2192 count)
  tumwater logs --role <id> [-f/--follow] [-n N] [--prompt]
                                   Show (and follow) that role's pi transcript
                                   (--prompt also shows each run's exact prompt text)
  tumwater notify --test          Run the configured notify hook once with a synthetic event
                                   so the command can be checked before a real page
  tumwater history [--role <id>] [-n N] [--since <duration>] [--grep <text>]
                   [--result <merged|none|problems>] [--summary] [--json]
                                   One row per completed run, newest first — time, role,
                                   run number, result, duration, tokens/cost, and the
                                   summary (or error), each row one line; --since <duration>
                                   shows the window's runs instead of the last N (capped at
                                   7d, like logs --since); --grep <text> keeps only rows whose
                                   line matches, case-insensitively (like logs --grep);
                                   --result <class> narrows to one outcome class — merged
                                   (merged or waiting to merge), none (no_change/skipped/user_aborted), or
                                   problems (everything else) — composed with --role, --since,
                                   -n, and --grep; --json prints the rows as
                                   machine-readable history data — ts, tokens, and costUsd
                                   kept raw, the GUI's /api/history payload; --summary prints one line per role
                                   counting its runs by outcome class, with the time of its newest change (and a total line)
                                   instead of the rows; with --json, ${SUMMARY_JSON_KEYS}
  tumwater history <role> [<n>] [--last] [--stat] [--json]
                                   One run's full event trail — a summary header (result, or
                                   in flight, with duration, tokens and cost, and the commit)
                                   then every event of that run in time order; a run still in
                                   flight shows its events so far; a run waiting to merge
                                   shows its merge verdict once the merge finishes; --last
                                   shows the role's newest finished run instead of numbering
                                   one; --stat appends the commit's per-file git show --stat
                                   summary; --json prints the collector's payload
  tumwater diff [--json]           One line per role holding pending work — the ahead-of-main
                                   commit count and uncommitted-file count, no patch; roles
                                   with no worktree or nothing pending are skipped, and a
                                   missing baseline prints the per-role view's degradation
                                   line; --json prints the {mainBranch, roles} roster
  tumwater diff --role <id> [--stat] [--json]
                                   Show the change that role holds: its branch's unmerged
                                   commits (one line each, plus the ahead-of-main patch) and
                                   its worktree's uncommitted edits (the file list, plus the
                                   patch — staged and unstaged alike); a role with no workspace
                                   yet prints \`no worktree for <id>\`; --stat prints each patch's per-file
                                   \`git diff --stat\` summary instead; --json prints the
                                   collector's payload as machine-readable data
  tumwater queue [--json]          List the durable merge queue in execution order (oldest
                                   first): one line per waiting merge — position, role, run
                                   number, short pinned sha, age, and summary — plus a bracketed
                                   \`[merging 2m · reviewing]\` / \`[approved, waiting to merge]\`
                                   label while a running team works on it; an empty queue
                                   prints \`merge queue empty\`, and any torn/foreign queue file
                                   the reader skipped is counted on a trailing line; --json
                                   prints the collector's own {entries, unreadable} document
                                   (raw sha and numeric enqueuedAt, not the render's age)
  tumwater backlog [--ready] [--json]
                                   Show planned features, open bugs, and open questions (the
                                   dashboards' backlog view); --json prints machine-readable
                                   backlog data — the three entry arrays as {title, body}, the
                                   same data the Markdown view renders; a series with two or more
                                   blocked parts prints as one heading (--json still lists every
                                   entry); an entry a role is
                                   working on carries \`[working on it: feature #2]\` (--json:
                                   an \`inProgress\` key parallel to the arrays); --ready keeps only the
                                   planned plans and open bugs no hold keeps from being
                                   picked (entries a role is working on stay)
  tumwater bug "<symptom>" [--json]
                                   File a bug into BUGS.md ## Open as you (stamped
                                   with today's date) and wake the bugfix role; --json prints
                                   the {file, title, stamp} payload as data
  tumwater bug --file <path> [--json]
                                   File a bug from a markdown file ("-" reads stdin): the first
                                   non-blank line is the symptom, the rest is the body kept
                                   line for line; wakes the bugfix role
  tumwater bug --release <n> [--json]
                                   Lift the Refused note from the Nth entry in BUGS.md ## Open
                                   (as \`tumwater bug --list\` lists it), commit it on main,
                                   and wake the bugfix role; --json prints {file, title}
  tumwater bug --cancel <n> [--json]
                                   Remove the Nth entry in BUGS.md ## Open (as \`tumwater
                                   bug --list\` lists it); no wake; --json prints {file, title}
  tumwater bug --edit <n> "<symptom>" [--json]
                                   Replace the Nth entry's text in BUGS.md ## Open in place,
                                   keeping its position and original filing stamp; no wake;
                                   --json prints {file, title}
  tumwater bug --edit <n> --file <path> [--json]
                                   Replace the Nth entry from a markdown file ("-" reads
                                   stdin): the first non-blank line is the title (symptom), the rest
                                   the body kept line for line; position and original stamp
                                   kept; no wake; --json prints {file, title}
  tumwater bug --edit <n> [--json]
                                   With neither text nor --file, open the Nth entry as --show
                                   prints it in $VISUAL or $EDITOR and write it back on save;
                                   an unchanged buffer writes nothing
  tumwater bug --list [--json]     List the entries in BUGS.md ## Open, numbered (the read
                                   half of --edit/--cancel), each with its eligibility mark;
                                   --json prints the {entries} array — position, title, body,
                                   hold, inProgress — as data; \`[working on it: …]\` marks an
                                   entry a role is working on
  tumwater bug --list --done [-n <count>] [--json]
                                   List the newest entries in BUGS.md ## Fixed, newest first
                                   (default 10); --json prints {entries, older}, each entry
                                   with title, body, completedOn
  tumwater bug --show <n> [--json] Print the Nth entry as the markdown file --edit <n> --file
                                   reads (title, blank line, body with indentation kept);
                                   --json prints {position, title, body, hold}
  tumwater plan "<title>" [body...] [--json]
                                   File a plan request into PLANS.md ## Planned as you
                                   (stamped with today's date; the feature role fleshes the stub
                                   out on pickup) and wake the feature role; --json prints the
                                   {file, title, stamp} payload as data
  tumwater plan --file <path> [--json]
                                   File a plan request from a markdown file ("-" reads stdin):
                                   the first non-blank line is the title, the rest is the body
                                   kept line for line; wakes the feature role
  tumwater plan --release <n> [--json]
                                   Lift the Refused note from the Nth entry in PLANS.md ## Planned
                                   (as \`tumwater plan --list\` lists it), commit it on main,
                                   and wake the feature role; --json prints {file, title}
  tumwater plan --cancel <n> [--json]
                                   Remove the Nth entry in PLANS.md ## Planned (as \`tumwater
                                   plan --list\` lists it); no wake; --json prints {file, title}
  tumwater plan --edit <n> "<title>" [body...] [--json]
                                   Replace the Nth entry's heading and body in PLANS.md ##
                                   Planned in place, keeping its position and original stamp;
                                   no wake; --json prints {file, title}
  tumwater plan --edit <n> --file <path> [--json]
                                   Replace the Nth entry from a markdown file ("-" reads
                                   stdin): the first non-blank line is the title, the rest
                                   the body kept line for line; position and original stamp
                                   kept; no wake; --json prints {file, title}
  tumwater plan --edit <n> [--json]
                                   With neither text nor --file, open the Nth entry as --show
                                   prints it in $VISUAL or $EDITOR and write it back on save;
                                   an unchanged buffer writes nothing
  tumwater plan --list [--json]    List the entries in PLANS.md ## Planned, numbered (the
                                   read half of --edit/--cancel), each with its eligibility
                                   mark; --json prints the {entries} array — position, title,
                                   body, hold, inProgress — as data; \`[working on it: …]\`
                                   marks an entry a role is working on; a series' blocked
                                   parts show as one line naming their positions
  tumwater plan --list --done [-n <count>] [--json]
                                   List the newest entries in PLANS.md ## Done, newest first
                                   (default 10); --json prints {entries, older}, each entry
                                   with title, body, completedOn
  tumwater plan --show <n> [--json]
                                   Print the Nth entry as the markdown file --edit <n> --file
                                   reads (title, blank line, body with indentation kept);
                                   --json prints {position, title, body, hold}
  tumwater questions [--json]      List open questions numbered (the read half of the
                                   question outbox); --json prints the {questions}
                                   array — position, title, body — as data
  tumwater questions --answered [-n <count>] [--json]
                                   List the newest answered questions, newest first (default
                                   10), each with its answer line; --json prints {questions,
                                   older}, each with title, body, answeredOn
  tumwater questions answer [--json] <n> "<decision>"
                                   Answer the Nth open question: stamps today's date on the
                                   entry and moves it to ## Answered with your decision.
                                   --json prints the result as data and must precede <n>:
                                   a --json after the decision is recorded as part of it;
                                   roles read the answer at their next run
  tumwater questions answer [--json] <n> --file <path>
                                   Read the decision from the file (- for stdin) with its
                                   lines kept; a ## or ### heading line outside a code fence,
                                   or an unclosed fence, is refused
  tumwater questions answer [--json] <n>
                                   With no decision, open the question in $VISUAL/$EDITOR;
                                   only the text above the marker line is recorded
  tumwater brief [--json]          Show the project's brief and the file that holds it
  tumwater brief --file <path> [--json]
                                   Replace the brief with the file's text (- for
                                   stdin), refused when empty, over the length cap, or
                                   containing a tumwater:prompt marker; commits that one
                                   file on main; no wake
  tumwater brief --edit [--json]   Open the brief in $VISUAL/$EDITOR and save it as
                                   --file would; an unchanged buffer writes nothing
  tumwater role <id> [--json]      Show one role's instructions and resolved
                                   settings — its built-in instructions, the roles.<id>.instructions override, the resolved
                                   provider/model (naming the budget fallback pair when one is
                                   configured), the min-run interval, enabled/paused state, and
                                   the next run's assembled prompt (the oldest inbox message appears in it
                                   and is NOT consumed — one is dequeued per run); --json prints the collector's payload
                                   as machine-readable data
  tumwater role <id> --clear-notes Clear that role's notes
  tumwater role <id> --notes-file <path>
                                   Replace that role's notes from a file ("-" reads stdin;
                                   4 KB cap); a run in progress at that moment may still
                                   overwrite it through its own role_notes call
  tumwater prompt <text...>        Send a message to the director's inbox
  tumwater prompt --file <path>    Send a message read from a file ("-" reads stdin)
  tumwater prompt --role <id> <text...>
                                   Send a message to that role's inbox for its next run (wakes it)
  tumwater prompt --at <duration> <text...>
                                   Send a message that stays hidden until the duration has
                                   passed (45s, 90m, 1h30m, 1d; capped at 90d — listed and
                                   cancellable while it waits, delivered to the run only
                                   once due)
  tumwater prompt --attach <path> <text...>
                                   Send a message with an image attached (repeat up to 4
                                   images: png, jpg, jpeg, gif, webp, bmp; each at most 5
                                   MiB — saved beside the inbox file for the role's next
                                   run)
  tumwater prompt --list [--json]  Show inbox messages, numbered, grouped by role
                                   (--json prints the {prompts} array as
                                   machine-readable data)
  tumwater prompt --cancel <n>     Remove the Nth inbox message as --list shows them; when
                                   several roles show that N, name one with --role <id>
  tumwater prompt --edit <n> <text...> [--attach <path>]
                                   Replace the Nth inbox message's text in place (position,
                                   age in the inbox, and a pending --at deferral are kept; as
                                   shown by --list); --attach (repeat up to 4) appends images
                                   after any the prompt already carries; when several roles
                                   show that N, name one with --role <id>
  tumwater prompt --edit <n> --file <path> [--attach <path>]
                                   Replace the Nth inbox message's text with the file's
                                   contents ("-" reads stdin), kept line for line; position,
                                   age, and a pending --at deferral are kept, and --role <id>
                                   disambiguates like --edit
  tumwater prompt --edit <n> [--attach <path>]
                                   Open the Nth inbox message in $VISUAL/$EDITOR and save it
                                   as the text form would; an unchanged buffer writes
                                   nothing; --role <id> disambiguates like --edit
  tumwater reset-counters [--role <id>]
                                   Zero lifetime runs/commits/tokens/cost (fresh
                                   observation window; today's budget spend is kept — the
                                   daily cap cannot be reset past)
  tumwater wake [--role <id>] [--in <dur> | --cancel | --list [--json]]
                                   Wake sleeping roles — the named roles (or all) run
                                   within one poll; --in schedules the wake for later;
                                   --cancel drops pending scheduled wakes;
                                   --list shows every pending scheduled wake, earliest first
                                   (--json for scripts)
  tumwater reclaim [--dry-run]     Reclaim gitignored build outputs from every
                                   workspace; --dry-run lists each candidate with its idle age
                                   and ignored-path count and cleans nothing
  tumwater abort --role <id>       Stop that role's run in progress (work discarded; the role
                                   keeps going)
  tumwater pause [--role <id>] [--for <dur>] [--reason <text>]
                                   Stop roles (or just the named role) starting new
                                   runs; --reason states why the whole team is paused (no
                                   per-role reason); --for auto-resumes (capped at 90d)
  tumwater resume [--role <id>]    Lift a team or per-role pause
  tumwater retire --role <id>      Remove a disabled role's workspace, branch, and per-role
                                   state (merge ref, pause marker); --force overrides the
                                   safety rails; --json prints what was removed;
                                   --dry-run lists what would be removed and any objections,
                                   changing nothing
  tumwater stop [--in <duration> | --cancel]
                                   Stop a running team (finishes current work, like Ctrl+C);
                                   --in schedules the stop, --cancel drops it
  tumwater completion <bash|zsh|fish>   Print a shell completion script (eval "$(tumwater completion zsh)" in your rc; fish: tumwater completion fish | source)
  tumwater completion --roles      Print the role ids --role completes (this repo's; the catalog when tumwater.json is unreadable)
  tumwater completion --config-keys  Print the keys config get/set/unset complete (this repo's role keys; the catalog's when tumwater.json is unreadable)
  tumwater help [<command>]        Show all commands, or one command's usage
  tumwater version                 Print the version

tumwater runs inside a git repo. Each role owns a persistent workspace and branch
under .tumwater/, does one task per run with pi, commits, and merges to main. Roles
sleep while there is nothing to do and wake when main moves. Everything is local: no remotes.
`;

/** The listed command closest to a mistyped one, or null when nothing is close enough to
 * suggest. Case-insensitive closest-match over the commands helpStanzas(HELP) names, capped
 * at two edits — a typo's distance, not a different word's — so only a near miss gets a hint
 * and the suggestion can never fire as an auto-correction. Deriving the candidates from the
 * help text (not a hand-kept list) means a new command is suggestible the tick it gains a
 * stanza; the distance mechanics are text/suggest.ts's suggestClosest, shared with the config-key
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

/** Commands that still dispatch but are not listed in help or completion: alias -> the command
 * whose topic they print. `run` is the older name of `start`. */
export const HIDDEN_COMMAND_ALIASES: Readonly<Record<string, string>> = { run: "start", tick: "history" };

/** The usage text for one command — every stanza whose command matches, then a pointer back to
 * the full list — or null when nothing in the help names that command. */
export function helpTopic(command: string, help: string = HELP): string | null {
  if (Object.hasOwn(HIDDEN_COMMAND_ALIASES, command)) command = HIDDEN_COMMAND_ALIASES[command] as string;
  const matches = helpStanzas(help).filter((s) => s.command === command);
  if (matches.length === 0) return null;
  return matches.map((s) => s.text).join("\n") + "\n\nSee `tumwater help` for the full command list.";
}

/** The free-form text commands and the flags that take a separate value token, for
 * helpTopicForArgs: a valued flag's value is plumbing (`prompt --role qa --help`, `bug
 * --cancel 2 --help`), never prose. bug/plan's valued flags are `--cancel`, `--edit`,
 * `--file` and `--release`. */
const FREEFORM_VALUED_FLAGS: Record<string, readonly string[]> = {
  prompt: ["--role", "--file", "--at", "--cancel", "--edit", "--attach"],
  init: ["--branch", "--template", "--file"],
  bug: ["--cancel", "--edit", "--file", "--release"],
  plan: ["--cancel", "--edit", "--file", "--release"],
};

/** The `--help`/`-h` request cli.ts answers before dispatch: the topic text for `command`
 * when the invocation asks for help and names a topic, otherwise null — not a help request,
 * or no topic — and cli.ts dispatches normally (an unknown argument is still named).
 * Intercepted from here because the flag must not collide with a command's real flags and
 * every command gains the convention at once, `help` included; a free-form text command's
 * positionals are operator prose, so a `--help` among them (`tumwater bug the TUI mishandles
 * --help output`) is content, not a request — any non-flag token stands the interception
 * down, while a flag-only invocation (`prompt --role qa --help`) still answers help. */
export function helpTopicForArgs(command: string | undefined, args: readonly string[]): string | null {
  if (command === undefined || command === "--help" || command === "-h") return null;
  if (!args.includes("--help") && !args.includes("-h")) return null;
  if (command in FREEFORM_VALUED_FLAGS) {
    const valued = FREEFORM_VALUED_FLAGS[command] ?? [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--help" || a === "-h") continue;
      if (valued.includes(a)) {
        i++; // the value token is plumbing, never prose
        continue;
      }
      if (!a.startsWith("-")) return null; // a prose token: the command reads the text
    }
  }
  return helpTopic(command);
}
