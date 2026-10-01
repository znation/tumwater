/** The free-form-prompt commands' bespoke argument parsers: `tumwater init` and
 * `tumwater prompt`, whose positionals are prompt TEXT rather than a token list. Every
 * shared helper in cli-args.ts assumes flags claim their tokens and rejects whatever is
 * left over — exactly wrong here, where a misspelled flag must fail instead of being
 * silently baked into the prompt that every loop then ticks from. Both parsers therefore
 * hand-roll the same discipline (a double-dash token must be a known flag, given at most
 * once; single-dash tokens are content) and share failStrayArg, so they live together
 * apart from cli-args.ts's generic machinery — which also keeps that module, minus these
 * two, free of I/O: --file's readFileSync is the one read in the CLI's arg layer. */

import fs from "node:fs";
import { type FlagSpec, ROLE_FLAG, ROLE_VALUE_ERROR, fail, parseBranchFlag, rejectEqualsForm } from "./cli-args.js";
import { errorMessage, parsePositiveInt } from "./text.js";

/** Fail when any token is not at one of the `claimed` positions — the shared "no extra tokens"
 * check for commands whose positionals are free-form prompt text (init, prompt): with their
 * flags present, every other token would be silently baked into the prompt. Names the first
 * stray token in the standard `unexpected argument <json> — <reason>` shape so the call sites'
 * messages cannot drift. */
function failStrayArg(args: string[], reason: string, ...claimed: number[]): void {
  const extra = args.find((_, i) => !claimed.includes(i));
  if (extra !== undefined) fail(`unexpected argument ${JSON.stringify(extra)} — ${reason}`);
}

/** init's flag vocabulary (plans/portability.md §7/7, correction 1): --file and --branch take
 * a value; --adopt and --dry-run are valueless and are never prompt content. One definition,
 * shared by the unknown-flag loop and the `--flag=value` refusal inside it. */
const INIT_FLAG_SPECS: readonly FlagSpec[] = [
  { names: ["--file"], value: true, valueName: "<path>" },
  { names: ["--branch"], value: true, valueName: "<name>" },
  { names: ["--adopt"] },
  { names: ["--dry-run"] },
];
/** init's valueless flags, derived from the vocabulary so the two lists cannot drift. */
const INIT_BOOLEAN_FLAGS: readonly string[] = INIT_FLAG_SPECS.filter((s) => !s.value).flatMap((s) => s.names);

/** `tumwater init` argument handling. Every other command runs rejectUnknownArgs, but init's
 * positionals are free-form prompt text, so that helper (which rejects ANY unconsumed token)
 * can't be used wholesale. The rules instead: a double-dash token must be `--file`,
 * `--branch`, `--adopt` or `--dry-run`, each given at most once; with `--file` present nothing
 * but the other flags may accompany it; a `--branch <name>` pair and the two booleans are never
 * prompt content; single-dash positionals are prompt content, not flags. Without these checks a
 * misspelled --file would be baked into the initial prompt — injected into every tick of every
 * loop until someone edits the project brief. */
export function parseInitArgs(args: string[]): {
  prompt: string;
  branch: string | null;
  adopt: boolean;
  dryRun: boolean;
} {
  const known = INIT_FLAG_SPECS.flatMap((s) => s.names);
  for (const arg of args) {
    // An equals-form token names a real flag; refuse it with its own message before the
    // generic unknown-argument error misreports `--branch=main` as a misspelling.
    rejectEqualsForm(arg, INIT_FLAG_SPECS);
    if (arg.startsWith("--") && !known.includes(arg)) {
      fail(
        `unknown argument: ${arg} (valid flags for tumwater init: --file <path>, --branch <name>, --adopt, --dry-run)`,
      );
    }
  }
  for (const flag of known) {
    if (args.filter((a) => a === flag).length > 1) fail(`${flag} may only be given once`);
  }
  const branch = parseBranchFlag(args);
  const adopt = args.includes("--adopt");
  const dryRun = args.includes("--dry-run");
  const fileFlag = args.indexOf("--file");
  if (fileFlag >= 0) {
    const file = args[fileFlag + 1];
    if (!file) fail("--file needs a path");
    const claimed = [fileFlag, fileFlag + 1];
    const branchFlag = args.indexOf("--branch");
    if (branchFlag >= 0) claimed.push(branchFlag, branchFlag + 1);
    for (const flag of INIT_BOOLEAN_FLAGS) {
      if (args.includes(flag)) claimed.push(args.indexOf(flag));
    }
    failStrayArg(args, "with --file the prompt comes from the file", ...claimed);
    let contents: string;
    try {
      contents = fs.readFileSync(file, "utf8");
    } catch (err) {
      // A raw ENOENT/EISDIR names the path but not its role; say this was the --file prompt.
      fail(`cannot read prompt file ${JSON.stringify(file)}: ${errorMessage(err)}`);
    }
    // An empty (or whitespace-only) file reads as an empty prompt, which the bare-init path
    // then treats as "re-seed from README.md" — the operator's --file argument silently
    // ignored on an initialized repo, and a generic "an initial prompt is required" (which
    // never names the file) on a fresh one. Name the file, like every other bad --file shape.
    if (contents.trim() === "")
      fail(`the prompt file ${JSON.stringify(file)} is empty — it carries no prompt text`);
    return { prompt: contents, branch, adopt, dryRun };
  }
  // Everything except the --branch pair and the booleans is prompt text; the join keeps
  // single-dash tokens as content, exactly as before — with no flag present this is the old
  // args.join(" ").
  const promptTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--branch") i++; // Skip the pair's value too.
    else if (!INIT_BOOLEAN_FLAGS.includes(arg)) promptTokens.push(arg);
  }
  return { prompt: promptTokens.join(" "), branch, adopt, dryRun };
}

