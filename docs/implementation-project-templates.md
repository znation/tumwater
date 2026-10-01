# Implementation plan: Project templates

## Summary

Add a bundled, data-only template catalog and wire `--template` into
`tumwater init`. Templates merge a brief preamble with the user's brief and seed
`PLANS.md` (and optionally a minimal directory layout) before the fleet's first tick.

## Work breakdown

### Stage 1 — Template data + catalog

1. New `templates/` data directory in the package: one JSON/Markdown file per
   template holding `{ id, description, briefPreamble, seedPlans[], layout[] }`.
   - `briefPreamble`: 2–4 sentences framing stack and expectations; rendered into
     README **above** the user's verbatim brief (user's words stay last).
   - `seedPlans[]`: 3–5 plan entries written to `PLANS.md` under `## Planned`
     (correct heading order so backlog structure checks pass from tick one).
   - `layout[]`: optional empty directories/placeholder files to create.
2. `--list-templates` prints id + one-line description from this catalog.
3. `init` gains `--template <id>`; unknown id = clear error listing available ids.
   Default `blank` = current behavior exactly (no preamble, no seeds).

### Stage 2 — init integration

1. On init with a template: write seeded `PLANS.md`, create `layout[]` files/dirs,
   and record `template: <id>` in the harness's project metadata so reports/README
   can reference the project's flavor.
2. Order of operations: create layout → seed backlog → write README with merged
   brief → run the existing post-init first-tick path unchanged.
3. Idempotence/safety: refuse to run template seeding into a directory that already
   looks like an initialized tumwater project (same guard `init` already uses).

### Stage 3 — Polish

1. README docs: template list with examples; note that freeform remains the default.
2. Ensure `tumwater doctor` doesn't flag seeded backlogs (conformance test against
   the backlog structure rules).

## Files touched (expected shape)

- New template data files + a small loader/validator module
- `init` command path (flag parsing, seeding step)
- README/docs
- Tests: catalog validation (every template parses, ids unique, seed plans
  well-formed), init with each template produces expected files, `blank`
  byte-identical behavior to pre-feature init, seeded PLANS.md passes the existing
  backlog-structure validation

## Test plan

- Unit: loader validation matrix (bad JSON, missing fields, duplicate ids).
- Integration-style: `init --template python-cli` into a temp dir with the fake
  harness path — assert layout exists, PLANS.md seeded under `## Planned`, README
  contains preamble above the verbatim user brief.
- Regression: `init` without flag behaves identically to today (snapshot or
  equivalence checks).

## Risks and mitigations

- **Template rot** (seeded plans drift from harness conventions) → conformance test
  runs every template's seed file through the real backlog-structure validator.
- **Scope creep toward code scaffolds** → templates are data-only by review rule;
  `layout[]` may not contain code, only empty dirs/placeholder docs.
- **Users expect more templates** → keep the catalog small and curated; document
  that freeform + the planning loop is the general solution.

## Sequencing

Stage 1 alone ships the catalog + flag with full init behavior; Stage 2 is
lifecycle safety; Stage 3 is docs and conformance. Ship value after Stage 1.
