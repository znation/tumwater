/** The CLI’s per-command help view. Moved out of cli.ts so the topic parser is testable
 * without importing that module (whose top-level main() would run on import): the full text
 * lives in help-text.ts as one template literal, and helpStanzas/helpTopic derive
 * `tumwater help <command>` from it by splitting the usage block on its `  tumwater
 * <command>` lines, so a topic can never drift out of sync with the full listing. HELP is
 * re-exported so cli.ts and completion.ts keep importing it from here. */
import { suggestClosest } from "../text/suggest.js";
import { distinctOrdered } from "../collections.js";
import { HELP } from "./help-text.js";
export { HELP };
/** The listed command closest to a mistyped one, or null when nothing is close enough to
 * suggest. Case-insensitive closest-match over the commands helpStanzas(HELP) names, capped
 * at two edits — a typo's distance, not a different word's — so only a near miss gets a hint
 * and the suggestion can never fire as an auto-correction. Deriving the candidates from the
 * help text (not a hand-kept list) means a new command is suggestible the run it gains a
 * stanza; the distance mechanics are text/suggest.ts's suggestClosest, shared with the config-key
 * suggestion. */
export function suggestCommand(input: string, help: string = HELP): string | null {
  return suggestClosest(input, distinctOrdered(helpStanzas(help).map((s) => s.command)));
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
export const HIDDEN_COMMAND_ALIASES: Readonly<Record<string, string>> = { run: "start", tick: "history" }; // retired-name-ok: legacy name

/** The missing-value wording of `help --grep` (shared by cli.ts's parseGrepFlag fail and the
 * tests that pin the error, so the two cannot drift). */
export const HELP_GREP_VALUE_ERROR = "help --grep needs text (usage: tumwater help --grep <text>)";

/** The usage text for one command — every stanza whose command matches, then a pointer back to
 * the full list — or null when nothing in the help names that command. */
export function helpTopic(command: string, help: string = HELP): string | null {
  if (Object.hasOwn(HIDDEN_COMMAND_ALIASES, command)) command = HIDDEN_COMMAND_ALIASES[command] as string;
  const matches = helpStanzas(help).filter((s) => s.command === command);
  if (matches.length === 0) return null;
  return matches.map((s) => s.text).join("\n") + "\n\nSee `tumwater help` for the full command list.";
}

/** The usage stanzas whose command line or description contains a text, case-insensitively, in
 * help order — the `tumwater help --grep` search. Each matching stanza's text is returned
 * verbatim (multiple usage forms of one command each print separately, like helpTopic joins
 * them), and an empty array means nothing matched. Searching the same stanza text helpStanzas
 * derives keeps the search's answers from drifting out of sync with the full listing. */
export function searchHelp(text: string, help: string = HELP): string[] {
  const needle = text.toLowerCase();
  return helpStanzas(help)
    .filter((s) => s.text.toLowerCase().includes(needle))
    .map((s) => s.text);
}

/** The free-form text commands and the flags that take a separate value token, for
 * helpTopicForArgs: a valued flag's value is plumbing (`prompt --role qa --help`, `bug
 * --cancel 2 --help`, `bug --retire 1 --help`), never prose. bug/plan's valued flags are
 * `--cancel`, `--retire`, `--reason`, `--edit`, `--file`, `--release` and `--top`. */
const FREEFORM_VALUED_FLAGS: Record<string, readonly string[]> = {
  prompt: ["--role", "--file", "--at", "--cancel", "--edit", "--attach", "--top", "--show", "--grep"],
  init: ["--branch", "--template", "--file"], // --json is valueless: the flag token alone is a help request, like prompt/bug
  bug: ["--cancel", "--retire", "--reason", "--edit", "--file", "--release", "--top"],
  plan: ["--cancel", "--retire", "--reason", "--edit", "--file", "--release", "--top"],
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
