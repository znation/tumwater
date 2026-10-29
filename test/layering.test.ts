/** Enforces DEVELOPMENT.md's Layout rule for src/ui/: "Imported only by each other and the
 * CLI command layer that drives it (cli.ts and the src/ command bodies)." Presentation depends
 * on core, never the reverse — a core module that needs a ui-resident formatter (the
 * src/failure/failure-render.ts and event-format.ts placements) must pull the formatter down to
 * src/
 * instead of reaching up into ui/. Without this check the rule lives only in prose and a
 * forbidden edge lands silently, as test-green as the rest of the suite. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./fixtures/repo-fixtures.js";
import { repoRoot } from "./helpers/repo-root.js";
import { writeFileDeep } from "./helpers/write-file-deep.js";

/** The command-layer modules DEVELOPMENT.md's rule lets drive src/ui/ (beside the cli.ts
 * dispatcher): the read-only command bodies (cli/cli-query-commands.ts, cli/cli-log-commands.ts,
 * run/run-detail.ts) and the
 * `tumwater gui` HTTP server layer (gui/gui-server.ts, gui/gui-endpoints.ts and the per-family
 * GET endpoint modules it barrells) that
 * gui/gui-command.ts
 * delegates to. Anything else importing src/ui/ is a layering bug. */
const COMMAND_LAYER = new Set([
  "cli/cli-query-commands.ts",
  "cli/cli-log-commands.ts",
  "run/run-detail.ts",
  "run/run-detail-render.ts",
  "gui/gui-server.ts",
  "gui/gui-endpoints.ts",
  "gui/gui-history-endpoints.ts",
]);

/** The relative paths (posix-style, under `srcDir`) of `.ts` modules that import src/ui/ without
 * being allowed to, plus how many `.ts` files the walk actually saw. Returned together so the
 * caller can assert the scan was non-empty — an empty tree reads as "no offenders" exactly like
 * a clean tree, which is how the directory-resolution bug went unnoticed. Shared with the fixture
 * test below so the detection it pins and the real scan cannot drift. */
function scanUiImports(srcDir: string): { offenders: string[]; scanned: number } {
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      scanned += 1;
      const rel = path.relative(srcDir, full).split(path.sep).join("/");
      // The ui layer's own modules import each other freely; cli.ts is the dispatcher every
      // ui command surface hangs off, and COMMAND_LAYER names the documented command bodies.
      if (rel.startsWith("ui/") || rel === "cli.ts" || COMMAND_LAYER.has(rel)) continue;
      if (/from "\.\.?\/ui\//.test(fs.readFileSync(full, "utf8"))) offenders.push(rel);
    }
  };
  walk(srcDir);
  return { offenders, scanned };
}

test("no core module outside the CLI command layer imports src/ui/", () => {
  const srcDir = path.join(repoRoot(fileURLToPath(new URL(".", import.meta.url))), "src");
  const { offenders, scanned } = scanUiImports(srcDir);
  // A scan of zero files is a vacuous pass, not a green guard: it is exactly the shape the
  // fixed-path regression took, so assert the tree was actually read.
  assert.ok(scanned > 0, `the layering scan found no .ts sources under ${srcDir}`);
  assert.deepEqual(offenders, [], `core modules importing src/ui/: ${offenders.join(", ")}`);
});

test("the layering scanner flags a planted core->ui import and clears allowed ones", () => {
  const srcDir = tmpdir("layering-scan-");
  try {
    const write = (rel: string, body: string): void => {
      const file = path.join(srcDir, rel);
      writeFileDeep(file, body);
    };
    write("ui/thing.ts", "export const thing = 1;\n");
    write("core.ts", 'import { thing } from "./ui/thing.js";\nvoid thing;\n'); // the violation
    write("cli/cli-query-commands.ts", 'import { thing } from "../ui/thing.js";\nvoid thing;\n'); // allowed
    write("ui/inner.ts", 'import { thing } from "./thing.js";\nvoid thing;\n'); // ui importing ui
    write("cli.ts", 'import { thing } from "./ui/thing.js";\nvoid thing;\n'); // the dispatcher
    const { offenders, scanned } = scanUiImports(srcDir);
    assert.deepEqual(offenders, ["core.ts"], "only the core module's ui import is flagged");
    assert.equal(scanned, 5, "every .ts file was read");
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});
