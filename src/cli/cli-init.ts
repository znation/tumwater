/** `tumwater init`'s implementation (src/init/init.ts does the work; this prints the report).
 * Split out of cli/cli-start.ts, whose name is for start alone: every command it dispatches
 * delegates to its own module (operator/operator-commands.ts, config-commands.ts, log-commands.ts,
 * doctor.ts, …), and init is no exception. cli.ts stays the pure dispatcher. */
import { say } from "./cli-output.js";
import { parseInitArgs } from "./cli-command-args.js";
import { initProject } from "../init/init.js";
import { templateCatalog } from "../init/init-templates.js";

/** `tumwater init`: seed a project directory from the operator's brief (src/init/init.ts does the
 * work; this prints the report). --dry-run prints the would-be actions without writing
 * anything; an already-initialized repo is reported as a no-op, never an error. */
export async function cmdInit(root: string, args: string[]): Promise<void> {
  const { prompt, branch, template, listTemplates, adopt, dryRun } = parseInitArgs(args);
  if (listTemplates) {
    for (const { id, description } of templateCatalog()) say(`${id} — ${description}`);
    return;
  }
  const result = await initProject(root, prompt, branch ?? undefined, {
    adopt,
    dryRun,
    template: template ?? undefined,
  });
  if (result.template !== "blank") say(`template: ${result.template}`);
  if (result.adopted) {
    say(
      `${result.dryRun ? "would adopt" : "adopting"} an existing repo: the project brief goes in TUMWATER.md and README.md is left untouched`,
    );
  }
  if (result.dryRun) {
    if (result.repoInitialized && result.branch) {
      say(`dry run — would initialize a new git repository on branch ${result.branch}`);
    }
    const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "nothing");
    say(`dry run — would create: ${list(result.created)}`);
    say(`would leave alone: ${list(result.leftAlone)}`);
    say("nothing written; re-run without --dry-run to apply");
    return;
  }
  if (result.created.length === 0) {
    say("already initialized; nothing to do");
    return;
  }
  if (result.repoInitialized && result.branch) {
    say(`initialized a new git repository on branch ${result.branch}`);
  }
  say(`created ${result.created.join(", ")}${result.committed ? " (committed)" : ""}`);
  if (result.bootstrap !== null) {
    say(
      `fresh project — maintenance roles wait until ${result.bootstrap} plans are done; remove "bootstrap" from tumwater.json to end that early`,
    );
  }
  say("next: `tumwater start` in one terminal, `tumwater tui` in another");
}
