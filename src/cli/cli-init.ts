/** `tumwater init`'s implementation (src/init/init.ts does the work; this prints the report).
 * Split out of cli/cli-start.ts, whose name is for start alone: every command it dispatches
 * delegates to its own module (cli-config-commands.ts, cli-log-commands.ts, doctor.ts, …), and init
 * is no exception. cli.ts stays the pure dispatcher. */
import { say, sayJson } from "./cli-output.js";
import { parseInitArgs } from "./cli-command-args.js";
import { initProject } from "../init/init.js";
import { templateCatalog } from "../init/init-templates.js";

/** `tumwater init`: seed a project directory from the operator's brief (src/init/init.ts does the
 * work; this prints the report). --dry-run prints the would-be actions without writing
 * anything; an already-initialized repo is reported as a no-op, never an error. --json prints
 * one acknowledgement object instead of the prose (the dry run and the no-op re-run carry the
 * same shape, `dryRun` and `status` carrying the mode); `--list-templates --json` prints the
 * catalog as one object in place of the id/description lines. */
export async function cmdInit(root: string, args: string[]): Promise<void> {
  const { prompt, branch, template, listTemplates, adopt, dryRun, json } = parseInitArgs(args);
  if (listTemplates) {
    if (json) sayJson({ command: "init", status: "templates", templates: templateCatalog() });
    else printTemplateCatalog();
    return;
  }
  const result = await initProject(root, prompt, branch ?? undefined, {
    adopt,
    dryRun,
    template: template ?? undefined,
  });
  if (json) {
    sayJson(initJson(result));
    return;
  }
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

/** The `--json` acknowledgement object: `initProject`'s InitResult fields as one data document,
 * in place of the prose intro/dry-run/report lines. `status` is `initialized` when this run
 * created anything and `already_initialized` for the no-op re-run (the prose's "already
 * initialized; nothing to do" case); a dry run keeps `initialized` — its `dryRun` field carries
 * the would-do mode, and the created/leftAlone lists hold what would happen. `branch` is null
 * when no repo was seeded (an existing repo's checked-out branch is the team's business, not
 * init's). */
function initJson(result: Awaited<ReturnType<typeof initProject>>): Record<string, unknown> {
  return {
    command: "init",
    status: result.created.length === 0 ? "already_initialized" : "initialized",
    dryRun: result.dryRun,
    template: result.template,
    adopted: result.adopted,
    readmeExists: result.readmeExists,
    wasRepo: result.wasRepo,
    repoInitialized: result.repoInitialized,
    branch: result.branch ?? null,
    created: result.created,
    leftAlone: result.leftAlone,
    committed: result.committed,
    bootstrap: result.bootstrap,
  };
}

/** Print the `template:`/adopt intro lines shared by the dry-run and completed paths. */
function printInitIntro(result: Awaited<ReturnType<typeof initProject>>): void {
  if (result.template !== "blank") say(`template: ${result.template}`);
  if (result.adopted) {
    // The banner may name an artifact only if it exists: a README.md is the target when one
    // is present (its brief goes to TUMWATER.md, the file is left untouched); "an existing
    // repo" is the target only when the directory already was a repo WITHOUT a README —
    // naming a seeded repo "existing" would contradict the "initialized a new git repository"
    // line the report prints right after (BUGS.md 2026-10-31). --adopt on an empty directory
    // holds neither: it seeds the repo and there is no README to adopt, so the banner names
    // no existing artifact (BUGS.md 2026-11-02).
    const target = result.readmeExists
      ? "the existing README.md"
      : result.wasRepo
        ? "an existing repo"
        : "nothing existing";
    say(
      `${result.dryRun ? "would adopt" : "adopting"} ${target}: the project brief goes in TUMWATER.md and README.md is left untouched`,
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
