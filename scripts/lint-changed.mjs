// The gate's lint (package.json "test:gate"): eslint over only the files the change touches since
// its merge-base with main, where `npm test` lints the whole tree. A cached whole-tree lint
// already re-lints only files whose own content changed, so in a gate it mostly re-lints what main
// moved under the worktree, which cost minutes after a busy day on main. A change to the lint's
// own inputs, or a merge-base git cannot find, lints the whole tree; test/affected-tests.ts's
// gateLintTargets decides. Runs after the compile, so it imports the just-built dist/ (the same
// convention as stamp-build.mjs), and from npm, which puts eslint on PATH.
//
// `--alongside <cmd> [args...]` runs that command (the gate's test step) while eslint works,
// instead of after it: a one-file type-aware lint costs 0.4–3 s, most of a gate's fixed overhead
// on a loaded host, and nothing in either step reads the other's output. The command keeps the
// terminal; eslint's report is held and printed once both are done, so it never splits the test
// output the harness parses. The exit status is the command's when it failed, else eslint's.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateLintTargets } from "../dist/test/affected-tests.js";
import { changedSinceBase } from "../dist/test/test-runner.js";

const argv = process.argv.slice(2);
const at = argv.indexOf("--alongside");
const alongside = at === -1 ? null : argv.slice(at + 1);
if (alongside !== null && alongside.length === 0) {
  process.stderr.write("usage: node scripts/lint-changed.mjs [--alongside <cmd> [args...]]\n");
  process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const changed = changedSinceBase(root, "main");
const targets = "error" in changed ? null : gateLintTargets(changed.files, (f) => fs.existsSync(path.join(root, f)));
const lintArgs = targets !== null && targets.length === 0 ? null : ["--cache", "--no-warn-ignored", ...(targets ?? ["."])];
console.log(lintArgs === null ? "lint: no changed file to lint" : targets === null ? "lint: the whole tree" : `lint: ${targets.length} changed file(s)`);

if (alongside === null) {
  if (lintArgs === null) process.exit(0);
  const r = spawnSync("eslint", lintArgs, { cwd: root, stdio: "inherit" });
  if (r.error) process.stderr.write(`tumwater: could not start eslint: ${r.error.message}\n`);
  process.exit(r.status ?? 1);
}

/** Resolve with a child's exit status: its code, 1 for a signal or a failed start. */
const exited = (child, onError) =>
  new Promise((resolve) => {
    child.on("error", (err) => {
      onError(err);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(signal === null ? (code ?? 1) : 1));
  });

let lintOut = "";
const lint =
  lintArgs === null
    ? null
    : spawn("eslint", lintArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
lint?.stdout.on("data", (d) => (lintOut += d));
lint?.stderr.on("data", (d) => (lintOut += d));
const lintDone = lint === null ? Promise.resolve(0) : exited(lint, (err) => (lintOut += `tumwater: could not start eslint: ${err.message}\n`));

const [cmd, ...args] = alongside;
const child = spawn(cmd, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    child.kill(signal);
    lint?.kill(signal);
  });
const status = await exited(child, () => process.stderr.write(`tumwater: failed to start ${cmd}\n`));
const lintStatus = await lintDone;
if (lintOut !== "") process.stdout.write(lintOut.endsWith("\n") ? lintOut : `${lintOut}\n`);
if (lint !== null) console.log(lintStatus === 0 ? "lint: clean" : "lint: failed (eslint's report above)");
// exitCode, not exit(): stdout may be a pipe still draining the report.
process.exitCode = status !== 0 ? status : lintStatus;
