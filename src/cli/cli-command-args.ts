/** The free-form-prompt commands' bespoke argument parsers: `tumwater init` and
 * `tumwater prompt`, whose positionals are prompt TEXT rather than a token list. Every
 * shared helper in cli/cli-args.ts assumes flags claim their tokens and rejects whatever is
 * left over — exactly wrong here, where a misspelled flag must fail instead of being
 * silently baked into the prompt that every role then runs from. Both parsers therefore
 * hand-roll the same discipline (a double-dash token must be a known flag, given at most
 * once; single-dash tokens are content) and share failStrayArg, so they live together
 * apart from cli/cli-args.ts's generic machinery — which also keeps that module, minus these
 * two, free of I/O: --file's readFileSync is the one read in the CLI's arg layer. */

import fs from "node:fs";
import { failOverDurationCap, parseBranchFlag, parseDurationFlag, parsePositionFlag, rejectRepeatFlag } from "./cli-args.js";
import { PAUSE_FOR_MAX_MS } from "../operator/operator-intent.js";
import {
  type FlagSpec,
  JSON_FLAG,
  ROLE_FLAG,
  ROLE_VALUE_ERROR,
  rejectUnknownDoubleDash,
} from "./cli-flag-specs.js";
import { fail } from "./cli-output.js";
import { DOCTOR_CHECK_NAMES, type DoctorCheckName } from "../doctor/doctor-check-names.js";
import { typoSuffix } from "../text/suggest.js";
import { templateIds, unknownTemplateError } from "../init/init-templates.js";
import { errorMessage } from "../text/text.js";

/** Peel a positional-first command's bare tokens off the argument list: every flag-shaped
 * token rides in rest for rejectUnknownArgs, every bare token is a positional. For commands
 * with no valued flags (history: `--json` alone; bug/plan via fileAndAnnounce) the split is a
 * prefix test — a negative run number (`history bugfix -3`) arrives flag-shaped and fails the
 * unknown-arg gate, which is the right answer for a non-positive n anyway. Lives here with
 * the CLI's other argument helpers, shared by cli.ts's history case and
 * backlog-cli.ts's fileAndAnnounce. */
export function peelPositionals(args: string[]): {
  positionals: string[];
  rest: string[];
} {
  const positionals: string[] = [];
  const rest: string[] = [];
  for (const arg of args) (arg.startsWith("-") ? rest : positionals).push(arg);
  return { positionals, rest };
}

/** Map `tumwater doctor`'s bare tokens to check names (case-insensitive, deduplicated, in the
 * order named); undefined for none, which runs every check. An unknown name fails with the
 * closest check as a hint. */
export function parseDoctorChecks(positionals: string[]): DoctorCheckName[] | undefined {
  if (positionals.length === 0) return undefined;
  const names = new Set<DoctorCheckName>();
  for (const token of positionals) {
    const name = DOCTOR_CHECK_NAMES.find((n) => n.toLowerCase() === token.toLowerCase());
    if (name === undefined)
      fail(
        `tumwater doctor: unknown check "${token}"${typoSuffix(token, DOCTOR_CHECK_NAMES)} (\`tumwater doctor\` lists every check by name)`,
      );
    else names.add(name);
  }
  return [...names];
}

/** The `history` listing flags that take a separate value token. */
const HISTORY_LISTING_VALUED_FLAGS = ["-n", "--since", "--until", "--grep", "--result", "--role", "--model", "--by"];

/** True when `history`'s args are the one-run trail form (`history <role> <n>`, `history
 * <role> --last`, bare `history --last`): `--last`, or a token that is neither a flag nor the
 * value of a listing-form valued flag. A valued flag's value is skipped by position, so
 * `--grep -x` stays a listing. */
export function historyTrailForm(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (HISTORY_LISTING_VALUED_FLAGS.includes(arg)) i++;
    else if (!arg.startsWith("-") || arg === "--last") return true;
  }
  return false;
}

/** Fail when any token is not at one of the `claimed` positions — the shared "no extra tokens"
 * check for commands whose positionals are free-form prompt text (init, prompt): with their
 * flags present, every other token would be silently baked into the prompt. Names the first
 * stray token in the standard `unexpected argument <json> — <reason>` shape so the call sites'
 * messages cannot drift. */
