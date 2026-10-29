/** The config KEY language — how `tumwater config get/set/unset` and the dashboard editors
 * name a config value and what makes one legitimate, apart from the writes that change it.
 * One family, in its own module because it serves both verbs AND the read side: `config get`,
 * shell completion, doctor's holds and the dashboard controllers all address keys and screen
 * per-key values without performing a write, so burying this in the config-write module made
 * read-side callers import from the "config WRITES" layer. The mutators (the load →
 * validate → atomic-write idiom, the cross-process lock) live in src/config/config-write-core.ts
 * (the operator-editor verbs in src/config/config-write.ts;
 * the director's staged request in src/config/config-request.ts);
 * the per-key validators and key-shape parsing here are the one home of the wording both the
 * writers and the read side show. */
import { BACKEND_KEYS, BACKOFF_KEYS, BOOTSTRAP_KEYS, CHECK_KEYS, CLAUDE_AGENT_KEYS, CODEX_BACKEND_KEYS, REVIEW_KEYS, ROLE_ENTRY_KEYS, TIER_MAP_KEYS, TOP_LEVEL_KEYS, type ModelTier } from "./config-schema.js";
import { typoSuffix } from "../text/suggest.js";
import { MAX_DURATION_SECONDS, show } from "./config-field-checks.js";
import { parseQuietHours } from "../scheduling/quiet-hours.js";

/** One definition of "a valid daily budget cap" (the TUI's Ctrl+B editor and the GUI's
 * /api/budget endpoint both run their input through it): a finite number of 0 or more —
 * 0 disables the gate, fractional dollars allowed (the badge renders cents). Returns an
 * actionable error message for anything else so both surfaces can flash it without
 * try/catch plumbing. A value past Number.MAX_SAFE_INTEGER is rejected too: it stays
 * finite ("9"×25 → 1e24), so only this screen stands between a one-zero typo in the
 * browser's budget editor and an effectively uncapped budget (BUGS.md 2026-10-02, the
 * same rule the TUI's parseBudgetInput applies). `key` names the config key in the error,
 * defaulting to the team-wide `maxDailyCostUsd`; the per-role map passes
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

/** One definition of "a valid quietHours window" (src/scheduling/quiet-hours.ts owns the format):
 * "HH:MM-HH:MM" in local time, wrapping permitted, empty means off. parseQuietHours's
 * message is the one wording every surface (validateConfig, `config set`, the TUI/GUI
 * editors) shows, so they cannot drift apart on what a valid window is. `key` names the
 * config key in the error, defaulting to the team-wide `quietHours`; the per-role map passes
 * `quietHoursPerRole.<id>` so a rejected entry names the key actually set. */
export function checkQuietHours(value: unknown, key = "quietHours"): string | null {
  const parsed = parseQuietHours(value, key);
  return parsed.ok ? null : parsed.error;
}

/** One definition of "a valid min run interval" — the seconds value the team-wide
 * `minRunIntervalSeconds` and a per-role `roles.<id>.minRunIntervalSeconds` override hold:
 * a finite number of 0 or more, at most MAX_DURATION_SECONDS (the ×1000 setTimeout bound the
 * config schema's duration rules share). The dashboard's interval editor runs this before
 * writing; `config set roles.<id>.minRunIntervalSeconds` leans on validateConfig's
 * DURATION_NON_NEGATIVE for the CLI path instead, but the two cannot drift on the upper bound
 * because both read the same MAX_DURATION_SECONDS constant. `key` names the config key in the
 * error, defaulting to the team-wide `minRunIntervalSeconds`; the per-role path passes
 * `roles.<id>.minRunIntervalSeconds` so a rejected entry names the key actually set. */
export function checkMinRunInterval(value: unknown, key = "minRunIntervalSeconds"): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_DURATION_SECONDS
  )
    return `${key} must be a number of 0 or more, at most ${MAX_DURATION_SECONDS} (got ${show(value)})`;
  return null;
}

/** Per-key value validators `config set` (and the dashboard editors that call it) run
 * BEFORE the write, so a malformed value fails with its own actionable message instead of
 * waiting for validateConfig's whole-file report. */
export const PER_KEY_VALIDATORS: Record<string, (value: unknown) => string | null> = {
  quietHours: checkQuietHours,
};

