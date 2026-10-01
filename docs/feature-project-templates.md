# Feature: Project templates

## Summary

Give `tumwater init` a `--template` option offering curated project starting points
(beyond the freeform brief), each bundling a starter brief plus a small seeded
backlog so the fleet starts with signal instead of a blank page.

- **Templates shipped at launch (opinionated, small set):**
  - `blank` (default) — today's behavior: one freeform brief, fleet self-plans.
  - `python-cli` — brief pre-framed for a Python CLI tool (entry point, tests, docs
    expectations), seeded backlog: packaging, test suite scaffold, README.
  - `node-cli` — same shape for a Node.js CLI with a build step.
  - `static-site` — brief for a small static website; seeded backlog: pages,
    accessibility pass, deploy-free preview script.
- **What a template contains:** a brief preamble merged with the user's one-line
  idea (user's words stay visible and last, so "latest instruction wins" reads
  naturally), a starter `PLANS.md` with 3–5 concrete first plans, and a starter
  directory layout created before the first tick.
- **Flag semantics.** `tumwater init "brief" --template python-cli`. Omitting the
  flag gives `blank`. `tumwater init --list-templates` prints the catalog with
  one-line descriptions.

## User experience

1. New user runs `tumwater init "a markdown-to-html converter" --template python-cli`.
2. The project directory is created with `src/`, `tests/`, a seeded `PLANS.md`
   naming the first concrete plans (scaffold the CLI, parse inline styles, round-trip
   tests), and the brief records the template flavor.
3. First ticks land on real work immediately — no cold-start where every loop spends
   its opening ticks figuring out what the project even is.

## Rationale

- The coldest problem a fresh fleet has is a blank backlog: the planning loop must
  invent context from a one-line brief, which costs early ticks and produces generic
  plans. Templates front-load that context.
- A small opinionated set beats a template marketplace: five good defaults cover the
  majority of hobby-scale projects this harness targets, per the project's
  opinionated-defaults principle.

## Constraints and notes

- Templates are brief-plus-backlog seeds only — **not** code scaffolds with hidden
  logic. Any code created is created by the fleet's own first ticks (keeping the
  harness's "the loops build the project" identity intact).
- Templates are static data bundled with the package (zero runtime dependencies, no
  network fetch, no template registry service).
- Freeform briefs remain fully supported; `blank` is the default and always will be.
- Template content must respect the backlog file conventions the harness already
  enforces (`## Planned` before `## Done`, etc.) so seeded files never trip the
  gate's structure checks.
