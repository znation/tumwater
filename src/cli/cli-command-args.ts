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
const HISTORY_LISTING_VALUED_FLAGS = ["-n", "--since", "--grep", "--result", "--role", "--model", "--by"];

/** True when `history`'s args are the one-run trail form (`history <role> <n>`, `history
 * <role> --last`): a token that is neither a flag nor the value of a listing-form valued flag.
 * A valued flag's value is skipped by position, so `--grep -x` stays a listing. */
export function historyTrailForm(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (HISTORY_LISTING_VALUED_FLAGS.includes(arg)) i++;
    else if (!arg.startsWith("-")) return true;
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

/** `tumwater init` argument handling. Init's positionals are free-form prompt text, so
 * rejectUnknownArgs (which rejects ANY unconsumed token) can't be used wholesale. The rules
 * instead: a double-dash token must be a known flag from INIT_FLAG_SPECS (`--file`,
 * `--branch`, `--template`, `--adopt`, `--dry-run` or `--list-templates`), each given at most
 * once; with `--file` present nothing but the other flags may accompany it; a `--branch
 * <name>` pair and the valueless flags are never prompt content; single-dash positionals are
 * prompt content, not flags. Without these checks a misspelled --file would be baked into the
 * brief text — injected into every run of every role until someone edits the project
 * brief. */
export function parseInitArgs(args: string[]): {
  prompt: string;
  branch: string | null;
  template: string | null;
  listTemplates: boolean;
  adopt: boolean;
  dryRun: boolean;
} {
  const known = INIT_FLAG_SPECS.flatMap((s) => s.names);
  // The unknown-double-dash gate reads the specs, so the list its error names admits exactly
  // what the duplicate-flag check below accepts — one vocabulary, one message renderer.
  rejectUnknownDoubleDash("init", args, INIT_FLAG_SPECS);
  rejectDuplicateFlags(args, known);
  const branch = parseBranchFlag(args);
  const adopt = args.includes("--adopt");
  const dryRun = args.includes("--dry-run");
  const listTemplates = args.includes("--list-templates");
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
  const fileFlag = args.indexOf("--file");
  if (fileFlag >= 0) {
    const file = promptFileValue(args[fileFlag + 1]);
    const claimed = [fileFlag, fileFlag + 1];
    const branchFlag = args.indexOf("--branch");
    if (branchFlag >= 0) claimed.push(branchFlag, branchFlag + 1);
    if (templateFlag >= 0) claimed.push(templateFlag, templateFlag + 1);
    for (const flag of INIT_BOOLEAN_FLAGS) {
      if (args.includes(flag)) claimed.push(args.indexOf(flag));
    }
    failStrayArg(args, "with --file the prompt comes from the file", ...claimed);
    const contents = readPromptFileChecked(file);
    if (listTemplates) {
      fail(LIST_TEMPLATES_PROMPT_ERROR);
    }
    return { prompt: contents, branch, template, listTemplates, adopt, dryRun };
  }
  // Everything except the --branch/--template pairs and the booleans is prompt text; the join
  // keeps single-dash tokens as content, exactly as before — with no flag present this is the
  // old args.join(" ").
  const promptTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--branch" || arg === "--template") i++; // Skip the pair's value too.
    else if (!INIT_BOOLEAN_FLAGS.includes(arg)) promptTokens.push(arg);
  }
  const prompt = promptTokens.join(" ");
  if (listTemplates && prompt.trim() !== "") {
    fail(LIST_TEMPLATES_PROMPT_ERROR);
  }
  return { prompt, branch, template, listTemplates, adopt, dryRun };
}

/** The four modes of `tumwater prompt`: enqueue free-form text (the default), list the queue,
 * cancel one entry by its 1-based position, edit one entry's text in place by that same
 * position, or move one entry to the head of its role's queue (`--top <n>`). `role` is the raw
 * `--role <id>` value (null when absent) — cli.ts validates it
 * against the live config, since this parser has no config to read. `json` is list-only: the
 * machine-readable render of the same listing. */
type PromptArgs =
  | { mode: "enqueue"; role: string | null; text: string; atDelayMs: number | null; attachPaths: string[] }
  | { mode: "list"; role: string | null; json: boolean }
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
];