/** The per-role maps `config get/set` reaches with dotted keys: each names ONE entry
 * (`maxDailyCostUsdPerRole.<role>`, `quietHoursPerRole.<role>`) that merges into the
 * existing map, so raising one role's cap never requires re-typing another's. The per-key
 * value validator runs before the write, the same screening a bare top-level key gets. */
export const DOTTED_MAP_KEYS = ["maxDailyCostUsdPerRole", "quietHoursPerRole"] as const;

/** The fixed-shape top-level sections `config get/set/unset` reaches one field of with a
 * two-segment key (`review.model`, `bootstrap.untilPlansDone`), each with its field list. */
export const DOTTED_SECTION_FIELDS = {
  review: REVIEW_KEYS,
  check: CHECK_KEYS,
  idleBackoff: BACKOFF_KEYS,
  bootstrap: BOOTSTRAP_KEYS,
} as const;

/** The valid first segments of a dotted config key — the per-role maps plus the `roles.` and
 * `model.` sections. The generic dotted-shape error suggests against these so a typo'd head
 * (`modle.small`, `maxDailyCostUsdPerRoll.feature`) gets the same did-you-mean the sibling
 * unknown-key errors attach. */
const DOTTED_KEY_HEADS = [...DOTTED_MAP_KEYS, "roles", "model", "backends", ...Object.keys(DOTTED_SECTION_FIELDS)] as const;

/** A parsed config key: a bare top-level key (whole-value semantics, unchanged), a dotted
 * per-role map entry, a dotted role-entry field, or the error a malformed dotted shape
 * produces. The parser checks shape only — an unknown role id or an invalid value is left
 * for the validators downstream, which own the actionable wording. */
type ParsedConfigKey =
  | { kind: "top"; key: string }
  | { kind: "map"; map: (typeof DOTTED_MAP_KEYS)[number]; role: string }
  | { kind: "tier"; map: "model"; tier: ModelTier }
  | { kind: "role"; id: string; field: string }
  | { kind: "agent"; id: string; field: "bin" | "args" | "configDir" }
  | { kind: "section"; section: keyof typeof DOTTED_SECTION_FIELDS; field: string }
  | { kind: "error"; error: string };

/** The per-role map entry `maxDailyCostUsdPerRole.<role>` / `quietHoursPerRole.<role>` — a
 * whole-value bare key with no deeper segment names one map entry. Returns undefined when
 * the shape is not that of a two-segment per-role map entry. */
function parseMapEntry(parts: string[]): ParsedConfigKey | undefined {
  const first = parts[0] ?? "";
  const second = parts.length > 1 ? parts[1] ?? "" : undefined;
  const third = parts.length > 2 ? parts[2] ?? "" : undefined;
  if (third === undefined && second !== undefined && second !== "" && (DOTTED_MAP_KEYS as readonly string[]).includes(first))
    return { kind: "map", map: first as (typeof DOTTED_MAP_KEYS)[number], role: second };
  return undefined;
}

/** One role-entry field `roles.<id>.<field>` (e.g. `roles.qa.model`), with both segments
 * non-empty. Returns undefined when the shape is not a three-segment `roles.` key. */
function parseRoleField(parts: string[]): ParsedConfigKey | undefined {
  const first = parts[0] ?? "";
  const second = parts.length > 1 ? parts[1] ?? "" : undefined;
  const third = parts.length > 2 ? parts[2] ?? "" : undefined;
  if (parts.length === 3 && first === "roles" && second !== undefined && second !== "" && third !== undefined && third !== "")
    return { kind: "role", id: second, field: third };
  return undefined;
}

/** `backends.<id>.<field>` names one field of one agent backend's entry (the way
 * `roles.<id>.<field>` names one role field). The id is shape-checked only — routing owns
 * which agent ids exist (part 4b); a typo'd field is refused here with the valid ones named. */
