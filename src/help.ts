/** The CLI's help text and its per-command view. Moved out of cli.ts so the topic parser is
 * testable without importing that module (whose top-level main() would run on import): the
 * full text is one template literal, and helpStanzas/helpTopic derive `tumwater help
 * <command>` from it by splitting the usage block on its `  tumwater <command>` lines, so a
 * topic can never drift out of sync with the full listing. */

export const HELP = `tumwater — autonomous development harness built on pi

Usage:
  tumwater init <prompt...>        Initialize this repo (--file <prompt.md>, --adopt: brief in
                                   TUMWATER.md, --branch <name> seeds a new repo only,
                                   --dry-run: write nothing)
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
  tumwater report [--days N]       Markdown usage report — tokens/ticks/commits per day (default 14 days)
  tumwater report --failures [--days N]
                                   Markdown failure digest — tick outcomes, deltas, clustered errors, and fleet state changes (default 14 days)
  tumwater doctor                  Pre-flight check: node, git, repo, config, fallback model, pi, locks, build, orphans (read-only; exit 0/1)
  tumwater config                 Show the effective config (defaults + tumwater.json) as JSON
  tumwater logs [-f] [-n N]        Show (and follow) harness events
  tumwater logs --role <id> [-f] [-n N] [--prompt]
                                   Show (and follow) that loop's pi transcript
                                   (--prompt also shows each run's exact prompt text)
  tumwater backlog                 Show planned features, open bugs, and open questions (the dashboards' backlog view)
  tumwater prompt <text...>        Queue a prompt for the director loop
  tumwater prompt --role <id> <text...>   Queue a prompt for that loop's next tick (wakes it)
  tumwater prompt --list           Show queued prompts, numbered, grouped by loop
  tumwater prompt --cancel <n>     Remove the Nth queued prompt (as shown by --list)
  tumwater reset-counters [--role <id>]   Zero ticks/commits/tokens/cost (fresh observation window)
  tumwater wake [--role <id>]             Wake a backed-off fleet — the named roles (or all) tick within one poll
  tumwater abort --role <id>              Abort that loop's in-flight tick (work discarded; the loop keeps running)
  tumwater pause [--role <id>]            Stop role loops (or just the named loop) starting new ticks; in-flight finish
  tumwater resume [--role <id>]           Lift a fleet or per-role pause
  tumwater stop                    Stop a running fleet (drains in-flight ticks, like Ctrl+C)
  tumwater help [<command>]        Show all commands, or one command's usage
  tumwater version                 Print the version

The harness runs inside a git repo. Each role loop owns a persistent worktree and branch
under .tumwater/, does one task per tick with pi, commits, and merges to main. Loops back
off while the project is quiet and wake when main moves. Everything is local: no remotes.
`;

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