/** The three modes of `tumwater prompt`: enqueue free-form text (the default), list the
 * queue, or cancel one entry by its 1-based position. `role` is the raw `--role <id>` value
 * (null when absent) — cli.ts validates it against the live config, since this parser has no
 * config to read. `json` is list-only: the machine-readable render of the same listing. */
type PromptArgs =
  | { mode: "enqueue"; role: string | null; text: string }
  | { mode: "list"; role: string | null; json: boolean }
  | { mode: "cancel"; role: string | null; position: number };

/** prompt's flag vocabulary, one definition shared by the unknown-flag loop and the
 * equals-form refusal inside it (ROLE_FLAG rides in with its shared missing-value wording). */
const PROMPT_FLAG_SPECS: readonly FlagSpec[] = [
  ROLE_FLAG,
  { names: ["--list"] },
  { names: ["--json"] },
  { names: ["--cancel"], value: true, valueName: "<n>" },
];

/** `tumwater prompt` argument handling, following parseInitArgs' pattern. Like init's,
 * positionals are free-form prompt content — but a double-dash token must be a real flag
 * (`--role <id>`, `--list`, `--cancel <n>`), or it would be baked into the queued prompt (the
 * same class of bug parseInitArgs fixed: today `tumwater prompt --foo text` enqueues
 * "--foo text"). Single-dash positionals remain prompt content. `--list` and `--cancel` are
 * mutually exclusive and may not combine with positional text; `--role` is accepted in every
 * mode (PLANS.md "Per-role prompts 1/2") and is never prompt content. */
export function parsePromptArgs(args: string[]): PromptArgs {
  for (const arg of args) {
    // Same equals-form refusal parseInitArgs applies: `--role=qa` names a real flag.
    rejectEqualsForm(arg, PROMPT_FLAG_SPECS);
    if (arg.startsWith("--") && arg !== "--list" && arg !== "--cancel" && arg !== "--role" && arg !== "--json") {
      fail(`unknown argument: ${arg} (valid flags for tumwater prompt: --role <id>, --list, --json, --cancel <n>)`);
    }
  }
  const listFlag = args.indexOf("--list");
  const cancelFlag = args.indexOf("--cancel");
  // --json's positions, collected in one pass: the once-check here rides the array's length,
  // and the list branch's stray-argument claim and json flag need the indices.
  const jsonFlags = args.flatMap((a, i) => (a === "--json" ? [i] : []));
  if (jsonFlags.length > 1) fail("--json may only be given once");
  if (args.filter((a) => a === "--list").length > 1) fail("--list may only be given once");
  if (args.filter((a) => a === "--cancel").length > 1) fail("--cancel may only be given once");
  if (listFlag >= 0 && cancelFlag >= 0) fail("--list and --cancel are mutually exclusive");

  const roleFlag = args.indexOf("--role");
  if (args.filter((a) => a === "--role").length > 1) fail("--role may only be given once");
  const roleRaw = roleFlag >= 0 ? args[roleFlag + 1] : undefined;
  if (roleFlag >= 0 && (!roleRaw || roleRaw.startsWith("--"))) fail(ROLE_VALUE_ERROR);
  const role = roleRaw ?? null;
  // The flag and its value are never prompt content: --role is a scope, not text. Only claimed
  // when actually present — negative indexes would over-claim real tokens.
  const roleClaim = roleFlag >= 0 ? [roleFlag, roleFlag + 1] : [];

  // --json is list-only: in enqueue or cancel mode it must never silently ride along as
  // prompt text (or beside a state change), so it is refused before either branch runs.
  if (jsonFlags.length > 0 && listFlag < 0) fail("--json only applies to --list");

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
    if (n === null) fail(`--cancel needs a positive integer (got ${JSON.stringify(raw)})`);
    // The position is the only token --cancel may carry; anything else alongside it would be
    // prompt text, and this mode has none.
    failStrayArg(args, "with --cancel there is no prompt text", cancelFlag, cancelFlag + 1, ...roleClaim);
    return { mode: "cancel", role, position: n };
  }

  // Everything except the --role pair is prompt text; the join keeps multi-word requests as
  // one string exactly like the pre-1/2 behavior.
  const text = args
    .filter((_, i) => !roleClaim.includes(i))
    .join(" ")
    .trim();
  if (!text) fail("prompt text required");
  return { mode: "enqueue", role, text };
}
