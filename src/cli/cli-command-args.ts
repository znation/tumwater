/** The free-form-prompt commands' bespoke argument parsers: `tumwater init` and
 * `tumwater prompt`, whose positionals are prompt TEXT rather than a token list. Every
 * shared helper in cli/cli-args.ts assumes flags claim their tokens and rejects whatever is
 * left over — exactly wrong here, where a misspelled flag must fail instead of being
 * silently baked into the prompt that every loop then ticks from. Both parsers therefore
 * hand-roll the same discipline (a double-dash token must be a known flag, given at most
 * once; single-dash tokens are content) and share failStrayArg, so they live together
 * apart from cli/cli-args.ts's generic machinery — which also keeps that module, minus these
 * two, free of I/O: --file's readFileSync is the one read in the CLI's arg layer. */

import fs from "node:fs";
import { parseBranchFlag, parseDurationFlag } from "./cli-args.js";
import {
  type FlagSpec,
  JSON_FLAG,
  ROLE_FLAG,
  ROLE_VALUE_ERROR,
  rejectUnknownDoubleDash,
} from "./cli-flag-specs.js";
import { fail } from "./cli-output.js";
import { templateIds, unknownTemplateError } from "../init/init-templates.js";
import { errorMessage, gotSuffix, parsePositiveInt } from "../text.js";

/** Peel a positional-first command's bare tokens off the argument list: every flag-shaped
 * token rides in rest for rejectUnknownArgs, every bare token is a positional. For commands
 * with no valued flags (tick: `--json` alone; bug/plan via fileAndAnnounce) the split is a
 * prefix test — a negative tick number (`tick bugfix -3`) arrives flag-shaped and fails the
 * unknown-arg gate, which is the right answer for a non-positive n anyway. Lives here with
 * the CLI's other argument helpers, shared by cli.ts's tick case and
 * backlog-write.ts's fileAndAnnounce. */
export function peelPositionals(args: string[]): {
  positionals: string[];
  rest: string[];
} {
  const positionals: string[] = [];
  const rest: string[] = [];
  for (const arg of args) (arg.startsWith("-") ? rest : positionals).push(arg);
  return { positionals, rest };
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
 * shared by the init and prompt parsers (two call sites — parseInitArgs' and parsePromptArgs'
 * --file branches), so the wording cannot drift between them. The flag token itself is
 * claimed by each parser's stray-argument accounting; this helper only owns the value. */
function promptFileValue(file: string | undefined): string {
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
 * "an initial prompt is required" (which never names the file) on a fresh one; the prompt
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

/** The free-form-prompt commands' bespoke argument parsers: `tumwater init` and
 * positionals are free-form prompt text, so that helper (which rejects ANY unconsumed token)
 * can't be used wholesale. The rules instead: a double-dash token must be a known flag from
 * INIT_FLAG_SPECS (`--file`, `--branch`, `--template`, `--adopt`, `--dry-run` or
 * `--list-templates`), each given at most once; with `--file` present nothing but the other
 * flags may accompany it; a `--branch <name>` pair and the valueless flags are never prompt
 * content; single-dash positionals are prompt content, not flags. Without these checks a
 * misspelled --file would be baked into the initial prompt — injected into every tick of every
 * loop until someone edits the project brief. */
/** The two parsers' shared "each flag at most once" rule: refuse a repeated flag with the
 * same "may only be given once" wording parseFlagSpecs' spec-driven check applies to the
 * spec-parsed commands. Two call sites: parseInitArgs (over every known flag) and
 * parsePromptArgs (over --list/--cancel/--role/--json). */
function rejectDuplicateFlags(args: readonly string[], flags: readonly string[]): void {
  for (const flag of flags)
    if (args.filter((a) => a === flag).length > 1) fail(`${flag} may only be given once`);
}

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
      fail("--list-templates takes no prompt — run `tumwater init --list-templates` alone");
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
    fail("--list-templates takes no prompt — run `tumwater init --list-templates` alone");
  }
  return { prompt, branch, template, listTemplates, adopt, dryRun };
}

/** The four modes of `tumwater prompt`: enqueue free-form text (the default), list the queue,
 * cancel one entry by its 1-based position, or edit one entry's text in place by that same
 * position. `role` is the raw `--role <id>` value (null when absent) — cli.ts validates it
 * against the live config, since this parser has no config to read. `json` is list-only: the
 * machine-readable render of the same listing. */
type PromptArgs =
  | { mode: "enqueue"; role: string | null; text: string; atDelayMs: number | null; attachPaths: string[] }
  | { mode: "list"; role: string | null; json: boolean }
  | { mode: "cancel"; role: string | null; position: number }
  | { mode: "edit"; role: string | null; position: number; text: string };

/** The stdin prompt read once per process: cli.ts pre-parses prompt's args and cmdPrompt
 * re-parses them, and a second readFileSync(0) on a drained pipe would see an empty prompt. */
let stdinPrompt: string | null = null;

/** prompt's flag vocabulary, one definition shared by the unknown-flag loop and the
 * equals-form refusal inside it (ROLE_FLAG rides in with its shared missing-value wording). */
