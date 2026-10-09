/** The bundled project templates for `tumwater init --template`
 * (docs/feature-project-templates.md). Static string data, no file reads and no runtime
 * dependencies: a template is a brief preamble (the operator's own words stay appended after
 * it) plus a seeded PLANS.md backlog and a starter directory layout — never code scaffolds,
 * since the fleet's own first ticks write any code.
 * `blank` is the default and reproduces today's init output byte-identically. */

import { typoSuffix } from "../text/suggest.js";

interface InitTemplate {
  id: string;
  /** One-line description, shown by `--list-templates`. */
  description: string;
  /** Prepend to the operator's brief (empty for blank) — framing only: entry point, tests, docs
   * expectations. The operator's words remain the tail, so "latest instruction wins" reads
   * naturally. */
  briefPreamble: string;
  /** First plans rendered under the seeded PLANS.md's `## Planned` (empty for blank), following
   * the existing `## Planned` before `## Done` convention so the seeded file never trips the
   * gate's structure checks. */
  starterPlans: readonly string[];
  /** Empty directories created before the first tick (empty for blank) — no files, ever. */
  starterDirs: readonly string[];
}

const PYTHON_CLI_PREAMBLE = `This project is a Python command-line tool.
The entry point is a \`main()\` function guarded by \`if __name__ == "__main__":\` in a single
module at the project root; the CLI parses arguments with the standard library's argparse.
Every behavior change ships with tests runnable by \`python -m pytest\` (or unittest, once a
suite exists), and the fleet keeps a README documenting install and usage as the tool grows.
Prefer the standard library over third-party dependencies.`;

const NODE_CLI_PREAMBLE = `This project is a Node.js command-line tool.
The entry point is \`bin.js\` (or \`src/main.js\`) wired to a \`bin\` field in package.json;
argument parsing uses the standard library's util.parseArgs. Every behavior change ships with
tests runnable by \`npm test\`, and the fleet keeps a README documenting install and usage as
the tool grows. Prefer node built-ins over third-party dependencies.`;

const STATIC_SITE_PREAMBLE = `This project is a small static website: plain HTML, CSS, and
minimal vanilla JavaScript served as-is, with no build step. Pages live at the project root
(or in a \`site/\` directory once one is needed), the entry page is \`index.html\`, and every
change keeps the site renderable by opening the files directly. Keep pages accessible: semantic
markup, alt text, and keyboard-navigable controls.`;

const blank: InitTemplate = {
  id: "blank",
  description: "no preamble, no seeded backlog — the fleet self-plans from your brief",
  briefPreamble: "",
  starterPlans: [],
  starterDirs: [],
};

const pythonCli: InitTemplate = {
  id: "python-cli",
  description: "a Python CLI tool: argparse entry point, pytest suite, README",
  briefPreamble: PYTHON_CLI_PREAMBLE,
  starterPlans: [
    "Scaffold the CLI: a `main()` entry point guarded by `if __name__ == \"__main__\":` that parses arguments with argparse and exits 0",
    "Set up a pytest suite: a `tests/` directory with a first passing test and a documented run command in the README",
    "Package the tool: a `pyproject.toml` with metadata and a console-script entry point, installable with `pip install -e .`",
    "Write the README: install, usage, and a worked example that matches the CLI's real flags",
  ],
  starterDirs: ["src", "tests"],
};

const nodeCli: InitTemplate = {
  id: "node-cli",
  description: "a Node.js CLI tool: parseArgs entry point, npm test suite, README",
  briefPreamble: NODE_CLI_PREAMBLE,
  starterPlans: [
    "Scaffold the CLI: an entry-point module wired to a `bin` field in package.json that parses arguments with util.parseArgs and exits 0",
    "Set up the test suite: a first passing `npm test` (node:test) and the run command documented in the README",
    "Add a start/dev script set to package.json (`start`, `test`) and document them in the README",
    "Write the README: install, usage, and a worked example that matches the CLI's real flags",
  ],
  starterDirs: ["src", "test"],
};