/** `tumwater prompt` argument handling, following parseInitArgs' pattern. Like init's,
 * positionals are free-form prompt content — but a double-dash token must be a real flag
 * (`--role <id>`, `--list`, `--json`, `--cancel <n>`, `--edit <n>`, `--top <n>`, `--file <path>`,
 * `--at <duration>`), or
 * it would be baked into the queued prompt (the same class of bug parseInitArgs fixed: today
 * `tumwater prompt --foo text` enqueues "--foo text"). Single-dash positionals remain prompt
 * content. `--list`, `--cancel`, `--edit` and `--top` are mutually exclusive and may
 * not combine with positional text; `--role` is accepted in every mode and is never
 * prompt content. `--at <duration>` (PLANS.md "tumwater prompt --at <duration>") only queues
 * a prompt: it defers delivery — parsed here with parseDurationFlag, riding the enqueue as
 * the queue file's not-before marker — so the read-only and destructive modes refuse it
 * rather than silently ignore it. */
export function parsePromptArgs(args: string[]): PromptArgs {
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
  // --attach is repeatable: every occurrence claims itself and its value token, like --role's
  // single pair, so the pairs ride out of the prompt text in every mode.
  const attachFlags = args.flatMap((a, i) => (a === "--attach" ? [i] : []));
  const known = PROMPT_FLAG_SPECS.flatMap((s) => s.names).filter((f) => f !== "--attach"); // repeatable: the once-check skips it
  rejectDuplicateFlags(args, known);
  if (listFlag >= 0 && cancelFlag >= 0) fail("--list and --cancel are mutually exclusive");
  if (listFlag >= 0 && editFlag >= 0) fail("--list and --edit are mutually exclusive");
  if (cancelFlag >= 0 && editFlag >= 0) fail("--cancel and --edit are mutually exclusive");
  if (listFlag >= 0 && topFlag >= 0) fail("--list and --top are mutually exclusive");
  if (cancelFlag >= 0 && topFlag >= 0) fail("--cancel and --top are mutually exclusive");
  if (editFlag >= 0 && topFlag >= 0) fail("--edit and --top are mutually exclusive");

  const roleFlag = args.indexOf("--role");
  const roleRaw = roleFlag >= 0 ? args[roleFlag + 1] : undefined;
  if (roleFlag >= 0 && (!roleRaw || roleRaw.startsWith("--"))) fail(ROLE_VALUE_ERROR);
  const role = roleRaw ?? null;
  // The flag and its value are never prompt content: --role is a scope, not text. Only claimed
  // when actually present — negative indexes would over-claim real tokens.
  const roleClaim = roleFlag >= 0 ? [roleFlag, roleFlag + 1] : [];

  // --json is list-only: in enqueue or cancel mode it must never silently ride along as
  // prompt text (or beside a state change), so it is refused before either branch runs.
  if (jsonFlags.length > 0 && listFlag < 0) fail("--json only applies to --list");

  // The queue-only flags --file and --at have nothing to mean in the read-only and destructive
  // modes (--list and --cancel): --file is the file-shaped twin of free-form text (--edit
  // accepts it as its replacement text, so the editFlag test below exempts that one mode), and
  // a delivery deferral has nothing to mean to a listing or a cancel. --attach is queue/edit-only:
  // --list and --cancel refuse it by name, while --edit accepts it to append images to the
  // prompt it rewrites (the editFlag test below exempts that one mode). One home for the mode
  // predicate and the `<flag> only queues a prompt` wording, so a new mode or queue-only flag
  // is added here.
  const refuseQueueOnlyFlag = (flag: string, present: boolean): void => {
    if (present && (listFlag >= 0 || cancelFlag >= 0 || editFlag >= 0 || topFlag >= 0)) fail(`${flag} only queues a prompt`);
  };
  refuseQueueOnlyFlag("--file", fileFlag >= 0 && editFlag < 0);
  refuseQueueOnlyFlag("--at", atFlag >= 0);
  refuseQueueOnlyFlag("--attach", attachFlags.length > 0 && editFlag < 0);
  // An edit keeps the target prompt's existing deferral exactly as it was (the marker is
  // plumbing the edit carries over), so a --at alongside it has nothing to mean.
  // The pair is claimed like --role's: the flag and its value are never prompt content.
  const atClaim = atFlag >= 0 ? [atFlag, atFlag + 1] : [];
  // Each --attach pair claims the flag and its value; a trailing flag with no value names the
  // flag here, like --cancel's missing-value wording, before any queue write.
  const attachPaths = attachFlags.map((i) => args[i + 1] as string);
  const attachClaims = attachFlags.flatMap((i) => [i, i + 1]);
  for (const i of attachFlags) {
    if (args[i + 1] === undefined) fail(`--attach needs a path (e.g. \`--attach shot.png\`)`);
  }
  let atDelayMs: number | null = null;
  if (atFlag >= 0) {
    atDelayMs = parseDurationFlag("--at", args[atFlag + 1]);
    // The same 90-day cap every other forward-dated window honors (pause --for, wake --in,
    // run --for): an unbounded deferral is never intended, and a value past Date's range
    // (about 106751991d from now) made notBeforeMarker's toISOString throw a raw RangeError.
    failOverDurationCap("--at", atDelayMs, PAUSE_FOR_MAX_MS);
  }

  if (listFlag >= 0) {
    failStrayArg(args, "with --list there is no prompt text", listFlag, ...jsonFlags, ...roleClaim);
    return { mode: "list", role, json: jsonFlags.length > 0 };
  }

  if (cancelFlag >= 0) {
    const n = parsePositionFlag("--cancel", args[cancelFlag + 1], "--cancel 2");
    // The position is the only token --cancel may carry; anything else alongside it would be
    // prompt text, and this mode has none.
    failStrayArg(args, "with --cancel there is no prompt text", cancelFlag, cancelFlag + 1, ...roleClaim);
    return { mode: "cancel", role, position: n };
  }

  if (editFlag >= 0) {
    const n = parsePositionFlag("--edit", args[editFlag + 1], '--edit 2 "new text"');
    // The --edit pair, the --role pair, and any --attach pairs are the only flags this mode
    // claims. Tokens preceding --edit (other than a claimed flag) would be silently dropped —
    // a mistyped command would edit prompt N with only the trailing fragment — so they are
    // refused here by the same stray-argument wording the sibling modes use; tokens after the
    // position are the replacement text, minus any claimed attach pair (none: edit in $EDITOR).
    const fileClaim = fileFlag >= 0 ? [fileFlag, fileFlag + 1] : [];
    for (let i = 0; i < editFlag; i++) {
      if (roleClaim.includes(i) || attachClaims.includes(i) || fileClaim.includes(i)) continue;
      fail(`unexpected argument ${JSON.stringify(args[i])} — with --edit the replacement text comes after the position`);
    }
    if (fileFlag >= 0) {
      // The replacement comes from the file (`-` reads stdin), kept line for line; editPromptAtFile
      // trims it. Typed text beside it would be ambiguous, so it is refused.
      const file = promptFileValue(args[fileFlag + 1]);
      failStrayArg(args, "with --file the replacement text comes from the file", editFlag, editFlag + 1, ...fileClaim, ...roleClaim, ...attachClaims);
      return { mode: "edit", role, position: n, text: readPromptFileArg(file), attachPaths };
    }
    const textTokens: string[] = [];
    for (let i = editFlag + 2; i < args.length; i++) {
      if (roleClaim.includes(i) || attachClaims.includes(i)) continue;
      textTokens.push(args[i] as string);
    }
    const text = textTokens.join(" ").trim();
    // No text and no --file: the caller opens the prompt's current body in the editor.
    return { mode: "edit", role, position: n, text: text === "" ? null : text, attachPaths };
  }

  if (topFlag >= 0) {
    const n = parsePositionFlag("--top", args[topFlag + 1], "--top 2");
    // The position is the only token --top may carry; anything else alongside it would be
    // prompt text, and this mode has none.
    failStrayArg(args, "with --top there is no prompt text", topFlag, topFlag + 1, ...roleClaim);
    return { mode: "top", role, position: n };
  }

  if (fileFlag >= 0) {
    // The file is the prompt: read it whole (a path of `-` reads stdin, so a pipe or heredoc
    // works), following parseInitArgs' --file branch — the same claim/stray/read/empty shape,
    // so the two commands speak one idiom. The stdin read is memoized at module level: cli.ts
    // pre-parses prompt's args and cmdPrompt re-parses them, and a second readFileSync(0) on a
    // drained pipe would see an empty prompt (readFileSync(0) fails with EAGAIN on a TTY's
    // stdin; errorMessage names it, and the operator passes a real pipe instead).
    const file = promptFileValue(args[fileFlag + 1]);
    failStrayArg(args, "with --file the prompt comes from the file", fileFlag, fileFlag + 1, ...roleClaim, ...atClaim, ...attachClaims);
    const contents = readPromptFileArg(file);
    return { mode: "enqueue", role, text: contents, atDelayMs, attachPaths: attachPaths };
  }

  // Everything except the --role pair and the --at pair is prompt text; the join keeps
  // multi-word requests as one string exactly like the pre-1/2 behavior.
  const text = args
    .filter((_, i) => !roleClaim.includes(i) && !atClaim.includes(i) && !attachClaims.includes(i))
    .join(" ")
    .trim();
  // Name the fix, like the sibling operator commands' usage errors (bug/plan carry their
  // BUG_USAGE/PLAN_USAGE lines): "prompt text required" alone never said what to type.
  if (!text)
    fail('prompt text required — usage: tumwater prompt "<text>" (add --role <id> to aim it at one role)');
  return { mode: "enqueue", role, text, atDelayMs, attachPaths: attachPaths };
}
