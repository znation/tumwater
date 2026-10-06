/** Enforces DEVELOPMENT.md's Layout rule for src/ui/: "Imported only by each other and the
 * CLI command layer that drives it (cli.ts and the src/ command bodies)." Presentation depends
 * on core, never the reverse — a core module that needs a ui-resident formatter (the
 * src/failure/failure-render.ts and event-format.ts placements) must pull the formatter down to src/
 * instead of reaching up into ui/. Without this check the rule lives only in prose and a
 * forbidden edge lands silently, as test-green as the rest of the suite. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The command-layer modules DEVELOPMENT.md's rule lets drive src/ui/ (beside the cli.ts
 * dispatcher): the read-only command bodies (cli/cli-query-commands.ts, log-commands.ts) and the
 * `tumwater gui` HTTP server layer (gui/gui-server.ts, gui/gui-endpoints.ts) that gui/gui-command.ts
 * delegates to. Anything else importing src/ui/ is a layering bug. */
const COMMAND_LAYER = new Set([
  "cli/cli-query-commands.ts",
  "log-commands.ts",
  "gui/gui-server.ts",
  "gui/gui-endpoints.ts",
]);

test("no core module outside the CLI command layer imports src/ui/", () => {
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
      // The ui layer's own modules import each other freely; cli.ts is the dispatcher every
      // ui command surface hangs off, and COMMAND_LAYER names the documented command bodies.
      if (rel.startsWith("ui/") || rel === "cli.ts" || COMMAND_LAYER.has(rel)) continue;
      if (/from "\.\.?\/ui\//.test(fs.readFileSync(full, "utf8"))) offenders.push(rel);
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], `core modules importing src/ui/: ${offenders.join(", ")}`);
});
