// vocabulary: plain
/** The config KEY language — how `tumwater config get/set/unset` and the dashboard editors
 * name a config value and what makes one legitimate, apart from the writes that change it.
 * One family, in its own module because it serves both verbs AND the read side: `config get`,
 * shell completion, doctor's holds and the dashboard controllers all address keys and screen
 * per-key values without performing a write, so burying this in the config-write module made
 * read-side callers import from the "config WRITES" layer. The mutators (the load →
 * validate → atomic-write idiom, the cross-process lock) live in src/config/config-write.ts;
 * the per-key validators and key-shape parsing here are the one home of the wording both the
 * writers and the read side show. */
import { AGENT_KEYS, ROLE_ENTRY_KEYS, TIER_MAP_KEYS, TOP_LEVEL_KEYS, type ModelTier } from "./config-schema.js";
import { typoSuffix } from "../text/suggest.js";
import { POSITIVE_INTEGER, show } from "./config-field-checks.js";
import { parseQuietHours } from "../scheduling/quiet-hours.js";

/** One definition of "a valid daily budget cap" (the TUI's Ctrl+B editor and the GUI's
 * /api/budget endpoint both run their input through it): a finite number of 0 or more —
 * 0 disables the gate, fractional dollars allowed (the badge renders cents). Returns an
 * actionable error message for anything else so both surfaces can flash it without
 * try/catch plumbing. A value past Number.MAX_SAFE_INTEGER is rejected too: it stays
 * finite ("9"×25 → 1e24), so only this screen stands between a one-zero typo in the
 * browser's budget editor and an effectively uncapped budget (BUGS.md 2026-10-02, the
 * same rule the TUI's parseBudgetInput applies). `key` names the config key in the error,
 * defaulting to the fleet-wide `maxDailyCostUsd`; the per-role map passes
 * `maxDailyCostUsdPerRole.<id>` so a rejected entry names the key actually set. */
export function checkDailyBudgetUsd(value: unknown, key = "maxDailyCostUsd"): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    return `${key} must be a number of 0 or more, at most ${Number.MAX_SAFE_INTEGER}, 0 disables (got ${show(value)})`;
  return null;
}

/** One definition of "a valid per-provider concurrency cap" (plans/provider-concurrency.md
 * §1): a positive integer, accepted for any (possibly unknown) provider name — a fallback's
 * provider may only come into use later, so the key is not checked against a catalog. The one
 * validation both `config set maxConcurrentPerProvider.<provider>` and validateConfig show,
 * so they cannot drift apart on what a valid cap is. `key` names the config key in the error,
 * defaulting to the map name; the dotted map passes `maxConcurrentPerProvider.<provider>`
 * so a rejected entry names the key actually set. */
export function checkProviderConcurrencyCap(value: unknown, key = "maxConcurrentPerProvider"): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1)
    return `${key} must be ${POSITIVE_INTEGER.what} (got ${show(value)})`;
  return null;
}

/** One definition of "a valid quietHours window" (src/scheduling/quiet-hours.ts owns the format):
 * "HH:MM-HH:MM" in local time, wrapping permitted, empty means off. parseQuietHours's
 * message is the one wording every surface (validateConfig, `config set`, the TUI/GUI
 * editors) shows, so they cannot drift apart on what a valid window is. `key` names the
 * config key in the error, defaulting to the fleet-wide `quietHours`; the per-role map passes
 * `quietHoursPerRole.<id>` so a rejected entry names the key actually set. */
export function checkQuietHours(value: unknown, key = "quietHours"): string | null {
  const parsed = parseQuietHours(value, key);
  return parsed.ok ? null : parsed.error;
}

/** Per-key value validators `config set` (and the dashboard editors that call it) run
 * BEFORE the write, so a malformed value fails with its own actionable message instead of
 * waiting for validateConfig's whole-file report. */
export const PER_KEY_VALIDATORS: Record<string, (value: unknown) => string | null> = {
  quietHours: checkQuietHours,
};

/** The per-role maps `config get/set` reaches with dotted keys: each names ONE entry
 * (`maxDailyCostUsdPerRole.<role>`, `quietHoursPerRole.<role>`) that merges into the
 * existing map, so raising one role's cap never requires re-typing another's. The
 * `maxConcurrentPerProvider` map is dotted the same way (`maxConcurrentPerProvider.<provider>`);
 * its keys are provider names, not role ids, so its per-key validation skips the role-catalog
 * check the per-role maps apply. The per-key value validator runs before the write, the same
 * screening a bare top-level key gets. */
export const DOTTED_MAP_KEYS = ["maxDailyCostUsdPerRole", "quietHoursPerRole", "maxConcurrentPerProvider"] as const;

/** The valid first segments of a dotted config key — the per-role maps plus the `roles.` and
 * `model.` sections. The generic dotted-shape error suggests against these so a typo'd head
 * (`modle.small`, `maxDailyCostUsdPerRoll.feature`) gets the same did-you-mean the sibling
 * unknown-key errors attach. */
const DOTTED_KEY_HEADS = [...DOTTED_MAP_KEYS, "roles", "model", "backends"] as const;

