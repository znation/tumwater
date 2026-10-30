/** Shell completion derived from the help text. The spec is parsed from the same HELP stanzas
 * `tumwater help <command>` and the unknown-command suggestion use, so a new command or flag
 * completes the moment it gains a help stanza and can never drift from the listing. */
import { customRoleNames, knownRoleIds, loadConfig } from "../config/config.js";
import { BACKEND_IDS, BACKEND_KEYS, CLAUDE_AGENT_KEYS, CODEX_BACKEND_KEYS, MODEL_TIERS, ROLE_ENTRY_KEYS, THINKING_LEVELS, TOP_LEVEL_KEYS } from "../config/config-schema.js";
import { DOTTED_MAP_KEYS, DOTTED_SECTION_FIELDS } from "../config/config-keys.js";
import { compareCodeUnits, distinctOrdered } from "../collections.js";
import { HISTORY_MAX_RUNS, HISTORY_RESULT_FLAG_NAMES, HISTORY_SUMMARY_GROUPS, readRunRows } from "../history/history-data.js";
import { templateIds } from "../init/init-templates.js";
import { DOCTOR_CHECK_NAMES } from "../doctor/doctor-check-names.js";
import { allRoleIds } from "../roles/roles.js";
import { EVENT_TYPE_LABELS } from "../events/event-labels.js";
import { POST_REVIEW_STATES } from "../review/post-merge-review-render.js";
import { HELP, helpStanzas } from "./help.js";

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof SUPPORTED_SHELLS)[number];

interface CompletionSpec {
  commands: string[];
  subcommands: Record<string, string[]>;
  flags: Record<string, string[]>;
}

/** The usage text of a stanza first line: the part after `tumwater <command>` up to the
 * description column (two or more spaces). */
function usagePortion(firstLine: string, command: string): string {
  const rest = firstLine.replace(new RegExp(`^ {2}tumwater ${command}`), "");
  // Usage arguments follow the command after a single space; two or more spaces start the
  // description.
  return /^ {2,}/.test(rest) ? "" : (rest.split(/ {2,}/)[0] ?? "");
}

/** An angle-bracket alternation of plain words — `<bash|zsh|fish>`, the completion command's
 * shell positional — expands to each alternative as a subcommand word, so `tumwater completion
 * <TAB>` lists exactly the shells the command accepts. A bare placeholder like `<id>` or `<k>`
 * carries no `|` and so stays a placeholder, skipped as before (its `<`/`>` never leave the
 * token, so it never looked like a word). The expansion only fires while the leading run is
 * open; the returned words contribute as the leading words of the usage part. */
