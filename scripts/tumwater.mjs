// Dev entry point for `npm run tumwater` — runs the compiled CLI (dist/src/cli.js) with every
// argument passed through and its exit code propagated. Before the spawn: a tree without a
// build would otherwise die with a raw ERR_MODULE_NOT_FOUND stack for dist/src/cli.js (repro:
// rm -rf dist && npm run tumwater status) instead of the fix. Name the command that produces
// a build — the dev CLI means nothing against a stale tree anyway. The installed `bin` entry
// never sees this wrapper: package.json points it at dist/src/cli.js, which exists there.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "src",
  "cli.js",
);
if (!fs.existsSync(cli)) {
  console.error(
    "npm run tumwater runs the compiled build: run `npm run build` first (dist/src is missing).",
  );
  process.exit(1);
}
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