function failStrayArg(args: string[], reason: string, ...claimed: number[]): void {
  const extra = args.find((_, i) => !claimed.includes(i));
  if (extra !== undefined) fail(`unexpected argument ${JSON.stringify(extra)} — ${reason}`);
}

/** The two positions a valued flag claims for a free-form-prompt parser's stray-argument
 * accounting: the flag token and its value — the flag and its value are never prompt content.
 * Empty when the flag is absent, so a negative index never over-claims a real token. The one
 * shape every valued-flag pair claims for the parsePromptFlags/parsePromptArgs stray-argument
 * accounting — `--role`, `--grep`, `--at` in parsePromptFlags and `--file` in editPromptArgs
 * ("claimed like --role's": each site is this same pair) — so no site can drift from the others. */
function pairClaim(flagIndex: number): number[] {
  return flagIndex >= 0 ? [flagIndex, flagIndex + 1] : [];
}

/** Read a `--file <path>` prompt file: fail naming the file when it cannot be read. A raw
 * ENOENT/EISDIR names the path but not its role, so the message says this was the --file
 * prompt. Shared by the init and prompt parsers' path branches; the prompt parser's stdin
 * branch (`-`) reads fd 0 itself — its read must be cached and its read-error names stdin —
 * and both parsers check emptiness through failEmptyPromptFile (via readPromptFileChecked
 * for real paths). */
function readPromptFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    fail(`cannot read prompt file ${JSON.stringify(file)}: ${errorMessage(err)}`);
  }
}

/** A `--file <path>` value that must be present: the one home of the missing-value refusal
 * shared by every `--file`-taking parser — init, prompt's edit and enqueue branches, plan/bug
 * add and edit (fileAndAnnounce / editAndAnnounce), and the questions command — so the wording
 * cannot drift between them. The flag token itself is claimed by each parser's stray-argument
 * accounting; this helper only owns the value. */
export function promptFileValue(file: string | undefined): string {
  if (!file) fail("--file needs a path");
  return file;
}

/** The read+emptiness pair both parsers apply to a real `--file <path>`: read through
 * readPromptFile (whose error names the file's role) and refuse an empty file through
 * failEmptyPromptFile, in one place so the two parsers' path branches cannot drift apart.
 * The prompt parser's stdin branch (`-`) keeps its own read — it must be cached and its
 * read-error names stdin — and calls failEmptyPromptFile itself. */
function readPromptFileChecked(file: string): string {
  const contents = readPromptFile(file);
  failEmptyPromptFile(file, contents);
  return contents;
}

/** Fail when a read `--file` prompt holds no text: an empty (or whitespace-only) file reads
 * as an empty prompt, which the bare-init path would then treat as "re-seed from README.md"
 * (the operator's --file argument silently ignored on an initialized repo), and a generic
 * "a brief is required" (which never names the file) on a fresh one; the prompt
 * queue would enqueue nothing. Names the file, like every other bad --file shape. Shared by
 * the init and prompt parsers, so the message cannot drift between them. */
function failEmptyPromptFile(file: string, contents: string): void {
  if (contents.trim() === "")
    fail(`the prompt file ${JSON.stringify(file)} is empty — it carries no prompt text`);
}

/** init's flag vocabulary (plans/portability.md §7/7, correction 1): --file and --branch take
 * a value; --adopt and --dry-run are valueless and are never prompt content. One definition,
 * shared by the unknown-flag loop and the `--flag=value` refusal inside it. */
const INIT_FLAG_SPECS: readonly FlagSpec[] = [
  { names: ["--file"], value: true, valueName: "<path>" },
  { names: ["--branch"], value: true, valueName: "<name>" },
  { names: ["--template"], value: true, valueName: "<id>" },
  { names: ["--adopt"] },
  { names: ["--dry-run"] },
  { names: ["--list-templates"] },
];
/** init's valueless flags, derived from the vocabulary so the two lists cannot drift. */
const INIT_BOOLEAN_FLAGS: readonly string[] = INIT_FLAG_SPECS.filter((s) => !s.value).flatMap((s) => s.names);

/** The refusal both `--list-templates` prompt conflicts share: the flag only lists the catalog,
 * so it takes no prompt. Two call sites in parseInitArgs: the `--file` branch and the
 * positional-token branch. */
const LIST_TEMPLATES_PROMPT_ERROR =
  "--list-templates takes no prompt — run `tumwater init --list-templates` alone";

