/** The one table of retired role ids, old id → new id. The switch parts of the plain-terms role
 * rename add a row each; a row is never removed, because old events, state files and typed
 * flags keep naming the old id. */
export const LEGACY_ROLE_IDS: Readonly<Record<string, string>> = {
  dry: "dedupe",
};

/** Today's id for a role id a person typed or an old file holds; any other id comes back
 * unchanged. `legacy` is a test seam. */
export function canonicalRoleId(id: string, legacy: Readonly<Record<string, string>> = LEGACY_ROLE_IDS): string {
  return Object.hasOwn(legacy, id) ? legacy[id]! : id;
}

/** The retired ids that now map to `id`. */
export function legacyRoleIdsOf(id: string, legacy: Readonly<Record<string, string>> = LEGACY_ROLE_IDS): string[] {
  return Object.entries(legacy).filter(([, next]) => next === id).map(([old]) => old);
}

/** `--grep` arguments matching a role's commit subjects under its current id and every retired
 * one. git ORs repeated `--grep`s, so a history search sees both. */
export function roleCommitGrep(id: string, legacy: Readonly<Record<string, string>> = LEGACY_ROLE_IDS): string {
  return [id, ...legacyRoleIdsOf(id, legacy)].map((r) => `--grep="tumwater(${r})"`).join(" ");
}