/** A parsed config key: a bare top-level key (whole-value semantics, unchanged), a dotted
 * per-role map entry, a dotted role-entry field, or the error a malformed dotted shape
 * produces. The parser checks shape only — an unknown role id or an invalid value is left
 * for the validators downstream, which own the actionable wording. */
type ParsedConfigKey =
  | { kind: "top"; key: string }
  | { kind: "map"; map: (typeof DOTTED_MAP_KEYS)[number]; role: string }
  | { kind: "tier"; map: "model"; tier: ModelTier }
  | { kind: "role"; id: string; field: string }
  | { kind: "agent"; id: string; field: "bin" | "args" }
  | { kind: "error"; error: string };

/** Split a config key into its write/get shape: `foo` is top-level,
 * `maxDailyCostUsdPerRole.feature` / `quietHoursPerRole.qa` name one map entry,
 * `roles.qa.model` names one role-entry field, and anything else dotted is an error
 * naming the supported dotted forms. */
export function parseConfigKey(key: string): ParsedConfigKey {
  if (!key.includes(".")) return { kind: "top", key };
  const parts = key.split(".");
  const first = parts[0] ?? "";
  const second = parts.length > 1 ? parts[1] ?? "" : undefined;
  const third = parts.length > 2 ? parts[2] ?? "" : undefined;
  if (third === undefined && second !== undefined && second !== "" && (DOTTED_MAP_KEYS as readonly string[]).includes(first))
    return { kind: "map", map: first as (typeof DOTTED_MAP_KEYS)[number], role: second };
  if (parts.length === 3 && first === "roles" && second !== undefined && second !== "" && third !== undefined && third !== "")
    return { kind: "role", id: second, field: third };
  // `backends.<id>.<field>` names one field of one agent backend's entry (the way
  // `roles.<id>.<field>` names one role field). The id is shape-checked only — routing owns
  // which agent ids exist (part 4b); a typo'd field is refused here with the valid ones named.
  if (parts.length === 3 && first === "backends" && second !== undefined && second !== "" && third !== undefined) {
    if ((AGENT_KEYS as readonly string[]).includes(third))
      return { kind: "agent", id: second, field: third as "bin" | "args" };
    return {
      kind: "error",
      error: `unknown backend field "${third}" for backends.${second} (valid fields: ${AGENT_KEYS.join(", ")})${typoSuffix(third, AGENT_KEYS)}`,
    };
  }
  // `model.<tier>` names one entry of the tier model map — the way `roles.<id>.model`
  // names one role field, `maxDailyCostUsdPerRole.<role>` names one map entry. The tier
  // must be a real tier: `config set model.turbo x` would otherwise write a dead map key
  // the runtime (and doctor's checkKnownKeys) would silently never resolve.
  if (parts.length === 2 && first === "model") {
    if ((TIER_MAP_KEYS).includes(second ?? ""))
      return { kind: "tier", map: "model", tier: second as ModelTier };
    return {
      kind: "error",
      error: `unknown model tier "${second ?? ""}" — a dotted \`model.<tier>\` names one of ${TIER_MAP_KEYS.join(", ")} (e.g. \`config set model.strong huggingface/zai-org/GLM-5.3-Flash:together:low\`)${typoSuffix(second ?? "", TIER_MAP_KEYS)}`,
    };
  }
  // A typo'd first segment is the common miss (`maxDailyCostUsdPerRoll.feature`,
  // `modle.small`); when the head is one of the valid ones the shape itself is wrong, so
  // suggesting that head back would mislead — the generic wording is the whole story there.
  const headHint = (DOTTED_KEY_HEADS as readonly string[]).includes(first)
    ? ""
    : typoSuffix(first, DOTTED_KEY_HEADS);
  return {
    kind: "error",
    error:
      `unknown config key "${key}" — dotted keys name one entry of a per-role map or one field of a role entry (e.g. \`maxDailyCostUsdPerRole.feature 1.5\`, \`roles.qa.model x\`); a bare key names a whole top-level value${headHint}`,
  };
}

/** The error `tumwater config get <key>` and `config set <key> <value>` both surface for a
 * key outside TOP_LEVEL_KEYS — the valid-keys list plus text.ts's did-you-mean suggestion —
 * or null when the key is known. One home for the phrasing so whichever verb misspells a
 * key, the typo reads the same. */
export function unknownConfigKeyError(key: string): string | null {
  if ((TOP_LEVEL_KEYS as readonly string[]).includes(key)) return null;
  return `unknown config key "${key}" (valid top-level keys: ${TOP_LEVEL_KEYS.join(", ")})${typoSuffix(key, TOP_LEVEL_KEYS)}`;
}

/** The error for a dotted role key naming a field ROLE_ENTRY_KEYS does not hold — the one
 * home of the wording `config set` and `config get` both surface, so a typo'd `roles.qa.colour`
 * reads the same whichever verb names it (both refuse it; a silent `null` from get would look
 * like a real unset value). Null when the field is a known role-entry key. */
export function unknownRoleFieldError(id: string, field: string): string | null {
  if ((ROLE_ENTRY_KEYS as readonly string[]).includes(field)) return null;
  return `unknown role field "${field}" for roles.${id} (valid fields: ${ROLE_ENTRY_KEYS.join(", ")})${typoSuffix(field, ROLE_ENTRY_KEYS)}`;
}