/** The two parsers' shared "each flag at most once" rule: refuse a repeated flag with the
 * same "may only be given once" wording parseFlagSpecs' spec-driven check applies to the
 * spec-parsed commands. Two call sites: parseInitArgs (over every known flag) and
 * parsePromptArgs (over --list/--cancel/--role/--json). */
function rejectDuplicateFlags(args: readonly string[], flags: readonly string[]): void {
  for (const flag of flags) rejectRepeatFlag(args.filter((a) => a === flag).length > 1, flag);
}

/** The fields `parseInitArgs` resolves for `tumwater init`, returned to the caller as one
 * object. */
interface InitArgs {
  prompt: string;
  branch: string | null;
  template: string | null;
  listTemplates: boolean;
  adopt: boolean;
  dryRun: boolean;
}

/** The flag-vocabulary gate for `tumwater init`: every double-dash token must be a known
 * INIT_FLAG_SPECS flag, each given at most once. Without it a misspelled --file would be baked
 * into the brief text — injected into every run of every role until someone edits the project
 * brief. */
function assertInitFlags(args: string[]): void {
  const known = INIT_FLAG_SPECS.flatMap((s) => s.names);
  // The unknown-double-dash gate reads the specs, so the list its error names admits exactly
  // what the duplicate-flag check below accepts — one vocabulary, one message renderer.
  rejectUnknownDoubleDash("init", args, INIT_FLAG_SPECS);
  rejectDuplicateFlags(args, known);
}

/** Resolve `--template <id>` from the argument list, refusing an empty id, an id unknown to
 * the catalog, and a `--template` given alongside `--list-templates`. Validated here so an
 * unknown id fails before initProject runs any side effect — before a half-seeded repo can
 * result from a typo'd id. */
function resolveInitTemplate(args: string[], listTemplates: boolean): string | null {
  // Validate the template id here, so an unknown one fails before initProject runs any side
  // effect — and before a half-seeded repo can result from a typo'd id.
  const templateFlag = args.indexOf("--template");
  let template: string | null = null;
  if (templateFlag >= 0) {
    template = args[templateFlag + 1] ?? "";
    if (!template) fail("--template needs an id");
    if (!templateIds().includes(template)) {
      fail(unknownTemplateError(template));
    }
  }
  if (listTemplates && templateFlag >= 0) {
    fail("--list-templates takes no --template — it lists the catalog, it does not use one");
  }
  return template;
}

/** The `--file` branch of `parseInitArgs`: when the flag is present the prompt comes from the
 * file, so every other positional is claimed (refused as stray) and the file's exact contents
 * are read as the prompt — unless `--list-templates` conflicts, which takes no prompt at all.
 * Returns null when no `--file` flag is present. */
function resolveInitFileArg(args: string[], base: Omit<InitArgs, "prompt">): InitArgs | null {
  const fileFlag = args.indexOf("--file");
  if (fileFlag < 0) return null;
  const file = promptFileValue(args[fileFlag + 1]);
  const claimed = [fileFlag, fileFlag + 1];
  const branchFlag = args.indexOf("--branch");
  if (branchFlag >= 0) claimed.push(branchFlag, branchFlag + 1);
  const templateFlag = args.indexOf("--template");
  if (templateFlag >= 0) claimed.push(templateFlag, templateFlag + 1);
  for (const flag of INIT_BOOLEAN_FLAGS) {
    if (args.includes(flag)) claimed.push(args.indexOf(flag));
  }
  failStrayArg(args, "with --file the prompt comes from the file", ...claimed);
  const contents = readPromptFileChecked(file);
  if (base.listTemplates) {
    fail(LIST_TEMPLATES_PROMPT_ERROR);
  }
  return { ...base, prompt: contents };
}

/** Reconstruct the positional prompt text for `tumwater init`: everything except the
 * `--branch`/`--template` pairs and the valueless flags is prompt text. The join keeps
 * single-dash tokens as content, exactly as before — with no flag present this is the old
 * args.join(" "). */
function joinInitPrompt(args: string[]): string {
  const promptTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--branch" || arg === "--template") i++; // Skip the pair's value too.
    else if (!INIT_BOOLEAN_FLAGS.includes(arg)) promptTokens.push(arg);
  }
  return promptTokens.join(" ");
}

