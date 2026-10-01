# Implementation plan: Custom roles

## Summary

Make the role registry data-driven: built-in roles become a default layer, custom
roles from `tumwater.json` merge in, and every subsystem that enumerates roles reads
the merged registry instead of a hardcoded list.

## Work breakdown

### Stage 1 — Registry merge (foundation)

1. Introduce/extend a role-registry module: `allRoles(config)` returns built-ins
   plus validated custom roles. Each role record is uniform: id, standing prompt
   fragments, model/interval overrides, enabled flag, origin (`builtin`/`custom`).
2. Config schema + validation:
   - `customLoops` array; each item requires unique `id` (case-insensitive check
     against built-ins and other custom entries) and non-empty `prompt`.
   - Optional `model`, `intervalMinutes` validated against existing ranges.
   - Unknown fields rejected (existing strictness pattern).
3. Replace direct references to the hardcoded role list in scheduling, worktree
   setup, and status surfaces with registry reads. Built-in prompts continue to be
   composed by the harness (guardrails appended the same way for custom prompts).

### Stage 2 — Lifecycle

1. On `run` start: reconcile custom roles against persisted loop state — create
   missing worktrees/branches, mark removed custom roles as archived (keep branch,
   stop scheduling).
2. Live config reload: adding/removing a custom role while the fleet runs follows
   the existing live-edit path (add → spawn at next scheduler pass; remove → stop
   scheduling, leave state on disk).
3. Custom roles participate automatically in existing subsystems because they are
   now first-class registry entries: fair scheduling, budget caps (fleet and
   per-role), error-streak breaker, quiet hours, prompt queueing, review gate.

### Stage 3 — Surfaces & docs

1. All `--role` flag validators accept custom ids (accept-list from the registry).
2. Dashboards and reports render custom roles with a small "custom" badge.
3. README settings section: documented example, guardrail note (harness-injected
   git restrictions), id collision rule.

## Files touched (expected shape)

- Roles module (registry + validation), config schema/validation
- Scheduling/worktree/status call sites that enumerate roles
- Live-reload path
- CLI arg validation for `--role`
- Tests: registry merge order, collision rejection, lifecycle reconcile (add/remove
  across restarts), guardrail prompt composition for custom prompts, fair
  scheduling inclusion

## Test plan

- Unit: schema validation matrix (missing id/prompt, duplicate ids, bad interval);
  registry merge stability (built-ins first, custom after, deterministic order).
- Integration-style: config with one custom role runs a scripted tick end-to-end
  through the fake pi shim; removing the role archives it; restart re-reconciles.
- Guardrail check: composed custom prompt contains the same git-restriction text as
  built-in prompts.

## Risks and mitigations

- **Role enumeration drift** (a call site still hardcoded) → exhaustive grep +
  exports test asserting no built-in-only lists bypass the registry.
- **Operator prompt quality** → can't be fully controlled; mitigate with the
  harness-injected guardrails and docs giving a good template prompt.
- **Config-driven prompt injection risk** → custom prompts are data, executed by the
  same sandboxed loop path; no code loading from config (principle: no arbitrary JS).

## Sequencing

Stage 1 makes custom roles *possible* (static, restart-required). Stage 2 makes them
first-class citizens of fleet lifecycle. Stage 3 makes them visible everywhere.
Each stage lands green.
