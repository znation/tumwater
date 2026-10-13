/** Shell completion derived from the help text. The spec is parsed from the same HELP stanzas
 * `tumwater help <command>` and the unknown-command suggestion use, so a new command or flag
 * completes the moment it gains a help stanza and can never drift from the listing. */
import { HELP, helpStanzas } from "./help.js";

export const SUPPORTED_SHELLS = ["bash", "zsh"] as const;
export type CompletionShell = (typeof SUPPORTED_SHELLS)[number];

interface CompletionSpec {
  commands: string[];
  subcommands: Record<string, string[]>;
  flags: Record<string, string[]>;
}

/** The completable words of a stanza's usage part: the text after `tumwater <command>` up to the
 * description column (two or more spaces). Bare lowercase words count inside `[...]` and as the
 * leading run directly after the command; outside brackets the first other token ends the run, so
 * a single-space description (`role <id> --clear-notes Clear that notebook`) adds nothing. */
function usageWords(firstLine: string, command: string): string[] {
  const rest = firstLine.replace(new RegExp(`^ {2}tumwater ${command}`), "");
  // Usage arguments follow the command after a single space; two or more spaces start the description.
  const usage = /^ {2,}/.test(rest) ? "" : (rest.split(/ {2,}/)[0] ?? "");
  const words: string[] = [];
  let depth = 0;
  let leading = true;
  for (const token of usage.split(/\s+/).filter(Boolean)) {
    const bare = token.replace(/[[\]|]/g, "");
    const isWord = /^[a-z][a-z-]*$/.test(bare);
    if (isWord && (depth > 0 || token.startsWith("[") || leading)) words.push(bare);
    else if (depth === 0 && !token.startsWith("[") && bare !== "") leading = false;
    for (const ch of token) depth += ch === "[" ? 1 : ch === "]" ? -1 : 0;
  }
  return words;
}

export function completionSpec(help: string = HELP): CompletionSpec {
  const stanzas = helpStanzas(help);
  const commands = [...new Set(stanzas.map((s) => s.command))];
  const subcommands: Record<string, string[]> = {};
  const flags: Record<string, string[]> = {};
  for (const command of commands) {
    const own = stanzas.filter((s) => s.command === command);
    const flagSet = new Set<string>(["--help"]);
    const subs = new Set<string>();
    for (const stanza of own) {
      for (const match of stanza.text.matchAll(/--[a-z][a-z-]*/g)) flagSet.add(match[0]);
      for (const word of usageWords(stanza.text.split("\n")[0] ?? "", command)) subs.add(word);
    }
    flags[command] = [...flagSet].sort();
    subcommands[command] = command === "help" ? commands : [...subs];
  }
  return { commands, subcommands, flags };
}

function bashScript(help: string): string {
  const spec = completionSpec(help);
  const arms = spec.commands.map((command) => {
    const subs = spec.subcommands[command] ?? [];
    const flags = spec.flags[command] ?? [];
    return [
      `    ${command})`,
      `      if [[ "$cur" == -* ]]; then`,
      `        COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )`,
      ...(subs.length > 0
        ? [
            `      elif [ "$COMP_CWORD" -eq 2 ]; then`,
            `        COMPREPLY=( $(compgen -W "${subs.join(" ")}" -- "$cur") )`,
          ]
        : []),
      `      fi`,
      `      ;;`,
    ].join("\n");
  });
  return [
    `# tumwater completion (generated from \`tumwater help\`)`,
    `_tumwater() {`,
    `  local cur="\${COMP_WORDS[COMP_CWORD]}"`,
    `  COMPREPLY=()`,
    `  if [ "$COMP_CWORD" -eq 1 ]; then`,
    `    COMPREPLY=( $(compgen -W "${spec.commands.join(" ")}" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  case "\${COMP_WORDS[1]}" in`,
    ...arms,
    `  esac`,
    `  return 0`,
    `}`,
    `complete -F _tumwater tumwater`,
    ``,
  ].join("\n");
}

export function completionScript(shell: CompletionShell, help: string = HELP): string {
  const bash = bashScript(help);
  return shell === "zsh" ? `autoload -U +X bashcompinit && bashcompinit\n${bash}` : bash;
}
