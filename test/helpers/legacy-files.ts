/** Shared by the retired-names and vocabulary guards, so neither test file imports the other
 * (that would register its tests twice). */

/** Repo-relative files whose identifiers and text may name old words on purpose (their file names
 * are still checked by the retired-names guard). */
export const LEGACY_FILES: readonly string[] = [
  "src/orchestrator/startup-migrations.ts", // renames old on-disk state
  "src/orchestrator/startup-migration-steps.ts", // the migration steps
  "src/config/config-aliases.ts", // CONFIG_KEY_RENAMES names the old config keys
  "src/roles/legacy-role-ids.ts", // old role ids
  "test/startup-migrations.test.ts", // writes old state to disk
  "test/config-aliases.test.ts", // asserts the old config keys
  "test/legacy-role-ids.test.ts", // asserts the old role ids
  "test/legacy-role-migration.test.ts", // writes old role ids to disk
];

/** Lines exempted by `// retired-name-ok: <reason>` or a `retired-name-ok:start` … `:end` region
 * (1-based). */
export function exemptLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  let inRegion = false;
  lines.forEach((line, i) => {
    if (/\/\/ retired-name-ok:start +\S/.test(line)) inRegion = true;
    if (inRegion || /\/\/ retired-name-ok: +\S/.test(line)) out.add(i + 1);
    if (/\/\/ retired-name-ok:end\b/.test(line)) inRegion = false;
  });
  return out;
}
