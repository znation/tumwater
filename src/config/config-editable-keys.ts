/**
 * The config keys the dashboard's Settings view may show and edit: the top-level settings
 * an operator changes often from the browser. Everything else — customRoles, the per-role
 * maps — stays CLI/director territory (the plan's curation decision, 2026-10-02). One
 * constant so handleConfig (GET /api/config) and handleConfigSet (POST /api/config-set)
 * cannot drift apart on what is editable.
 *
 * This is config vocabulary, not HTTP vocabulary — it names which tumwater.json keys are
 * browser-editable — so it lives beside the other config-key lists (config-schema.ts's
 * TOP_LEVEL_KEYS, config-write.ts's per-key validators) rather than in the endpoint module
 * that first consumed it. The three run-concurrency knobs (maxConcurrent,
 * maxConcurrentPerProvider, worktreeSlots) joined the set because tumwater doctor's own
 * contention checks name them for the operator to raise (checkWorktreePool,
 * checkProviderContention); the per-role maps and customRoles still stay CLI/director
 * territory. The browser side mirrors the set for its labels
 * (ui/gui/gui-client-settings.ts's SETTINGS_KEYS), a manual copy; the GET /api/config test
 * pins the served key set to this list, and the settings test pins the browser copy's keys
 * and order to it.
 */
export const EDITABLE_CONFIG_KEYS = [
  "provider",
  "model",
  "fallback",
  "maxDailyCostUsd",
  // The run-concurrency knobs tumwater doctor's contention checks name for the operator to
  // raise (checkWorktreePool, checkProviderContention) — grouped so the Settings card that
  // shows the advice can apply it.
  "maxConcurrent",
  "maxConcurrentPerProvider",
  "worktreeSlots",
  "claudeWindowReserve",
  "quietHours",
  "notify",
  // The per-backend section (plans/agent-backends.md, part 4a/7): the whole `agents` object is
  // edited here as JSON. The CLI's dotted `backends.<id>.bin`/`.args` merge one field at a time.
  "backends",
] as const;
