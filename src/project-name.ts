import path from "node:path";

/** The project's display name: the basename of the resolved repo root. One home for the
 * derivation the status payload's `project` field (the dashboards' title), the TUI/status
 * header's `tumwater · <name>`, and init's brief heading all render through, so the name one
 * surface shows cannot drift from another's for the same root. Resolving first is part of the
 * rule, not an extra: a trailing separator or a relative root must yield the same name as its
 * absolute form. Presentation only; depends on node built-ins alone. */
export function projectName(root: string): string {
  return path.basename(path.resolve(root));
}
