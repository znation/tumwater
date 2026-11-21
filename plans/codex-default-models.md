# Default models — move codex's strong tier to GPT-6.2 Sol; claude stays as it is

Planned 2026-11-20 · requested by user · audited against main `681e18378` · PLANS.md "Codex
default models".

## Goal

With no `model` configured, each agent backend runs the newest released model for each tier.

- **codex:** strong moves from `gpt-6.1-sol` to `gpt-6.2-sol`. Default and small stay on
  `gpt-6-luna`.
- **claude:** no change. Haiku 5.5 (default, small) and Opus 5.5 (strong) are already the newest
  models in their lines.

## Findings (2026-11-20)

1. **Where the defaults live.** `BACKEND_DEFAULT_MODELS` in src/config/config-model-selector.ts is
   the only place they are set. Everything else derives from it through `routeModel`: claude's
   gated-model set (src/agent/claude/claude-backend.ts), the codex smoke check's model
   (scripts/smoke-codex.mjs) and the doctor rows. README.md and docs/backends.md repeat the ids
   in prose.
2. **Codex released GPT-6.2 on 2026-11-17.** It ships as two models, Sol and Astra, both available
   in Codex. The Codex changelog entry for **CLI 0.171.0 (2026-11-20)** "added GPT-6.2 Sol and
   Astra to model catalogs, with Sol as the default catalog selection". OpenRouter lists the API
   model as `gpt-6.2-sol-20261117`, positioned as the successor to GPT-6.1 Sol and one step below
   GPT-6.2 Astra.
3. **No newer Luna.** The changelog names no Luna model after `gpt-6-luna`. `codex debug models`
   on the installed 0.163.0 lists `gpt-6-luna` as the only current Luna. Default and small stay
   on it.
4. **The installed CLI is too old.** The host has codex 0.163.0 (Homebrew), which is also
   `CODEX_MIN_VERSION` (src/agent/codex/codex-backend.ts). Its catalog does not list any GPT-6.2
   model. The newest `~/.codex/models_cache.json` (written 2026-10-29 by a 0.165.0 client) does
   not list one either.
5. **The strong tier was turned down one step on purpose.** On 2026-10-28 the operator moved
   codex's strong tier from Astra to Sol (plans/codex-backend.md "Tier defaults"). So the
   successor is `gpt-6.2-sol`, not `gpt-6.2-astra`.
6. **A resume across the change is harmless.** A run suspended on `gpt-6.1-sol` and resumed with
   `-m gpt-6.2-sol` gets Codex's "recorded with model … but is resuming with …" `error` item
   (fixture `resume-without-model.jsonl`). The stream translator treats `error` items as
   non-fatal notices and warns once.
7. **Model windows and image input come from the catalog** (src/agent/codex/codex-catalog.ts), so
   GPT-6.2 Sol's window and modalities need no code. Doctor's `codex models` row warns when a
   codex model is missing from the team home's catalog. That row is how a wrong id would show.
8. **Claude.** The newest models in each line are Opus 5.5, Sonnet 5.5 (2026-09-28) and Haiku 5.5
   (2026-10-07). The only newer release is Claude Fable 5.2 (2026-11-09), a separate, more capable
   line at $8/$40 per MTok, against Opus 5.5's $4/$20.

## Design

- `BACKEND_DEFAULT_MODELS.codex.strong` becomes `gpt-6.2-sol`. Update the comment above it: it
  should cite this plan and finding 5.
- `CODEX_MIN_VERSION` becomes `0.171.0`, the first CLI whose catalog carries GPT-6.2 (finding 2).
  It stays one floor for every codex model, not a floor per model the way claude has one.
  - Upgrading is a single `brew upgrade codex`.
  - Doctor's `codex version` row already stands down when no seam routes to codex.
  - A floor per model would mean generalizing claude's floor helpers in
    src/doctor/doctor-claude-checks.ts, and pinning `gpt-6.1-sol` on an old CLI does not justify
    that.
- scripts/smoke-codex.mjs reads its floor from `CODEX_MIN_VERSION` (from dist) instead of the
  hard-coded `"0.163.0"`. It also takes `--tier <small|default|strong>` (default `default`) to
  pick the model through `routeModel`, so hand step H4 can smoke the new strong default.
- The fake codex (test/fakes/fake-codex.ts) reports `0.171.0` by default, so fakes stay at the
  floor.
- Docs:
  - README.md: the tier-defaults table, the strong-tier sentence and the mixing example;
  - docs/backends.md: the codex section and the `codex/<id>` sentence.
  - Write the new id wherever the old one names the strong default. Leave captures and fixtures
    alone: test/fixtures/codex-captures/ is a 0.163.0 capture and stays one.

## Decisions (2026-11-20, operator)

1. **Claude stays as it is.** Fable 5.2 was considered for the strong tier and declined. Opus 5.5
   stays the strong default and Haiku 5.5 the default and small. Revisit only when a new Opus or
   Haiku ships.
2. **Codex strong is `gpt-6.2-sol`.** This keeps the 2026-10-28 one-step-down choice (finding 5).

## Hand steps

- **H4: confirm GPT-6.2 Sol live, after the part merges.** (H1–H3 are plans/codex-backend.md's.)
  1. Run `brew upgrade codex` and check that `codex --version` is 0.171.0 or newer.
  2. Run `CODEX_HOME=<team home> codex debug models`. Check that `gpt-6.2-sol` is listed with
     visibility `list`, and note its context window and reasoning levels. If the id is spelled
     differently, file a bug quoting the catalog entry.
  3. Run `npm run build && npm run smoke:codex -- --tier strong`, then `npm run smoke:codex`. Both
     must pass. A failure in a step that passed on 0.163.0 means a CLI change between 0.163.0 and
     0.171.0 (flags, stream or rollout shape). File it as a bug, quoting the failing step.
  4. Run `tumwater doctor`. The `codex version` and `codex models` rows should read ok on a config
     that routes a seam to codex.

## Parts

1. **Codex default models.** The design above: default, floor, smoke, fake, docs. One part.

## Risks

- **The id is unverified until H4.** It is inferred from the catalog's naming scheme and
  OpenRouter's listing (finding 2). Codex is not in the team's live tumwater.json today (it runs
  pi), so a wrong id surfaces in doctor and H4 before any team run uses it.
- **CLI drift across eight releases.** The adapter's flags were verified live on 0.163.0 (H1).
  H4's smoke runs are the check for 0.171.0.
- **Subscription allowance.** GPT-6.2 Sol may use the 5-hour and weekly windows at a different
  rate than 6.1 Sol. The window readings already show it per run. Re-read them after a day if
  codex carries a tier (plans/codex-backend.md H3).

## Sources (2026-11-20)

- Codex changelog: <https://learn.chatgpt.com/docs/changelog> (0.171.0, 2026-11-20).
- OpenRouter listing: <https://openrouter.ai/openai/gpt-6.2-sol-20261117>.
- `codex debug models` on the installed 0.163.0, and `~/.codex/models_cache.json` (fetched
  2026-10-29).
- The claude-api skill's model table (cached 2026-11-03) for the Claude lineup and prices.
