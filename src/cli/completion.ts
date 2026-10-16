/** Shell completion derived from the help text. The spec is parsed from the same HELP stanzas
 * `tumwater help <command>` and the unknown-command suggestion use, so a new command or flag
 * completes the moment it gains a help stanza and can never drift from the listing. */
import { customLoopNames, knownRoleIds, loadConfig } from "../config/config.js";
import { AGENT_IDS, AGENT_KEYS, MODEL_TIERS, ROLE_ENTRY_KEYS, TOP_LEVEL_KEYS } from "../config/config-schema.js";
import { DOTTED_MAP_KEYS } from "../config/config-keys.js";
import { HISTORY_RESULT_CLASSES } from "../history/history-data.js";
import { templateIds } from "../init/init-templates.js";
import { allRoleIds } from "../roles/roles.js";
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
  // Usage arguments follow the command after a single space; two or more spaces start the
  // description.
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

/** The ids `--role` completes: this repo's loop ids, or the built-in catalog when tumwater.json is
 * unreadable (a broken config must not write errors into the operator's prompt). */
export function completionRoleIds(root: string): string[] {
  try {
    return knownRoleIds(loadConfig(root));
  } catch {
    return allRoleIds();
  }
}

/** The keys `config get|set|unset` complete: every form parseConfigKey accepts, with the
 * role-scoped keys of this repo's base roles and custom loops (not instance ids like
 * `feature-2`). A broken tumwater.json falls back to the built-in catalog rather than writing
 * errors into the prompt. */
export function completionConfigKeys(root: string): string[] {
  let roleIds: string[];
  try {
    roleIds = [...allRoleIds(), ...customLoopNames(loadConfig(root))];
  } catch {
    roleIds = allRoleIds();
  }
  const keys: string[] = [
    ...TOP_LEVEL_KEYS,
    ...MODEL_TIERS.map((tier) => `model.${tier}`),
    ...AGENT_IDS.flatMap((id) => AGENT_KEYS.map((field) => `agents.${id}.${field}`)),
    ...DOTTED_MAP_KEYS.flatMap((map) => roleIds.map((id) => `${map}.${id}`)),
    ...roleIds.flatMap((id) => ROLE_ENTRY_KEYS.map((field) => `roles.${id}.${field}`)),
  ];
  return [...new Set(keys)];
}

/** Flags whose value is a file path: completion offers file names after them. */
const PATH_FLAGS = ["--file", "--attach", "--notes-file"];

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
    `  local prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
    `  COMPREPLY=()`,
    `  if [ "$prev" = "--role" ] || { [ "$COMP_CWORD" -eq 2 ] && [[ "\${COMP_WORDS[1]}" == role || "\${COMP_WORDS[1]}" == tick ]] && [[ "$cur" != -* ]]; }; then`,
    `    COMPREPLY=( $(compgen -W "$(tumwater completion --roles 2>/dev/null)" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  case "$prev" in ${PATH_FLAGS.join("|")})`,
    `    COMPREPLY=( $(compgen -f -- "$cur") )`,
    `    return 0`,
    `    ;;`,
    `  esac`,
    `  if [ "$prev" = "--template" ]; then`,
    `    COMPREPLY=( $(compgen -W "${templateIds().join(" ")}" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--result" ]; then`,
    `    COMPREPLY=( $(compgen -W "${HISTORY_RESULT_CLASSES.join(" ")}" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$COMP_CWORD" -eq 3 ] && [ "\${COMP_WORDS[1]}" = config ] && [[ "\${COMP_WORDS[2]}" == get || "\${COMP_WORDS[2]}" == set || "\${COMP_WORDS[2]}" == unset ]] && [[ "$cur" != -* ]]; then`,
    `    COMPREPLY=( $(compgen -W "$(tumwater completion --config-keys 2>/dev/null)" -- "$cur") )`,
    `    return 0`,
    `  fi`,
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