const PROMPT_FLAG_SPECS: readonly FlagSpec[] = [
  ROLE_FLAG,
  { names: ["--list"] },
  JSON_FLAG,
  { names: ["--cancel"], value: true, valueName: "<n>" },
  { names: ["--edit"], value: true, valueName: "<n>" },
  { names: ["--file"], value: true, valueName: "<path>" },
  { names: ["--at"], value: true, valueName: "<duration>" },
  { names: ["--attach"], value: true, valueName: "<path>" },
];

/** `tumwater prompt` argument handling, following parseInitArgs' pattern. Like init's,
 * positionals are free-form prompt content — but a double-dash token must be a real flag
 * (`--role <id>`, `--list`, `--json`, `--cancel <n>`, `--file <path>`, `--at <duration>`), or
 * it would be baked into the queued prompt (the same class of bug parseInitArgs fixed: today
 * `tumwater prompt --foo text` enqueues "--foo text"). Single-dash positionals remain prompt
 * content. `--list` and `--cancel` are mutually exclusive and may not combine with positional
 * text; `--role` is accepted in every mode (PLANS.md "Per-role prompts 1/2") and is never
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

  // --file only queues a prompt: it is the file-shaped twin of free-form text, so the read-only
  // and destructive modes must refuse it rather than silently ignore it (an edit's replacement
  // text is typed, never read from a file).
  if (fileFlag >= 0 && (listFlag >= 0 || cancelFlag >= 0 || editFlag >= 0)) fail("--file only queues a prompt");

  // --at only queues a prompt, like --file: a delivery deferral has nothing to mean to a
  // listing or a cancel.
  if (atFlag >= 0 && (listFlag >= 0 || cancelFlag >= 0 || editFlag >= 0)) fail("--at only queues a prompt");
  // --attach only queues a prompt, like --at: an image attachment has nothing to mean to a
  // listing, a cancel, or an edit's replacement text.
  if (attachFlags.length > 0 && (listFlag >= 0 || cancelFlag >= 0 || editFlag >= 0))
    fail("--attach only queues a prompt");
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
  }

  if (listFlag >= 0) {
    failStrayArg(args, "with --list there is no prompt text", listFlag, ...jsonFlags, ...roleClaim);
    return { mode: "list", role, json: jsonFlags.length > 0 };
  }

  if (cancelFlag >= 0) {
    const raw = args[cancelFlag + 1];
    // A missing value is its own error, carrying an example like --role's message; a
    // flag-looking value falls through to parsePositiveInt and is named in the got-value
    // message like every other count/duration flag — a bare-text error that swallowed the
    // offending token left `tumwater prompt --cancel --role feature` guessing what arrived.
    if (raw === undefined) fail(`--cancel needs a position number (e.g. \`--cancel 2\`)`);
    const n = parsePositiveInt(raw);
    if (n === null) fail(`--cancel needs a positive integer${gotSuffix(raw)}`);
    // The position is the only token --cancel may carry; anything else alongside it would be
    // prompt text, and this mode has none.
    failStrayArg(args, "with --cancel there is no prompt text", cancelFlag, cancelFlag + 1, ...roleClaim);
    return { mode: "cancel", role, position: n };
  }

  if (editFlag >= 0) {
    const raw = args[editFlag + 1];
    // A missing value is its own error, carrying an example like --cancel's message; a
    // flag-looking value falls through to parsePositiveInt and is named in the got-value
    // message like every other count/duration flag.
    if (raw === undefined) fail(`--edit needs a position number (e.g. \`--edit 2 "new text"\`)`);
    const n = parsePositiveInt(raw);
    if (n === null) fail(`--edit needs a positive integer (got ${JSON.stringify(raw)})`);
    // The --edit pair and the --role pair are the only flags this mode claims. Tokens
    // preceding --edit (other than a claimed flag) would be silently dropped — a mistyped
    // command would edit prompt N with only the trailing fragment — so they are refused
    // here by the same stray-argument wording the sibling modes use; tokens after the
    // position are the replacement text.
    for (let i = 0; i < editFlag; i++) {
      if (roleClaim.includes(i)) continue;
      fail(`unexpected argument ${JSON.stringify(args[i])} — with --edit the replacement text comes after the position`);
    }
    const textTokens: string[] = [];
    for (let i = editFlag + 2; i < args.length; i++) {
      if (roleClaim.includes(i)) continue;
      textTokens.push(args[i] as string);
    }
    const text = textTokens.join(" ").trim();
    if (!text)
      fail('edit text required — usage: tumwater prompt --edit <n> "<new text>" (add --role <id> to aim it at one loop)');
    return { mode: "edit", role, position: n, text };
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
    let contents: string;
    if (file === "-") {
      if (stdinPrompt === null) {
        try {
          stdinPrompt = fs.readFileSync(0, "utf8");
        } catch (err) {
          stdinPrompt = "";
          fail(`cannot read prompt file "-" (stdin): ${errorMessage(err)}`);
        }
      }
      // Stdin skips readPromptFile, so its emptiness check stays beside the read.
      contents = stdinPrompt;
      failEmptyPromptFile(file, contents);
    } else {
      contents = readPromptFileChecked(file);
    }
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
    fail('prompt text required — usage: tumwater prompt "<text>" (add --role <id> to aim it at one loop)');
  return { mode: "enqueue", role, text, atDelayMs, attachPaths: attachPaths };
}
