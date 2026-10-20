/** Disable one role in the repo's tumwater.json in place — the setup the retire tests (and the
 * TUI/GUI retire paths) need so retire's enabled-role rail does not object. */
import fs from "node:fs";
import path from "node:path";

import { readJson } from "./json-read.js";

export function disableRole(root: string, role: string): void {
  const file = path.join(root, "tumwater.json");
  const cfg = readJson(file) as { roles: Record<string, { enabled?: boolean }> };
  cfg.roles ??= {};
  cfg.roles[role] = { ...cfg.roles[role], enabled: false };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}
