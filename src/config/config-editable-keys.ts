/**
 * The config keys the dashboard's Settings view may show and edit: the top-level settings
 * an operator changes often from the browser. Everything else — customLoops, the per-role
 * maps — stays CLI/director territory (the plan's curation decision, 2026-10-02). One
 * constant so handleConfig (GET /api/config) and handleConfigSet (POST /api/config-set)
 * cannot drift apart on what is editable.
 *
 * This is config vocabulary, not HTTP vocabulary — it names which tumwater.json keys are
 * browser-editable — so it lives beside the other config-key lists (config-schema.ts's
 * TOP_LEVEL_KEYS, config-write.ts's per-key validators) rather than in the endpoint module
 * that first consumed it. The browser side mirrors the set for its labels
 * (ui/gui/gui-client-settings.ts's SETTINGS_KEYS); the round-trip test pins the two together.
 */
export const EDITABLE_CONFIG_KEYS = ["provider", "model", "fallback", "maxDailyCostUsd", "quietHours", "notify"] as const;
