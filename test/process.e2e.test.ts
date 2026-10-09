/** The host's real process-table wiring: `cwds` shells out to `lsof -a -d cwd -Fn` on macOS
 * (and other non-Linux Unixes) and reads `/proc/<pid>/cwd` on Linux; `list` reads ps. The real
 * `cwds` reads moved out of the gating tier on 2026-10-08 (BUGS.md): a loaded host's lsof
 * could not finish inside its timeout and marked main red, which then held coverage and
 * security red and mis-attributed other changes. Like the rest of the orchestrator e2e tier
 * this runs via `npm run test:e2e`, not in the gating `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { systemProcessProbe } from "../src/process/process-table.js";

test("systemProcessProbe.cwds reads this process's real cwd and skips a vanished pid", async () => {
  // The vanished pid reaches lsof's exit-1 partial-result path on macOS (the /proc read just
  // skips it on Linux), and this process's pid must come back as its real cwd either way.
  const cwds = await systemProcessProbe.cwds([process.pid, 2_000_000_000]);
  assert.equal(cwds.get(process.pid), fs.realpathSync(process.cwd()));
  assert.equal(cwds.has(2_000_000_000), false);
});
