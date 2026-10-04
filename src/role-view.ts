/** One loop's read-only inspection payload — the collector behind `tumwater role <id>`:
 * what the loop IS (catalog entry or custom, enabled, paused, tier), what it RUNS ON
 * (resolved provider/model, the budget fallback pair), what it CARRIES (the instructions
 * override and the role's own find text verbatim), and what its NEXT tick's prompt will
 * read like, assembled through the preview seam so nothing queued is consumed. Split out
 * of cli.ts like backlogPayload/status-data.ts's snapshot so the collector is testable
 * without the CLI and one renderer consumes exactly this shape. Every read degrades like
 * backlogPayload does — a missing tumwater.json is the defaults, a missing state file a
 * fresh state, a missing queue directory an empty inbox — so the command works with the
 * fleet stopped and never throws on a torn repo. */

import type { FallbackModelConfig } from "./config-schema.js";
import { defaultConfig, enabledRoleIds, isCustomRole, knownRoleIds, loadConfigSafe } from "./config.js";
import { DIRECTOR_ROLE, customRole, roleById, roleTier, unknownRoleMessage } from "./roles.js";
import { queuedRolePromptCount } from "./inbox.js";
import { pausedRoles } from "./fleet-state.js";
import { loadLoopState } from "./loop-state.js";
import { assembleTickPrompt } from "./tick-prompt.js";
import { configForRole, fallbackPair } from "./config-views.js";
import { fallbackModelFree, piModelsPath } from "./pi/pi-models.js";

/** What `tumwater role <id>` reports about one loop — the payload both the `--json`
 * document and the Markdown renderer consume (one shape, two surfaces). */
export interface RoleViewPayload {
  /** The loop's id as the caller named it. */
  id: string;
  /** The catalog title, or "user-defined loop" for a customLoops entry. */
  title: string;
  /** True when the id resolves through config.customLoops, not the built-in catalog. */
  custom: boolean;
  /** Whether the loop is enabled in tumwater.json (a disabled loop never ticks). */
  enabled: boolean;
  /** Whether a per-role pause marker currently holds the loop. */
  paused: boolean;
  /** Scheduling tier (roleTier): 0 work, 1 maintenance/observer — how fairOrder slots it. */
  tier: number;
  /** The resolved model wiring (configForRole): role overrides applied over top-level. */
  provider?: string;
  model?: string;
  thinking?: string;
  /** The budget gate's fallback pair, or null when none is configured. */
  fallback: FallbackModelConfig | null;
  /** Whether that fallback is actually free in pi's definitions — what makes the gate
   * willing to engage it. Meaningful only when `fallback` is non-null. */
  fallbackFree: boolean;
  /** The effective min-tick interval: the role's override or the global value. */
  minTickIntervalSeconds: number;
  /** The roles.<id>.instructions override verbatim, or null when unset. */
  instructions: string | null;
  /** The role's own find-something-to-do text verbatim (a custom loop's `task`), or null
   * for the director — it has no find text; its queued prompts ARE its work. */
  find: string | null;
  /** Prompts currently queued for this loop (the director's count includes the shared
   * inbox, which IS its queue). */
  inboxCount: number;
  /** The next tick's assembled prompt, verbatim, through the preview seam — or null when
   * the loop has nothing to run (a director with an empty inbox). */
  nextPrompt: string | null;
}

/** Collect one loop's inspection payload. `modelsPath` overrides pi's model definitions
 * location — a test seam, like status-data.ts's snapshot — consulted only when a fallback
 * pair is configured (the freeness verdict needs the definitions; nothing else does). */
export function rolePayload(root: string, role: string, modelsPath = piModelsPath()): RoleViewPayload {
  // loadConfigSafe (not loadConfigCached's hold-last-good machinery — this is a one-shot
  // command, not a poller): a broken or missing file degrades to the defaults, so the
  // command still answers for built-in roles on a torn repo.
  const { config } = loadConfigSafe(root);
  const cfg = config ?? defaultConfig();
  const catalog = roleById(role);
  const customEntry = cfg.customLoops.find((c) => c.name === role);
  // The director is inspectable like any loop but has no catalog entry: a pseudo-Role whose
  // find text is empty (rolePayload nulls it below — the director's queued prompts ARE its
  // work), so the unknown-role throw only fires for ids nothing can answer.
  const resolved =
    catalog ??
    (customEntry ? customRole(customEntry.name, customEntry.task)
    : role === DIRECTOR_ROLE ? { id: DIRECTOR_ROLE, title: DIRECTOR_ROLE, find: "" }
    : undefined);
  if (!resolved) {
    // The one unknown-role answer (unknownRoleMessage): the CLI's main catch turns the throw
    // into `tumwater: <message>` with exit 1, so the collector keeps the wording and the CLI
    // stays a thin peel-parse-print layer.
    throw new Error(unknownRoleMessage(role, knownRoleIds(cfg)));
  }
  const effective = configForRole(cfg, role);
  const fallback = fallbackPair(cfg);
  return {
    id: role,
    title: resolved.title,
    custom: isCustomRole(cfg, role),
    enabled: enabledRoleIds(cfg).includes(role),
    paused: pausedRoles(root).includes(role),
    tier: roleTier(role),
    ...(effective.provider ? { provider: effective.provider } : {}),
    ...(effective.model ? { model: effective.model } : {}),
    ...(effective.thinking ? { thinking: effective.thinking } : {}),
    fallback,
    fallbackFree: fallback ? fallbackModelFree(cfg, modelsPath) : false,
    minTickIntervalSeconds: effective.minTickIntervalSeconds,
    instructions: cfg.roles[role]?.instructions ?? null,
    find: role === DIRECTOR_ROLE ? null : resolved.find,
    inboxCount: queuedRolePromptCount(root, role),
    // The preview seam: the queued prompt (if any) is read, not consumed, so an inspection
    // never costs the loop its queued work — the property the tick-prompt test pins.
    nextPrompt:
      assembleTickPrompt({
        root,
        config: cfg,
        role,
        state: loadLoopState(root, role),
        preview: true,
      })?.prompt ?? null,
  };
}