/** `tumwater init` argument handling. Init's positionals are free-form prompt text, so
 * rejectUnknownArgs (which rejects ANY unconsumed token) can't be used wholesale. The rules
 * instead: a double-dash token must be a known flag from INIT_FLAG_SPECS, each given at most
 * once; with `--file` present nothing but the other flags may accompany it; a `--branch
 * <name>` pair and the valueless flags are never prompt content; single-dash positionals are
 * prompt content, not flags. */
export function parseInitArgs(args: string[]): InitArgs {
  assertInitFlags(args);
  const branch = parseBranchFlag(args);
  const adopt = args.includes("--adopt");
  const dryRun = args.includes("--dry-run");
  const listTemplates = args.includes("--list-templates");
  const template = resolveInitTemplate(args, listTemplates);
  const base = { branch, template, listTemplates, adopt, dryRun };
  const fromFile = resolveInitFileArg(args, base);
  if (fromFile !== null) return fromFile;
  const prompt = joinInitPrompt(args);
  if (listTemplates && prompt.trim() !== "") fail(LIST_TEMPLATES_PROMPT_ERROR);
  return { ...base, prompt };
}

/** The four modes of `tumwater prompt`: enqueue free-form text (the default), list the queue,
 * cancel one entry by its 1-based position, edit one entry's text in place by that same
 * position, or move one entry to the head of its role's queue (`--top <n>`). `role` is the raw
 * `--role <id>` value (null when absent) — cli.ts validates it
 * against the live config, since this parser has no config to read. `json` is list-only: the
 * machine-readable render of the same listing. */
type PromptArgs =
  | { mode: "enqueue"; role: string | null; text: string; atDelayMs: number | null; attachPaths: string[] }
  | { mode: "list"; role: string | null; json: boolean; grep: string | null }
  | { mode: "cancel"; role: string | null; position: number }
  | { mode: "edit"; role: string | null; position: number; text: string | null; attachPaths: string[] }
  | { mode: "top"; role: string | null; position: number };

/** The stdin prompt read once per process: cli.ts pre-parses prompt's args and cmdPrompt
 * re-parses them, and a second readFileSync(0) on a drained pipe would see an empty prompt. */
let stdinPrompt: string | null = null;

/** Read a `--file` value: `-` reads stdin (memoized in stdinPrompt, with the stdin read error
 * and emptiness check beside the read), any other path goes through readPromptFileChecked.
 * Shared by `prompt --file` and the `bug`/`plan` file forms. */
export function readPromptFileArg(file: string): string {
  if (file !== "-") return readPromptFileChecked(file);
  if (stdinPrompt === null) {
    try {
      stdinPrompt = fs.readFileSync(0, "utf8");
    } catch (err) {
      stdinPrompt = "";
      fail(`cannot read prompt file "-" (stdin): ${errorMessage(err)}`);
    }
  }
  failEmptyPromptFile(file, stdinPrompt);
  return stdinPrompt;
}

/** prompt's flag vocabulary, one definition shared by the unknown-flag loop and the
 * equals-form refusal inside it (ROLE_FLAG rides in with its shared missing-value wording). */
const PROMPT_FLAG_SPECS: readonly FlagSpec[] = [
  ROLE_FLAG,
  { names: ["--list"] },
  JSON_FLAG,
  { names: ["--cancel"], value: true, valueName: "<n>" },
  { names: ["--edit"], value: true, valueName: "<n>" },
  { names: ["--top"], value: true, valueName: "<n>" },
  { names: ["--file"], value: true, valueName: "<path>" },
  { names: ["--at"], value: true, valueName: "<duration>" },
  { names: ["--attach"], value: true, valueName: "<path>" },
  { names: ["--grep"], value: true, valueName: "<text>" },
];

/** The shared result of parsePromptFlags' scan: every index, claim and value the per-mode
 * branches below read, on one struct, so the scanner owns all cross-mode checks and the
 * branches only assemble each return shape. */
interface PromptFlags {
  role: string | null;
  jsonFlags: number[];
  listFlag: number;
  cancelFlag: number;
  editFlag: number;
  topFlag: number;
  fileFlag: number;
  grepRaw: string | undefined;
  grepClaim: number[];
  roleClaim: number[];
  attachPaths: string[];
  attachClaims: number[];
  atDelayMs: number | null;
  atClaim: number[];
}

/** The raw index bundle the prompt checks read, gathered once by scanPromptFlags so each
 * check helper reads indices without re-scanning args. */