const staticSite: InitTemplate = {
  id: "static-site",
  description: "a small static website: plain HTML/CSS/JS, an accessibility pass, a preview script",
  briefPreamble: STATIC_SITE_PREAMBLE,
  starterPlans: [
    "Create the entry page: a semantic `index.html` that renders standalone when opened directly",
    "Add a preview script: a dependency-free way to serve the site locally (e.g. `python -m http.server` documented in the README)",
    "Run an accessibility pass on the existing pages: semantic landmarks, alt text, labels, and keyboard navigation",
    "Write the README: what the site is, how to preview it locally, and how to add a page",
  ],
  starterDirs: ["site", "assets"],
};

/** The catalog, `blank` first — the order `--list-templates` prints. Exactly four templates. */
export const INIT_TEMPLATES: readonly InitTemplate[] = [blank, pythonCli, nodeCli, staticSite];

/** The template ids in catalog order. */
export function templateIds(): string[] {
  return INIT_TEMPLATES.map((t) => t.id);
}

/** One template by id, or null when no template carries it. */
export function getTemplate(id: string): InitTemplate | null {
  return INIT_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The error message for a typo'd or unknown `--template` id: the id, every valid template id,
 * catalog order, and — like the unknown-role and unknown-config-key errors — a did-you-mean
 * hint when the id is a near miss (text/suggest.ts's typoSuffix), so `--template pythn-cli`
 * names its fix instead of only the catalog. Exactly two call sites today: the CLI parser
 * (cli/cli-command-args.ts, which fails before initProject runs any side effect) and
 * initProject itself (which re-checks for its direct callers) — one renderer, so the two
 * refusals can never drift apart. */
export function unknownTemplateError(template: string): string {
  const ids = templateIds();
  return `unknown template ${JSON.stringify(template)} — valid templates: ${ids.join(", ")}${typoSuffix(template, ids)}`;
}

/** The catalog as id + description pairs, for `--list-templates`. */
export function templateCatalog(): { id: string; description: string }[] {
  return INIT_TEMPLATES.map((t) => ({ id: t.id, description: t.description }));
}
/** The seed-file templates `tumwater init` writes (PLANS.md, BUGS.md, QUESTIONS.md, PRINCIPLES.md):
 * static string data beside the rest of the catalog. A starter template's `starterPlans` render
 * into PLANS_TEMPLATE under `## Planned`; the other three files land byte-identically. */
export const PLANS_TEMPLATE = `# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done.

## Planned

_None yet._

## Done

_None yet._
`;

export const BUGS_TEMPLATE = `# Bugs

Known bugs, recorded by any loop and fixed by the bugfix loop.
Each bug: symptom, how to reproduce, suspected cause if known. Move fixed bugs to Fixed, with the
required \`**Validation gap:** <tag> — <one sentence>\` line recording what made the bug hard to
confirm (tag one of: none, no-repro, no-fake, real-run-needed, no-observability, slow-check,
unclear-invariant).

## Open

_None yet._

## Fixed

_None yet._
`;

export const QUESTIONS_TEMPLATE = `# Questions

Open questions loops have posted for a human decision — each with context, the options, and the
loop's recommendation. Answer by moving an entry to ## Answered with your decision (or tell the
director). Loops never block on their own questions; they check here at the start of each tick.

## Open

_None yet._

## Answered

_None yet._
`;

export const PRINCIPLES_TEMPLATE = `# Principles

Design principles this project holds — the codified answer to "what would a senior engineer on
this team always do." Every loop's prompt carries these; uphold them in everything you produce.
Only the director and steward roles may edit this file. Phrase new principles positively: state
what to do, not what to avoid. This list is a starting point: the director and steward own it
and will tune it to this project.

- Prefer the standard library over a new dependency.
- Keep each file focused on one responsibility, and small enough to read in one sitting.
- Every behavior change ships with a test.
- Small, complete, and correct beats big and half-done: one focused change per tick. Focused
  means one theme, not one site: a kind of fix applied everywhere it holds is one change, and
  the same fix landed one site per tick spends a review and a landing on each.
`;
