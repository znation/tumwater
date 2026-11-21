# Default models — move codex's strong tier to GPT-6.2 Sol; claude stays as it is

Planned 2026-11-20 · requested by user · audited against main `681e18378` · PLANS.md "Codex
default models". Amended the same day after a catalog check on Codex CLI 0.170.0 (findings 4, 9
and 10), and on 2026-11-21 after re-probing on a fresh login (finding 9).

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
4. **0.170.0 is the floor, not 0.171.0.**
   - The host had codex 0.163.0, which is also `CODEX_MIN_VERSION`
     (src/agent/codex/codex-backend.ts). It is a global npm package (`@openai/codex`, linked into
     /opt/homebrew/bin), not a Homebrew cask.
   - On 0.163.0, `codex debug models` lists no GPT-6.2 model. Neither does the newest
     `~/.codex/models_cache.json` (written 2026-10-29 by a 0.165.0 client).
   - Upgraded to 0.170.0 on 2026-11-20, `codex debug models` lists `gpt-6.2-sol` with visibility
     `list`: a 500k window (95% effective, so 475,000), reasoning levels low through max plus
     `ultra`, default `low`, text and image input. The description reads "Fast, go-to model for
     coding and everyday work". `gpt-6.2-astra` is listed beside it at 272k.
   - That listing printed while the catalog refresh was failing (finding 9), so it is the
     catalog bundled with 0.170.0.
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
9. **The live run is still unconfirmed: the probes ran on a free-plan login.**
   - 2026-11-20: a one-word `codex exec -m gpt-6.2-sol` on 0.170.0 failed with "The 'gpt-6.2-sol'
     model is not supported when using Codex with a ChatGPT account". The same probe on
     `gpt-6.1-sol` failed the same way, and the catalog refresh returned 401 `token_expired`.
   - 2026-11-21, after a fresh `codex login`: the 401 was gone, but both Sol models were still
     refused with the same message. Each run first warned "Model metadata for `<model>` not
     found".
   - The cause is the account. The new login's id token has `chatgpt_plan_type: free`, and its
     catalog identity differs from the 2026-10-29 cache's. The refreshed `models_cache.json` for
     that account lists only `gpt-6-luna`, `gpt-5.6-terra` and `gpt-5.6-luna`, plus hidden
     models. It has no Sol and no Astra, so today's default `gpt-6.1-sol` is unavailable on it
     too.
   - `gpt-6-luna` answered "OK" on the same login, so the login itself works.
   - Whether a Plus account can run GPT-6.2 Sol is untested. The codex backend was built and
     probed on a Plus login (plans/codex-backend.md).
   - `codex login status` reads only the local auth file. It printed "Logged in using ChatGPT"
     even with the expired token, and it does not show the plan.
10. **The company npm registry lags.** `~/.npmrc` points at npm.registries.huggingface.tech. On
    2026-11-20 it served `@openai/codex` up to 0.170.0, while npmjs.org already had 0.171.0
    (released that day). The floor must be a version the registry serves, which is one more
    reason for 0.170.0.

## Design

- `BACKEND_DEFAULT_MODELS.codex.strong` becomes `gpt-6.2-sol`. Update the comment above it: it
  should cite this plan and finding 5.
- `CODEX_MIN_VERSION` becomes `0.170.0`, the oldest CLI confirmed to list GPT-6.2 in its catalog
  (finding 4). It stays one floor for every codex model, not a floor per model the way claude
  has one.
  - Upgrading is a single `npm install -g @openai/codex@<version>`.
  - Doctor's `codex version` row already stands down when no seam routes to codex.
  - A floor per model would mean generalizing claude's floor helpers in
    src/doctor/doctor-claude-checks.ts, and pinning `gpt-6.1-sol` on an old CLI does not justify
    that.
- scripts/smoke-codex.mjs reads its floor from `CODEX_MIN_VERSION` (from dist) instead of the
  hard-coded `"0.163.0"`. It also takes `--tier <small|default|strong>` (default `default`) to
  pick the model through `routeModel`, so hand step H4 can smoke the new strong default.
- The fake codex (test/fakes/fake-codex.ts) reports `0.170.0` by default, so fakes stay at the
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
3. **Keep the plan with no live Sol check (2026-11-21).** The operator no longer has a Plus
   account; their only ChatGPT login is free-plan, and no Sol model runs on it (finding 9).
   Defaults serve every tumwater user, and `gpt-6.2-sol` is confirmed in Codex's own catalog, so
   the change goes ahead. The live Sol run waits for whoever next has a paid login (H5). On a free
   login, set an explicit codex model such as `gpt-6-luna` for the strong tier.

## Hand steps

- **H4: check the CLI after the part merges, on the operator's free login.** (H1–H3 are
  plans/codex-backend.md's.)
  1. `codex --version` reads 0.170.0 or newer. It was installed 2026-11-20 with
     `npm install -g @openai/codex@0.170.0`.
  2. Run `npm run build && npm run smoke:codex`. The default tier is `gpt-6-luna`, which runs on a
     free plan, and it must pass. A failure in a step that passed on 0.163.0 means a CLI change
     between 0.163.0 and 0.170.0 (flags, stream or rollout shape). File it as a bug, quoting the
     failing step.
  3. Run `tumwater doctor` on a config that routes a seam to codex. The `codex version` row reads
     ok. On a free login, the `codex models` row warns that `gpt-6.2-sol` is not in the catalog.
     That warning is expected, and it is the cue to set an explicit strong-tier model.
- **H5: run GPT-6.2 Sol live, when a paid ChatGPT login is available.** Nobody here has one
  (decision 3).
  1. Check that the login is paid: decode the id token in `$CODEX_HOME/auth.json` and read
     `chatgpt_plan_type`, or check that `codex debug models` lists `gpt-6.1-sol`.
  2. Run `npm run smoke:codex -- --tier strong`. It must pass.
  3. If Codex refuses `gpt-6.2-sol` as "not supported when using Codex with a ChatGPT account"
     while `gpt-6.1-sol` runs, revert the strong default to `gpt-6.1-sol`. The floor can stay at
     0.170.0.

## Parts

1. **Codex default models.** The design above: default, floor, smoke, fake, docs. One part.

## Risks

- **No paid plan has run it.** The id, window and levels are confirmed from the 0.170.0 catalog
  (finding 4), but no Sol run completed, because the only login here is free-plan (finding 9,
  decision 3). Codex is not in the team's live tumwater.json today (it runs pi). On a paid plan
  that cannot run 6.2 Sol yet, the strong tier would be refused. Doctor's `codex models` row and
  H5 are where that shows up.
- **CLI drift across seven releases.** The adapter's flags were verified live on 0.163.0 (H1).
  H4's smoke run (default tier) is the check for 0.170.0.
- **Subscription allowance.** GPT-6.2 Sol may use the 5-hour and weekly windows at a different
  rate than 6.1 Sol. The window readings already show it per run. Re-read them after a day if
  codex carries a tier (plans/codex-backend.md H3).

## Sources (2026-11-20)

- Codex changelog: <https://learn.chatgpt.com/docs/changelog> (0.171.0, 2026-11-20).
- OpenRouter listing: <https://openrouter.ai/openai/gpt-6.2-sol-20261117>.
- `codex debug models` on 0.163.0 and on 0.170.0, and `~/.codex/models_cache.json` (fetched
  2026-10-29).
- Live probes on 0.170.0, 2026-11-20 and 2026-11-21 (finding 9).
- The claude-api skill's model table (cached 2026-11-03) for the Claude lineup and prices.