interface PromptScan {
  jsonFlags: number[];
  listFlag: number;
  cancelFlag: number;
  editFlag: number;
  topFlag: number;
  fileFlag: number;
  atFlag: number;
  grepFlag: number;
  attachFlags: number[];
  roleFlag: number;
}

/** The six `--list`/`--cancel`/`--edit`/`--top` mode pairs that may not combine, in today's
 * exact order. */
const PROMPT_MODE_EXCLUSIONS: readonly (readonly [string, string])[] = [
  ["--list", "--cancel"],
  ["--list", "--edit"],
  ["--cancel", "--edit"],
  ["--list", "--top"],
  ["--cancel", "--top"],
  ["--edit", "--top"],
];

/** The flag-vocabulary gate and the once-check: the unknown-double-dash gate, the ten index
 * collections and rejectDuplicateFlags's once-check all ride here, one scan, one home. */
function scanPromptFlags(args: string[]): PromptScan {
  // The unknown-double-dash gate reads PROMPT_FLAG_SPECS, so the list its error names admits
  // exactly what the duplicate-flag check below accepts — one vocabulary, one message renderer.
  rejectUnknownDoubleDash("prompt", args, PROMPT_FLAG_SPECS);
  // --json's positions, collected in one pass: the list branch's stray-argument claim and
  // json flag need the indices (the once-check rides rejectDuplicateFlags below).
  const jsonFlags = args.flatMap((a, i) => (a === "--json" ? [i] : []));
  const listFlag = args.indexOf("--list");
  const cancelFlag = args.indexOf("--cancel");
  const editFlag = args.indexOf("--edit");
  const topFlag = args.indexOf("--top");
  const fileFlag = args.indexOf("--file");
  const atFlag = args.indexOf("--at");
  const grepFlag = args.indexOf("--grep");
  // --attach is repeatable: every occurrence claims itself and its value token, like --role's
  // single pair, so the pairs ride out of the prompt text in every mode.
  const attachFlags = args.flatMap((a, i) => (a === "--attach" ? [i] : []));
  const roleFlag = args.indexOf("--role");
  const known = PROMPT_FLAG_SPECS.flatMap((s) => s.names).filter((f) => f !== "--attach"); // repeatable: the once-check skips it
  rejectDuplicateFlags(args, known);
  return { jsonFlags, listFlag, cancelFlag, editFlag, topFlag, fileFlag, atFlag, grepFlag, attachFlags, roleFlag };
}

/** The six mode mutual exclusions: the mutually-exclusive `--list`/`--cancel`/`--edit`/
 * `--top` pairs, in the table's order, so the first failing pair reports as it did before. */
function assertPromptModesDisjoint(scan: PromptScan): void {
  const index: Readonly<Record<string, number>> = {
    "--list": scan.listFlag,
    "--cancel": scan.cancelFlag,
    "--edit": scan.editFlag,
    "--top": scan.topFlag,
  };
  for (const [a, b] of PROMPT_MODE_EXCLUSIONS) {
    // All four keys are always present in the object; ?? -1 just satisfies the strict
    // indexed-access typing without changing the (never-undefined) compare.
    if ((index[a] ?? -1) >= 0 && (index[b] ?? -1) >= 0) fail(`${a} and ${b} are mutually exclusive`);
  }
}

/** The `--role <id>` value pair: its raw value, its missing-value refusal and the pair it
 * claims, verbatim. */
function parsePromptRole(args: string[], roleFlag: number): { role: string | null; roleClaim: number[] } {
  const roleRaw = roleFlag >= 0 ? args[roleFlag + 1] : undefined;
  if (roleFlag >= 0 && (!roleRaw || roleRaw.startsWith("--"))) fail(ROLE_VALUE_ERROR);
  const role = roleRaw ?? null;
  // The flag and its value are never prompt content: --role is a scope, not text. Only claimed
  // when actually present — negative indexes would over-claim real tokens.
  const roleClaim = pairClaim(roleFlag);
  return { role, roleClaim };
}

/** The `--json` list-only refusal: in enqueue or cancel mode it must never silently ride
 * along as prompt text (or beside a state change). */
function assertPromptJsonListOnly(scan: PromptScan): void {
  // --json is list-only: in enqueue or cancel mode it must never silently ride along as
  // prompt text (or beside a state change), so it is refused before either branch runs.
  if (scan.jsonFlags.length > 0 && scan.listFlag < 0) fail("--json only applies to --list");
}

