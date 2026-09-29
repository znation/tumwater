/** Enforces DEVELOPMENT.md's Layout rule for src/ui/: "Imported only by each other and
 * cli.ts." Presentation depends on core, never the reverse — a core module that needs a
 * ui-resident formatter (the failure-report.ts and event-format.ts placements) must pull the
 * formatter down to src/ instead of reaching up into ui/. Without this check the rule lives
 * only in prose and a forbidden edge lands silently, as test-green as the rest of the suite. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("no core module imports src/ui/ (only cli.ts may)", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = path.relative(srcDir, full).split(path.sep).join("/");
      // The ui layer's own modules import each other freely; cli.ts is the documented
      // exception — the dispatcher every ui command surface hangs off.
      if (rel.startsWith("ui/") || rel === "cli.ts") continue;
      if (/from "\.\.?\/ui\//.test(fs.readFileSync(full, "utf8"))) offenders.push(rel);
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], `core modules importing src/ui/: ${offenders.join(", ")}`);
});
