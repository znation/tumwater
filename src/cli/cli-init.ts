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
    printTemplateCatalog();
    return;
  }
  const result = await initProject(root, prompt, branch ?? undefined, {
    adopt,
    dryRun,
    template: template ?? undefined,
  });
  printInitIntro(result);
  if (result.dryRun) {
    printDryRun(result);
    return;
  }
  printInitReport(result);
}

/** Print the `tumwater init --list-templates` catalog: one line per template. */
function printTemplateCatalog(): void {
  for (const { id, description } of templateCatalog()) say(`${id} — ${description}`);
}

/** Print the `template:`/adopt intro lines shared by the dry-run and completed paths. */
function printInitIntro(result: Awaited<ReturnType<typeof initProject>>): void {
  if (result.template !== "blank") say(`template: ${result.template}`);
  if (result.adopted) {
    say(
      `${result.dryRun ? "would adopt" : "adopting"} an existing repo: the project brief goes in TUMWATER.md and README.md is left untouched`,
    );
  }
}

/** Print the dry-run preview: repo line, the would-create/would-leave-alone lists, and the
 * "nothing written" line. */
function printDryRun(result: Awaited<ReturnType<typeof initProject>>): void {
  if (result.repoInitialized && result.branch) {
    say(`dry run — would initialize a new git repository on branch ${result.branch}`);
  }
  const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "nothing");
  say(`dry run — would create: ${list(result.created)}`);
  say(`would leave alone: ${list(result.leftAlone)}`);
  say("nothing written; re-run without --dry-run to apply");
}

/** Format the created-files line, appending `(committed)` when the repo was seeded. */
function createdLine(result: Awaited<ReturnType<typeof initProject>>): string {
  return `created ${result.created.join(", ")}${result.committed ? " (committed)" : ""}`;
}

/** Print the completed-init report: the already-initialized no-op, the repo line, the
 * created-files line, the bootstrap note, and the "next:" line. */
function printInitReport(result: Awaited<ReturnType<typeof initProject>>): void {
  if (result.created.length === 0) {
    say("already initialized; nothing to do");
    return;
  }
  if (result.repoInitialized && result.branch) {
    say(`initialized a new git repository on branch ${result.branch}`);
  }
  say(createdLine(result));
  if (result.bootstrap !== null) {
    say(
      `fresh project — maintenance roles wait until ${result.bootstrap} plans are done; remove "bootstrap" from tumwater.json to end that early`,
    );
  }
  say("next: `tumwater start` in one terminal, `tumwater tui` in another");
}