/** The `--grep <text>` value pair and its list-only refusal, verbatim. */
function parsePromptGrep(args: string[], scan: PromptScan): { grepRaw: string | undefined; grepClaim: number[] } {
  if (scan.grepFlag >= 0 && scan.listFlag < 0) fail("--grep only applies to --list");
  const grepRaw = scan.grepFlag >= 0 ? args[scan.grepFlag + 1] : undefined;
  if (scan.grepFlag >= 0 && (!grepRaw || grepRaw.startsWith("--"))) {
    fail("--grep needs text (usage: tumwater prompt --list --grep <text>)");
  }
  const grepClaim = pairClaim(scan.grepFlag);
  return { grepRaw, grepClaim };
}

/** The queue-only-mode refusals: --file and --at have nothing to mean except in the enqueue
 * mode, and --attach is refused by --list and --cancel (--edit accepts it). */
function assertPromptQueueOnlyFlags(scan: PromptScan): void {
  // The queue-only flags --file and --at have nothing to mean in the read-only and destructive
  // modes (--list and --cancel): --file is the file-shaped twin of free-form text (--edit
  // accepts it as its replacement text, so the editFlag test below exempts that one mode), and
  // a delivery deferral has nothing to mean to a listing or a cancel. --attach is queue/edit-only:
  // --list and --cancel refuse it by name, while --edit accepts it to append images to the
  // prompt it rewrites (the editFlag test below exempts that one mode). One home for the mode
  // predicate and the `<flag> only queues a prompt` wording, so a new mode or queue-only flag
  // is added here.
  const refuseQueueOnlyFlag = (flag: string, present: boolean): void => {
    if (present && (scan.listFlag >= 0 || scan.cancelFlag >= 0 || scan.editFlag >= 0 || scan.topFlag >= 0)) fail(`${flag} only queues a prompt`);
  };
  refuseQueueOnlyFlag("--file", scan.fileFlag >= 0 && scan.editFlag < 0);
  refuseQueueOnlyFlag("--at", scan.atFlag >= 0);
  refuseQueueOnlyFlag("--attach", scan.attachFlags.length > 0 && scan.editFlag < 0);
}

/** The `--attach <path>` value pair(s): every occurrence claims itself and its value token,
 * with the missing-value refusal, verbatim. */
function parsePromptAttachments(args: string[], attachFlags: number[]): { attachPaths: string[]; attachClaims: number[] } {
  // Each --attach pair claims the flag and its value; a trailing flag with no value names the
  // flag here, like --cancel's missing-value wording, before any queue write.
  const attachPaths = attachFlags.map((i) => args[i + 1] as string);
  const attachClaims = attachFlags.flatMap((i) => [i, i + 1]);
  for (const i of attachFlags) {
    if (args[i + 1] === undefined) fail(`--attach needs a path (e.g. \`--attach shot.png\`)`);
  }
  return { attachPaths, attachClaims };
}

/** The `--at <duration>` parse and its 90-day cap, verbatim. */
function parsePromptDeferral(args: string[], atFlag: number): { atDelayMs: number | null; atClaim: number[] } {
  // An edit keeps the target prompt's existing deferral exactly as it was (the marker is
  // plumbing the edit carries over), so a --at alongside it has nothing to mean.
  // The pair is claimed like --role's: the flag and its value are never prompt content.
  const atClaim = pairClaim(atFlag);
  let atDelayMs: number | null = null;
  if (atFlag >= 0) {
    atDelayMs = parseDurationFlag("--at", args[atFlag + 1]);
    // The same 90-day cap every other forward-dated window honors (pause --for, wake --in,
    // run --for): an unbounded deferral is never intended, and a value past Date's range
    // (about 106751991d from now) made notBeforeMarker's toISOString throw a raw RangeError.
    failOverDurationCap("--at", atDelayMs, PAUSE_FOR_MAX_MS);
  }
  return { atDelayMs, atClaim };
}

/** `tumwater prompt`'s flag scan and the checks it owns — everything shared by two or more
 * modes, so a new mode or queue-only flag is added here: the unknown-double-dash gate, the
 * index collection, the once-check, the six mutual exclusions, the --role pair, the
 * --json/--grep list-only refusals, the queue-only-flag refusals, the --attach pairs and the
 * --at parse and cap. Each job lives in one helper — scanPromptFlags, assertPromptModesDisjoint,
 * parsePromptRole, assertPromptJsonListOnly, parsePromptGrep, assertPromptQueueOnlyFlags,
 * parsePromptAttachments and parsePromptDeferral — so a check is found by name. Returns a
 * struct the mode branches read. */