function parseBackendField(parts: string[]): ParsedConfigKey | undefined {
  const first = parts[0] ?? "";
  const second = parts.length > 1 ? parts[1] ?? "" : undefined;
  const third = parts.length > 2 ? parts[2] ?? "" : undefined;
  if (parts.length === 3 && first === "backends" && second !== undefined && second !== "" && third !== undefined) {
    // configDir is claude/codex-only (CLAUDE_AGENT_KEYS / CODEX_BACKEND_KEYS):
    // a config set backends.pi.configDir would write a key nothing reads, so it is refused
    // everywhere but claude and codex.
    const validKeys = second === "claude" ? CLAUDE_AGENT_KEYS : second === "codex" ? CODEX_BACKEND_KEYS : BACKEND_KEYS;
    if ((validKeys as readonly string[]).includes(third))
      return { kind: "agent", id: second, field: third as "bin" | "args" | "configDir" };
    return {
      kind: "error",
      error: `unknown backend field "${third}" for backends.${second} (valid fields: ${validKeys.join(", ")})${typoSuffix(third, validKeys)}`,
    };
  }
  return undefined;
}

/** `model.<tier>` names one entry of the tier model map — the way `roles.<id>.model`
 * names one role field, `maxDailyCostUsdPerRole.<role>` names one map entry. The tier
 * must be a real tier: `config set model.turbo x` would otherwise write a dead map key
 * the runtime (and doctor's checkKnownKeys) would silently never resolve. */
function parseModelTier(parts: string[]): ParsedConfigKey | undefined {
  const first = parts[0] ?? "";
  const second = parts.length > 1 ? parts[1] ?? "" : undefined;
  if (parts.length === 2 && first === "model") {
    if ((TIER_MAP_KEYS).includes(second ?? ""))
      return { kind: "tier", map: "model", tier: second as ModelTier };
    return {
      kind: "error",
      error: `unknown model tier "${second ?? ""}" — a dotted \`model.<tier>\` names one of ${TIER_MAP_KEYS.join(", ")} (e.g. \`config set model.strong huggingface/zai-org/GLM-5.3-Flash:together:low\`)${typoSuffix(second ?? "", TIER_MAP_KEYS)}`,
    };
  }
  return undefined;
}

/** `<section>.<field>` names one field of a fixed-shape section (review, check, idleBackoff,
 * bootstrap); the field must be one the schema lists, or the write would be a dead key. */
function parseSectionField(parts: string[]): ParsedConfigKey | undefined {
  const first = parts[0] ?? "";
  const second = parts.length > 1 ? parts[1] ?? "" : undefined;
  if (parts.length === 2 && Object.hasOwn(DOTTED_SECTION_FIELDS, first)) {
    const section = first as keyof typeof DOTTED_SECTION_FIELDS;
    const fields: readonly string[] = DOTTED_SECTION_FIELDS[section];
    if (fields.includes(second ?? "")) return { kind: "section", section, field: second ?? "" };
    return {
      kind: "error",
      error: `unknown ${first} field "${second ?? ""}" (valid fields: ${fields.join(", ")})${typoSuffix(second ?? "", fields)}`,
    };
  }
  return undefined;
}

/** The generic dotted-shape rejection: the head is not one of the accepted shapes in a way
 * the earlier parsers would have claimed, so name the supported dotted forms wholesale. A
 * typo'd first segment is the common miss (`maxDailyCostUsdPerRoll.feature`, `modle.small`);
 * when the head is one of the valid ones the shape itself is wrong, so suggesting that head
 * back would mislead — hence the hint only when the head is unknown. */
function dottedShapeError(key: string, first: string): ParsedConfigKey {
  const headHint = (DOTTED_KEY_HEADS as readonly string[]).includes(first)
    ? ""
    : typoSuffix(first, DOTTED_KEY_HEADS);
  return {
    kind: "error",
    error:
      `unknown config key "${key}" — dotted keys name one entry of a per-role map or one field of a role entry (e.g. \`maxDailyCostUsdPerRole.feature 1.5\`, \`roles.qa.model x\`, \`review.model x\`); a bare key names a whole top-level value${headHint}`,
  };
}

/** Split a config key into its write/get shape: `foo` is top-level,
 * `maxDailyCostUsdPerRole.feature` / `quietHoursPerRole.qa` name one map entry,
 * `roles.qa.model` names one role-entry field, and anything else dotted is an error
 * naming the supported dotted forms. */
export function parseConfigKey(key: string): ParsedConfigKey {
  if (!key.includes(".")) return { kind: "top", key };
  const parts = key.split(".");
  const first = parts[0] ?? "";
  return (
    parseMapEntry(parts) ??
    parseRoleField(parts) ??
    parseBackendField(parts) ??
    parseModelTier(parts) ??
    parseSectionField(parts) ??
    dottedShapeError(key, first)
  );
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
