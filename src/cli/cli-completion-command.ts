import type { CompletionShell } from "./completion.js";
import {
  completionConfigKeys,
  completionModels,
  completionRoleIds,
  completionScript,
  configValueWords,
  SUPPORTED_SHELLS,
} from "./completion.js";
import { say, fail } from "./cli-output.js";
import { gotSuffix } from "../text/text.js";
import { typoSuffix } from "../text/suggest.js";

/** `tumwater completion`'s command body — the shell-completion script and its --roles/
 * --config-keys/--config-value/--models listing shapes. The completion data lives in
 * src/cli/completion.ts (the spec parser, the completionScript emitter and the read-only
 * listing helpers); this module answers a `completion` invocation, split out of cli.ts so the
 * dispatcher stays the pure shared sequence and this command body sits beside its data the
 * way every other command body does. Imported lazily by cli.ts like each command body. */

function printCompletionRoles(root: string): void {
  for (const id of completionRoleIds(root)) say(id);
}

function printCompletionConfigKeys(root: string): void {
  for (const key of completionConfigKeys(root)) say(key);
}

function printCompletionConfigValue(key: string): void {
  // The vocabulary `config set <key> <value>` completes for a discrete-valued key
  // (boolean/backend/model/thinking); free-form keys print nothing, so a `set` on one
  // completes nothing instead of offering a wrong vocabulary.
  for (const word of configValueWords(key)) say(word);
}

function printCompletionModels(root: string): void {
  for (const m of completionModels(root)) say(m);
}

const COMPLETION_LISTING_SHAPES: Record<string, "roles" | "config-keys" | "models"> = {
  "--roles": "roles",
  "--config-keys": "config-keys",
  "--models": "models",
};

function completionListShape(
  args: string[],
): "roles" | "config-keys" | "config-value" | "models" | null {
  if (args.length === 1 && args[0]! in COMPLETION_LISTING_SHAPES)
    return COMPLETION_LISTING_SHAPES[args[0]!]!;
  if (args.length === 2 && args[0] === "--config-value") return "config-value";
  return null;
}

function completionShell(args: string[]): CompletionShell {
  const shell = args[0];
  // A wrong word count names the count, not a bad shell. A single near-miss shell word gets
  // the same typoSuffix `logs --type`/`history --result` give, so `completion zs` reads
  // "did you mean `zsh`?" while a far-off value (`tcsh`) stays hint-free.
  if (args.length === 0) fail("completion needs a shell: bash, zsh, or fish");
  if (args.length > 1)
    fail(`completion takes one shell: bash, zsh, or fish (got ${args.length} words: ${args.join(" ")})`);
  if (!SUPPORTED_SHELLS.includes(shell as CompletionShell))
    fail(`completion takes one shell: bash, zsh, or fish${gotSuffix(shell)}${typoSuffix(shell ?? "", SUPPORTED_SHELLS)}`);
  return shell as CompletionShell;
}

/** Answer a `tumwater completion` invocation. Works outside a repo (no requireReadyRepo). */
export async function cmdCompletion(root: string, args: string[]): Promise<void> {
  const shape = completionListShape(args);
  if (shape === "roles") {
    printCompletionRoles(root);
    return;
  }
  if (shape === "config-keys") {
    printCompletionConfigKeys(root);
    return;
  }
  if (shape === "config-value") {
    printCompletionConfigValue(args[1]!);
    return;
  }
  if (shape === "models") {
    printCompletionModels(root);
    return;
  }
  say(completionScript(completionShell(args)));
}