function parsePromptFlags(args: string[]): PromptFlags {
  const scan = scanPromptFlags(args);
  assertPromptModesDisjoint(scan);
  const { role, roleClaim } = parsePromptRole(args, scan.roleFlag);
  assertPromptJsonListOnly(scan);
  const { grepRaw, grepClaim } = parsePromptGrep(args, scan);
  assertPromptQueueOnlyFlags(scan);
  const { attachPaths, attachClaims } = parsePromptAttachments(args, scan.attachFlags);
  const { atDelayMs, atClaim } = parsePromptDeferral(args, scan.atFlag);

  return {
    role,
    jsonFlags: scan.jsonFlags,
    listFlag: scan.listFlag,
    cancelFlag: scan.cancelFlag,
    editFlag: scan.editFlag,
    topFlag: scan.topFlag,
    fileFlag: scan.fileFlag,
    grepRaw,
    grepClaim,
    roleClaim,
    attachPaths,
    attachClaims,
    atDelayMs,
    atClaim,
  };
}

/** `--list`: the queue listing, optionally machine-readable and filtered by --grep. */
function listPromptArgs(args: string[], f: PromptFlags): PromptArgs {
  failStrayArg(args, "with --list there is no prompt text", f.listFlag, ...f.jsonFlags, ...f.roleClaim, ...f.grepClaim);
  return { mode: "list", role: f.role, json: f.jsonFlags.length > 0, grep: f.grepRaw ?? null };
}

/** The shared `--cancel <n>` / `--top <n>` mode: each takes exactly one 1-based position
 * and refuses any other token — these modes have no prompt text. Shared so the two cannot
 * drift; `mode` drives both the refusal wording and the returned mode. */
function positionOnlyPromptArgs<M extends "cancel" | "top">(
  args: string[],
  f: PromptFlags,
  mode: M,
  flag: string,
  flagIndex: number,
): PromptArgs {
  const n = parsePositionFlag(flag, args[flagIndex + 1], `${flag} 2`);
  // The position is the only token this mode may carry; anything else alongside it would be
  // prompt text, and this mode has none.
  failStrayArg(args, `with ${flag} there is no prompt text`, flagIndex, flagIndex + 1, ...f.roleClaim);
  return { mode, role: f.role, position: n };
}

/** `--cancel <n>`: remove one entry by its 1-based queue position. */
function cancelPromptArgs(args: string[], f: PromptFlags): PromptArgs {
  return positionOnlyPromptArgs(args, f, "cancel", "--cancel", f.cancelFlag);
}

/** `--edit <n>`: rewrite one entry's text in place — the replacement is the --file contents,
 * the tokens after the position, or (with neither) an editor open in the caller. */
function editPromptArgs(args: string[], f: PromptFlags): PromptArgs {
  const n = parsePositionFlag("--edit", args[f.editFlag + 1], '--edit 2 "new text"');
  // The --edit pair, the --role pair, and any --attach pairs are the only flags this mode
  // claims. Tokens preceding --edit (other than a claimed flag) would be silently dropped —
  // a mistyped command would edit prompt N with only the trailing fragment — so they are
  // refused here by the same stray-argument wording the sibling modes use; tokens after the
  // position are the replacement text, minus any claimed attach pair (none: edit in $EDITOR).
  const fileClaim = pairClaim(f.fileFlag);
  for (let i = 0; i < f.editFlag; i++) {
    if (f.roleClaim.includes(i) || f.attachClaims.includes(i) || fileClaim.includes(i)) continue;
    fail(`unexpected argument ${JSON.stringify(args[i])} — with --edit the replacement text comes after the position`);
  }
  if (f.fileFlag >= 0) {
    // The replacement comes from the file (`-` reads stdin), kept line for line; editPromptAtFile
    // trims it. Typed text beside it would be ambiguous, so it is refused.
    const file = promptFileValue(args[f.fileFlag + 1]);
    failStrayArg(args, "with --file the replacement text comes from the file", f.editFlag, f.editFlag + 1, ...fileClaim, ...f.roleClaim, ...f.attachClaims);
    return { mode: "edit", role: f.role, position: n, text: readPromptFileArg(file), attachPaths: f.attachPaths };
  }
  const textTokens: string[] = [];
  for (let i = f.editFlag + 2; i < args.length; i++) {
    if (f.roleClaim.includes(i) || f.attachClaims.includes(i)) continue;
    textTokens.push(args[i] as string);
  }
  const text = textTokens.join(" ").trim();
  // No text and no --file: the caller opens the prompt's current body in the editor.
  return { mode: "edit", role: f.role, position: n, text: text === "" ? null : text, attachPaths: f.attachPaths };
}

