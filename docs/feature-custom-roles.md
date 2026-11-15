# Feature: Custom roles

> Written before the 2026-10-16 plain-terms rename, so it uses older words such as loop, tick, landing and fleet; [docs/glossary.md](glossary.md) maps them to today's terms.

## Summary

Let operators define their own background loops — custom roles — in `tumwater.json`,
alongside the built-in roles.

- **Definition.** A custom role entry in config specifies exactly two keys, `name` and
  `task` (the schema rejects any other key on the entry):
  - `name` — unique identifier used everywhere roles are referenced (queues, reports,
    dashboards, `--role` flags)
  - `task` — the standing instruction (the loop's role-specific "find something to do, do
    one thing" prompt)
  - optional per-role settings — model, run interval, enabled — go in the usual `roles.<name>`
    section, exactly like a built-in (a custom role absent from `roles` stays enabled)
- **Behavior.** Custom roles behave exactly like built-ins: persistent worktree and
  branch, one focused change per tick, review gate, landing pipeline, pause/wake,
  prompt queueing, history/tick logs. The only difference is their prompt and settings.
- **Ordering guarantees.** Custom roles integrate with the existing fair scheduling
  so they neither starve built-ins nor get starved; they participate in budget caps,
  error-streak breakers, and quiet hours like any role.

## User experience

1. Operator adds to `tumwater.json`:
   ```json
   "customRoles": [
     {
       "name": "security",
       "task": "Audit recent changes for security issues. Fix one concrete issue per tick, or record findings in SECURITY-NOTES.md."
     }
   ],
   "roles": {
     "security": { "model": "openai/gpt-4o", "minRunIntervalSeconds": 2700 }
   }
   ```
   (The per-role settings ride on the usual `roles` section — `customRoles` itself carries only
   `name` and `task` — so `model` is a selector string and `minRunIntervalSeconds` is seconds,
   both exactly as a built-in role takes them.)
2. `tumwater run` spins up the loop with its own worktree/branch; `tumwater status`
   lists it like any role; `--role security` works in prompts, logs, history.
3. Removing the entry disables and archives the loop's branch safely (existing
   runner-state handling).

## Rationale

- The built-in role list encodes one opinion about what a healthy dev fleet does.
  Operators inevitably want specialists (security, performance, accessibility, a
  test-data gardener) — the harness's core value is the loop machinery, and custom
  roles let operators reuse that machinery for any concern without touching code.
- This is the highest-leverage extensibility point in the product: everything the
  fleet does is already role-shaped, so "add a role" buys near-total flexibility.

## Constraints and notes

- Role ids must be unique across built-in and custom roles (collision = config
  validation error, not silent override).
- Standing prompts for custom roles must include the same guardrails the built-in
  prompts get (no git state changes, no touching harness internals) — composed by
  the harness, not left to the operator to remember.
- Keep the config schema strict but simple: one way to define a role. Optional
  per-role overrides only where project-level defaults already exist.
- Zero runtime dependencies; custom roles are data-driven, no plugin code loading
  (no arbitrary JS execution from config).
