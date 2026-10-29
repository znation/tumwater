// The gate's lint (package.json "test:gate"): eslint over only the files the change touches since
// its merge-base with main, where `npm test` lints the whole tree. A cached whole-tree lint
// already re-lints only files whose own content changed, so in a gate it mostly re-lints what main
// moved under the worktree, which cost minutes after a busy day on main. A change to the lint's
// own inputs, or a merge-base git cannot find, lints the whole tree; test/affected-tests.ts's
// gateLintTargets decides. Runs after the compile, so it imports the just-built dist/ (the same
// convention as stamp-build.mjs), and from npm, which puts eslint on PATH.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateLintTargets } from "../dist/test/affected-tests.js";
import { changedSinceBase } from "../dist/test/test-runner.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const changed = changedSinceBase(root, "main");
const targets = "error" in changed ? null : gateLintTargets(changed.files, (f) => fs.existsSync(path.join(root, f)));
if (targets !== null && targets.length === 0) {
  console.log("lint: no changed file to lint");
  process.exit(0);
}
console.log(targets === null ? "lint: the whole tree" : `lint: ${targets.length} changed file(s)`);
const r = spawnSync("eslint", ["--cache", "--no-warn-ignored", ...(targets ?? ["."])], { cwd: root, stdio: "inherit" });
if (r.error) process.stderr.write(`tumwater: could not start eslint: ${r.error.message}\n`);
process.exit(r.status ?? 1);