/** `--top <n>`: move one entry to the head of its role's queue. */
function topPromptArgs(args: string[], f: PromptFlags): PromptArgs {
  return positionOnlyPromptArgs(args, f, "top", "--top", f.topFlag);
}

/** `--file <path>`: enqueue the file's (or stdin's) whole contents as the prompt. */
function filePromptArgs(args: string[], f: PromptFlags): PromptArgs {
  // The file is the prompt: read it whole (a path of `-` reads stdin, so a pipe or heredoc
  // works), following parseInitArgs' --file branch — the same claim/stray/read/empty shape,
  // so the two commands speak one idiom. The stdin read is memoized at module level: cli.ts
  // pre-parses prompt's args and cmdPrompt re-parses them, and a second readFileSync(0) on a
  // drained pipe would see an empty prompt (readFileSync(0) fails with EAGAIN on a TTY's
  // stdin; errorMessage names it, and the operator passes a real pipe instead).
  const file = promptFileValue(args[f.fileFlag + 1]);
  failStrayArg(args, "with --file the prompt comes from the file", f.fileFlag, f.fileFlag + 1, ...f.roleClaim, ...f.atClaim, ...f.attachClaims);
  const contents = readPromptFileArg(file);
  return { mode: "enqueue", role: f.role, text: contents, atDelayMs: f.atDelayMs, attachPaths: f.attachPaths };
}

/** The default mode: free-form text (minus the claimed --role/--at/--attach tokens) is joined
 * and enqueued. */
function enqueuePromptArgs(args: string[], f: PromptFlags): PromptArgs {
  // Everything except the --role pair and the --at pair is prompt text; the join keeps
  // multi-word requests as one string exactly like the pre-1/2 behavior.
  const text = args
    .filter((_, i) => !f.roleClaim.includes(i) && !f.atClaim.includes(i) && !f.attachClaims.includes(i))
    .join(" ")
    .trim();
  // Name the fix, like the sibling operator commands' usage errors (bug/plan carry their
  // BUG_USAGE/PLAN_USAGE lines): "prompt text required" alone never said what to type.
  if (!text)
    fail('prompt text required — usage: tumwater prompt "<text>" (add --role <id> to aim it at one role)');
  return { mode: "enqueue", role: f.role, text, atDelayMs: f.atDelayMs, attachPaths: f.attachPaths };
}

/** `tumwater prompt` argument handling, following parseInitArgs' pattern. Like init's,
 * positionals are free-form prompt content — but a double-dash token must be a real flag
 * (`--role <id>`, `--list`, `--json`, `--grep <text>`, `--cancel <n>`, `--edit <n>`,
 * `--top <n>`, `--file <path>`, `--at <duration>`), or
 * it would be baked into the queued prompt (the same class of bug parseInitArgs fixed: today
 * `tumwater prompt --foo text` enqueues "--foo text"). Single-dash positionals remain prompt
 * content. `--list`, `--cancel`, `--edit` and `--top` are mutually exclusive and may
 * not combine with positional text; `--role` is accepted in every mode and is never
 * prompt content. `--at <duration>` (PLANS.md "tumwater prompt --at <duration>") only queues
 * a prompt: it defers delivery — parsed here with parseDurationFlag, riding the enqueue as
 * the queue file's not-before marker — so the read-only and destructive modes refuse it
 * rather than silently ignore it. */
export function parsePromptArgs(args: string[]): PromptArgs {
  const f = parsePromptFlags(args);
  if (f.listFlag >= 0) return listPromptArgs(args, f);
  if (f.cancelFlag >= 0) return cancelPromptArgs(args, f);
  if (f.editFlag >= 0) return editPromptArgs(args, f);
  if (f.topFlag >= 0) return topPromptArgs(args, f);
  if (f.fileFlag >= 0) return filePromptArgs(args, f);
  return enqueuePromptArgs(args, f);
}