function alternationWords(token: string, leading: boolean): string[] | null {
  const alternation = /^<([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)>$/.exec(token);
  return alternation && leading ? alternation[1]!.split("|") : null;
}

/** Whether a token counts as a completable bare word: it is a plain lowercase word and either
 * sits inside brackets, opens a bracket itself, or is still within the leading run. */
function isCompletableWord(bare: string, token: string, depth: number, leading: boolean): boolean {
  return /^[a-z][a-z-]*$/.test(bare) && (depth > 0 || token.startsWith("[") || leading);
}

/** Whether a token ends the leading run: outside brackets, not opening a bracket, and not
 * blank once its brackets and bars are stripped (so an angle-bracket placeholder closes it). */
function endsLeadingRun(bare: string, token: string, depth: number): boolean {
  return depth === 0 && !token.startsWith("[") && bare !== "";
}

/** The bracket-depth delta of a token: `[` +1 and `]` -1 per character, everything else 0. */
function bracketDelta(token: string): number {
  let delta = 0;
  for (const ch of token) delta += ch === "[" ? 1 : ch === "]" ? -1 : 0;
  return delta;
}

/** The completable words of a usage text: the angle-bracket alternation expands, bare lowercase
 * words count inside `[...]` and as the leading run directly after the command, and outside
 * brackets the first other token ends the run. */
function usageWordsIn(usage: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let leading = true;
  for (const token of usage.split(/\s+/).filter(Boolean)) {
    const alternates = alternationWords(token, leading);
    if (alternates) { words.push(...alternates); continue; }
    const bare = token.replace(/[[\]|]/g, "");
    if (isCompletableWord(bare, token, depth, leading)) words.push(bare);
    else if (endsLeadingRun(bare, token, depth)) leading = false;
    depth += bracketDelta(token);
  }
  return words;
}

/** The completable words of a stanza's usage part: the text after `tumwater <command>` up to the
 * description column (two or more spaces). */
function usageWords(firstLine: string, command: string): string[] {
  return usageWordsIn(usagePortion(firstLine, command));
}

export function completionSpec(help: string = HELP): CompletionSpec {
  const stanzas = helpStanzas(help);
  const commands = distinctOrdered(stanzas.map((s) => s.command));
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

/** The ids `--role` completes: this repo's role ids, or the built-in catalog when tumwater.json is
 * unreadable (a broken config must not write errors into the operator's prompt). */
export function completionRoleIds(root: string): string[] {
  try {
    return knownRoleIds(loadConfig(root));
  } catch {
    return allRoleIds();
  }
}

/** The selectors `history --model` completes: the distinct models recent runs started on, in the
 * order `history --summary --by model` lists them. An unreadable or absent log must not write
 * errors into the operator's prompt, and outside a repo it prints nothing. */
export function completionModels(root: string): string[] {
  try {
    const models = new Set<string>();
    for (const row of readRunRows(root, HISTORY_MAX_RUNS, null)) if (row.model !== null) models.add(row.model);
    return [...models].sort(compareCodeUnits);
  } catch {
    return [];
  }
}

/** The keys `config get|set|unset` complete: every form parseConfigKey accepts, with the
 * role-scoped keys of this repo's base roles and custom roles (not instance ids like
 * `feature-2`). A broken tumwater.json falls back to the built-in catalog rather than writing
 * errors into the prompt. */
export function completionConfigKeys(root: string): string[] {
  let roleIds: string[];
  try {
    roleIds = [...allRoleIds(), ...customRoleNames(loadConfig(root))];
  } catch {
    roleIds = allRoleIds();
  }
  const keys: string[] = [
    ...TOP_LEVEL_KEYS,
    ...MODEL_TIERS.map((tier) => `model.${tier}`),
    ...BACKEND_IDS.flatMap((id) => (id === "claude" ? CLAUDE_AGENT_KEYS : id === "codex" ? CODEX_BACKEND_KEYS : BACKEND_KEYS).map((field) => `backends.${id}.${field}`)),
    ...DOTTED_MAP_KEYS.flatMap((map) => roleIds.map((id) => `${map}.${id}`)),
    ...Object.entries(DOTTED_SECTION_FIELDS).flatMap(([section, fields]) => fields.map((field) => `${section}.${field}`)),
    ...roleIds.flatMap((id) => ROLE_ENTRY_KEYS.map((field) => `roles.${id}.${field}`)),
  ];
  return distinctOrdered(keys);
}

/** The value vocabulary `config set <key> <value>` completes for one key, or [] when the
 * field is free-form. The discrete-valued keys source the SAME closed constants the config
 * validation accepts — BACKEND_IDS for a `.backend` field or the top-level `backend`,
 * MODEL_TIERS for a `.model` field (the tier-name shorthand checkModelTripleField/review
 * allow), THINKING_LEVELS for a `.thinking` field or the top-level `thinking`, and
 * `true|false` for the always-boolean `.enabled` — so a domain changes the moment its
 * constant does. `provider` (top-level, `roles.<id>.provider`, `review.provider`) is a
 * free-form pi provider name, NOT a backend id — the ids validation rejects as the retired
 * backend namespace on the default pi backend — so it completes nothing rather than offering
 * ids that `set` would refuse. Number/free-text values (instances, minRunIntervalSeconds,
 * maxDailyCostUsd, backends' bin/args, a full model id) are not worth a TAB either. The
 * `config set` value-position arm in bashScript shells out here, so the vocabulary lives in
 * exactly one place on every shell. */
export function configValueWords(key: string): string[] {
  const dot = key.lastIndexOf(".");
  if (dot < 0) {
    // A dot-less key is a whole top-level key (TOP_LEVEL_KEYS); `backend` and `thinking` are
    // the two discrete-valued ones, the rest are free-form numbers/strings/objects.
    switch (key) {
      case "backend": return [...BACKEND_IDS];
      case "thinking": return [...THINKING_LEVELS];
      default: return [];
    }
  }
  switch (key.slice(dot + 1)) {
    case "enabled": return ["true", "false"];
    case "backend": return [...BACKEND_IDS];
    case "model": return [...MODEL_TIERS];
    case "thinking": return [...THINKING_LEVELS];
    default: return [];
  }
}

/** Commands whose first positional (word 2) is a role id, so completion offers
 * `tumwater completion --roles` there. */
const ROLE_POSITIONAL_COMMANDS = ["role", "history", "revert"];

/** Flags whose value is a file path: completion offers file names after them. Derived from the
 * HELP text, which renders every path-valued flag as `--<flag> <path>`, so a new or renamed
 * path flag completes the moment its help stanza does — the same drift-free source the rest of
 * completion reads from. */
const PATH_FLAGS = [
  ...new Set([...HELP.matchAll(/--([a-z][a-z-]*) <path>/g)].map((m) => `--${m[1]}`)),
];

/** The constant fish value suffix for the flags whose candidates are a fixed `__tumwater_*` list:
 * `--role`, `--result`, `--type` and `--status` take comma lists, so they complete per item through
 * `__fish_complete_list`, skipping the items already listed. */
const FISH_LIST_FLAG_SUFFIXES: Record<string, string> = {
  "--role": ` -x -a "(__fish_complete_list , __tumwater_roles)"`,
  "--result": ` -x -a "(__fish_complete_list , __tumwater_results)"`,
  "--type": ` -x -a "(__fish_complete_list , __tumwater_types)"`,
  "--status": ` -x -a "(__fish_complete_list , __tumwater_review_states)"`,
};

/** The event-type codes `logs --type` filters by: the keys of the labels map, so a new event
 * type completes the moment it gains a label. Sorted for a stable, alphabetical offer of a
 * vocabulary too large to recall offhand — the same reason `--role`, `--template`, and
 * `--result` complete their values. */
const EVENT_TYPE_CODES = Object.keys(EVENT_TYPE_LABELS).sort();

/** The pi `--thinking` levels `role <id> --thinking <level>` accepts: the canonical
 * THINKING_LEVELS set, Set spread preserving its insertion order (= the order the
 * role-help and config-field-checks message list them), so `--thinking` completes its
 * vocabulary the way `--type` and `--result` complete theirs. One source, so a new level
 * completes the moment THINKING_LEVELS grows. */
const THINKING_LEVEL_WORDS = [...THINKING_LEVELS];

/** The review states `reviews --status` filters by: the canonical POST_REVIEW_STATES set,
 * spread preserving its insertion order, so `--status` completes the same vocabulary
 * `parseReviewStatusList` accepts. One source, so a new state completes the moment
 * POST_REVIEW_STATES grows. */
const REVIEW_STATE_WORDS = [...POST_REVIEW_STATES];

/** The doctor check names, each in plain double quotes, for the scripts to loop over. The names
 * hold no `"`, `$`, backtick or `\`, so plain double quotes are exact; a test pins this. */
const DOCTOR_CHECK_WORDS = DOCTOR_CHECK_NAMES.map((n) => `"${n}"`).join(" ");

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
    `# Completes the item after the last comma of a comma-list value, keeping the items before it and dropping those already listed.`,
    `_tumwater_list() {`,
    `  local head="" word words=""`,
    `  [[ "$2" == *,* ]] && head="\${2%,*},"`,
    `  for word in $(printf '%s\\n' "$1"); do`,
    `    [[ ",$head" == *",$word,"* ]] || words+="$word "`,
    `  done`,
    `  COMPREPLY=( $(compgen -P "$head" -W "$words" -- "\${2##*,}") )`,
    `}`,
    `_tumwater() {`,
    `  local cur="\${COMP_WORDS[COMP_CWORD]}"`,
    `  local prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
    `  COMPREPLY=()`,
    `  if [ "\${COMP_WORDS[1]}" = doctor ] && [ "$COMP_CWORD" -ge 2 ] && [[ "$cur" != -* ]]; then`,
    `    local word="$cur" quote="" name`,
    `    case "$word" in \\"*|\\'*) quote="\${word:0:1}"; word="\${word:1}";; esac`,
    `    word="\${word//\\\\/}"`,
    `    for name in ${DOCTOR_CHECK_WORDS}; do`,
    `      if [[ "$name" == "$word"* ]]; then`,
    `        if [ -n "$quote" ]; then COMPREPLY+=("$name"); else COMPREPLY+=("$(printf '%q' "$name")"); fi`,
    `      fi`,
    `    done`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--role" ] || { [ "$prev" = "--transcript" ] && [ "\${COMP_WORDS[1]}" = logs ]; } || { [ "$COMP_CWORD" -eq 2 ] && [[ ${ROLE_POSITIONAL_COMMANDS.map((c) => `"\${COMP_WORDS[1]}" == ${c}`).join(" || ")} ]] && [[ "$cur" != -* ]]; }; then`,
    `    _tumwater_list "$(tumwater completion --roles 2>/dev/null)" "$cur"`,
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
    `    _tumwater_list "${Object.values(HISTORY_RESULT_FLAG_NAMES).join(" ")}" "$cur"`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--type" ]; then`,
    `    _tumwater_list "${EVENT_TYPE_CODES.join(" ")}" "$cur"`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--status" ]; then`,
    `    _tumwater_list "${REVIEW_STATE_WORDS.join(" ")}" "$cur"`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--thinking" ]; then`,
    `    COMPREPLY=( $(compgen -W "${THINKING_LEVEL_WORDS.join(" ")}" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--backend" ]; then`,
    `    COMPREPLY=( $(compgen -W "${BACKEND_IDS.join(" ")}" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--by" ]; then`,
    `    COMPREPLY=( $(compgen -W "${HISTORY_SUMMARY_GROUPS.join(" ")}" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    `  if [ "$prev" = "--model" ] && [ "\${COMP_WORDS[1]}" = role ]; then`,
    `    COMPREPLY=( $(compgen -W "${MODEL_TIERS.join(" ")}" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    // bash splits at `:`; past a selector's colon `prev` is not --model, so nothing completes.
    // A comma list, like --role, so it completes per item.
    `  if [ "$prev" = "--model" ] && [ "\${COMP_WORDS[1]}" = history ]; then`,
    `    _tumwater_list "$(tumwater completion --models 2>/dev/null)" "$cur"`,
    `    return 0`,
    `  fi`,
    `  if [ "$COMP_CWORD" -eq 3 ] && [ "\${COMP_WORDS[1]}" = config ] && [[ "\${COMP_WORDS[2]}" == get || "\${COMP_WORDS[2]}" == set || "\${COMP_WORDS[2]}" == unset ]] && [[ "$cur" != -* ]]; then`,
    `    COMPREPLY=( $(compgen -W "$(tumwater completion --config-keys 2>/dev/null)" -- "$cur") )`,
    `    return 0`,
    `  fi`,
    // config set's VALUE sits at word 4, after the key a set write scopes (get/unset take no
    // value, so only set reaches here). It shells out for the key's discrete vocabulary — the
    // dotted fields (roles.<id>.<field>, review.<field>) and the top-level `backend`/`thinking`
    // keys — and resolves to nothing for a free-form value, all decided in configValueWords so
    // the vocabulary lives in exactly one place on every shell.
    `  if [ "$COMP_CWORD" -eq 4 ] && [ "\${COMP_WORDS[1]}" = config ] && [ "\${COMP_WORDS[2]}" = set ] && [[ "$cur" != -* ]]; then`,
    `    COMPREPLY=( $(compgen -W "$(tumwater completion --config-value "\${COMP_WORDS[3]}" 2>/dev/null)" -- "$cur") )`,
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

/** The fish value suffix for the flags whose value depends on the command: `--transcript` has role
 * ids only under `logs`, and `--model` completes the closed tier set under `role` but the log's
 * selectors under `history`. Undefined for a flag this helper does not own. */
function fishScopedFlagSuffix(command: string, flag: string): string | undefined {
  if (flag === "--transcript" && command === "logs") return FISH_LIST_FLAG_SUFFIXES["--role"];
  if (flag === "--model" && command === "role") return ` -x -a "${MODEL_TIERS.join(" ")}"`;
  if (flag === "--model" && command === "history") return ` -x -a "(__fish_complete_list , __tumwater_models)"`;
  return undefined;
}

/** The fish value suffix for the flags whose candidates are a joined literal list. Undefined for a
 * flag this helper does not own. */
function fishWordSuffix(flag: string): string | undefined {
  switch (flag) {
    case "--template": return ` -x -a "${templateIds().join(" ")}"`;
    case "--thinking": return ` -x -a "${THINKING_LEVEL_WORDS.join(" ")}"`;
    case "--backend": return ` -x -a "${BACKEND_IDS.join(" ")}"`;
    case "--by": return ` -x -a "${HISTORY_SUMMARY_GROUPS.join(" ")}"`;
    default: return undefined;
  }
}

/** The value suffix a fish flag line carries: what completes after the flag. `--role`, `--result`
 * `--type` and `--status` take comma lists, so they complete per item through
 * `__fish_complete_list`,
 * skipping the items already listed. Tries the command-scoped flags, then the fixed
 * `__tumwater_*` list table, then the joined literal-word flags, and finally the path flags, in
 * the same order the ladder did. */
function fishFlagValue(command: string, flag: string): string {
  return fishScopedFlagSuffix(command, flag) ?? FISH_LIST_FLAG_SUFFIXES[flag] ?? fishWordSuffix(flag) ?? (PATH_FLAGS.includes(flag) ? " -r -F" : "");
}

function fishScript(help: string): string {
  const spec = completionSpec(help);
  const lines = [
    `# tumwater completion (generated from \`tumwater help\`)`,
    `complete -c tumwater -f`,
    `function __tumwater_argc; count (commandline -opc); end`,
    `function __tumwater_doctor_checks; printf '%s\\n' ${DOCTOR_CHECK_WORDS}; end`,
    `function __tumwater_unlisted; set -l typed (string split , -- (string match -r '^.*,' -- (commandline -ct))); while read -l word; contains -- $word $typed; or echo $word; end; end`,
    `function __tumwater_roles; tumwater completion --roles 2>/dev/null | __tumwater_unlisted; end`,
    `function __tumwater_results; printf '%s\\n' ${Object.values(HISTORY_RESULT_FLAG_NAMES).join(" ")} | __tumwater_unlisted; end`,
    `function __tumwater_models; tumwater completion --models 2>/dev/null | __tumwater_unlisted; end`,
    `function __tumwater_types; printf '%s\\n' ${EVENT_TYPE_CODES.join(" ")} | __tumwater_unlisted; end`,
    `function __tumwater_review_states; printf '%s\\n' ${REVIEW_STATE_WORDS.join(" ")} | __tumwater_unlisted; end`,
    `complete -c tumwater -n __fish_use_subcommand -a "${spec.commands.join(" ")}"`,
  ];
  for (const command of spec.commands) {
    const subs = spec.subcommands[command] ?? [];
    if (subs.length > 0)
      lines.push(`complete -c tumwater -n "__fish_seen_subcommand_from ${command}; and test (__tumwater_argc) -eq 2" -a "${subs.join(" ")}"`);
    for (const flag of spec.flags[command] ?? [])
      lines.push(`complete -c tumwater -n "__fish_seen_subcommand_from ${command}" -l ${flag.slice(2)}${fishFlagValue(command, flag)}`);
  }
  lines.push(
    `complete -c tumwater -n "__fish_seen_subcommand_from ${ROLE_POSITIONAL_COMMANDS.join(" ")}; and test (__tumwater_argc) -eq 2" -a "(tumwater completion --roles 2>/dev/null)"`,
    `complete -c tumwater -n "__fish_seen_subcommand_from config; and __fish_seen_subcommand_from get set unset; and test (__tumwater_argc) -eq 3" -a "(tumwater completion --config-keys 2>/dev/null)"`,
    `complete -c tumwater -n "__fish_seen_subcommand_from config; and __fish_seen_subcommand_from set; and test (__tumwater_argc) -eq 4" -a "(tumwater completion --config-value (commandline -opc)[4] 2>/dev/null)"`,
    `complete -c tumwater -n "__fish_seen_subcommand_from doctor" -a "(__tumwater_doctor_checks)"`,
    ``,
  );
  return lines.join("\n");
}

export function completionScript(shell: CompletionShell, help: string = HELP): string {
  if (shell === "fish") return fishScript(help);
  const bash = bashScript(help);
  return shell === "zsh" ? `autoload -U +X bashcompinit && bashcompinit\n${bash}` : bash;
}
