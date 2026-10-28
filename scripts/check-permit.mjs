// Wrapper for a project check command's suite step: take one host-wide slot from the team's
// check-slot ledger (src/concurrency/check-slots.ts) before running the given command, so every
// suite the project's check scripts start — an agent's bare `npm run test:gate` and the harness's
// own spawned check alike — contends for the same config.maxConcurrentChecks cap. Before this
// wrapper, an agent's own suite took no team check permit, so a burst of agents stacked suites on
// the host (BUGS.md 2026-10-28). Run as `node scripts/check-permit.mjs <cmd> [args...]`.
//
// Runs after the compile, so it imports the just-built dist/ (the same convention as
// stamp-build.mjs); the cap and the ledger's lock protocol therefore have exactly one definition
// each, shared with the harness. Best-effort by design: no team root means there is no ledger to
// contend for, and a full ledger (or an unable-to-create ledger) degrades to running the command
// unpermitted with a one-line warning rather than hanging past the check deadline or the bash
// tool's timeout.
import { spawn } from "node:child_process";
import { findTeamRoot, acquireCheckSlot, releaseCheckSlot } from "../dist/src/concurrency/check-slots.js";
import { liveConfig } from "../dist/src/config/config.js";

const [cmd, ...args] = process.argv.slice(2);
if (cmd === undefined) {
  process.stderr.write("usage: node scripts/check-permit.mjs <cmd> [args...]\n");
  process.exit(2);
}

const root = findTeamRoot(process.cwd());
let slot = null;
if (root !== null) {
  const cap = liveConfig(root).maxConcurrentChecks;
  slot = await acquireCheckSlot(root, cap);
  if (slot === null) {
    process.stderr.write(
      `tumwater: no free check slot (cap ${cap}) — running the suite unpermitted after waiting.\n`,
    );
  }
}

const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
try {
  const code = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve(signal === null ? code ?? 0 : 1));
    child.on("error", () => {
      process.stderr.write(`tumwater: failed to start ${cmd}\n`);
      resolve(1);
    });
  });
  process.exitCode = code;
} finally {
  if (slot !== null) releaseCheckSlot(slot);
}
