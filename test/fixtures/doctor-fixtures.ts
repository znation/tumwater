import fs from "node:fs";
import path from "node:path";
import { writeScript } from "../fakes/fake-commands.js";
// The process-table fake's single home is the shared test-fake catalog (test/fakes/process.ts,
// PLANS.md 2026-10-04); these re-exports keep the doctor files' existing import surface while
// the fake itself lives with its siblings. That host-facing fixture was doctor-fixtures's only
// process-table content — the doctor files never read the host's real state.
export { noProcesses, fakeProbe } from "../fakes/process.js";
import { makeRepo, tmpdir, writeConfig } from "./repo-fixtures.js";
import { loadConfig, saveConfig } from "../../src/config/config.js";
import { initProject } from "../../src/init/init.js";

/** Fixtures shared by the doctor test files (doctor.test.ts, doctor-checks.test.ts,
 * doctor-orphans.test.ts): a
 * deterministic PATH for the binary checks, a ready repo, and a fake process table so the
 * orphan and report checks never read the host's real state. */

/** A bin dir holding executable files with the given names — a deterministic PATH for the binary
 * checks. */
export function fakeBins(...names: string[]): string {
  const dir = tmpdir("doctor-bins-");
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

/** A ready repo: one commit on main plus a valid tumwater.json — all defaults except the
 * disk floor, which is disabled (both thresholds 0). The disk check reads the host's real
 * free space, and a hosted runner under the 10 GB default floor would fail its row, fail
 * every exit-0/verdict assertion below, and hold the e2e roles' runs elsewhere (CI's
 * ubuntu-26.04 image, 2026-10-22). The disk row stays covered by its injected-sample tests
 * in doctor-checks.test.ts; every test here wants a deterministic all-ok report. */
export function readyRepo(): string {
  const root = makeRepo();
  writeConfig(root, { diskHoldGB: 0, diskReclaimGB: 0 });
  return root;
}

/** An initialized repo for the CLI-wiring doctor tests: initProject's seeded config with the
 * disk floor disabled, the same hermeticity readyRepo carries. The CLI child reads the
 * host's real free space, and a hosted runner under the 10 GB default floor would fail the
 * disk row and with it every exit-0 or verdict-count assertion the wiring tests pin (CI's
 * ubuntu-26.04 image, 2026-10-22); the disk row's own levels stay covered by the injected
 * -sample tests in doctor-checks.test.ts. */
export async function diskHermeticRepo(label: string): Promise<string> {
  const repo = makeRepo();
  await initProject(repo, label);
  const config = loadConfig(repo);
  config.diskHoldGB = 0;
  config.diskReclaimGB = 0;
  saveConfig(repo, config);
  return repo;
}

/** The doctor CLI wiring tests' PATH entry: a fake `pi` (exit 0), a fake `ps` that touches
 * `psRan` and prints an empty process table, and a fake `top` that touches `${psRan}-top` and
 * prints a canned launchservicesd port row. The CLI's probes must never read the host here:
 * the orphan scan's real table could carry a PPID-1 carrier of a dead run's mark anywhere on
 * the machine (a leak; they have happened, see the sweep entries in Fixed), flipping doctor's
 * exit to 1 and failing every merge's build check while the failure names an unrelated
 * commit (found 2026-09-30); and the port check's live `top -l 1` sample can time out under
 * load in one invocation and not the other, so the plain and --json renders of the same
 * fixture disagree (found 2026-10-07). The tests assert the marker files exist, so a revert
 * to a host probe fails loudly in the suite; the checks' own semantics stay covered in
 * test/doctor-orphans.test.ts and test/process.test.ts under injected probes. */
export function hermeticHostBins(psRan: string): string {
  const dir = tmpdir("doctor-host-bins-");
  writeScript(path.join(dir, "pi"), "exit 0");
  writeScript(path.join(dir, "ps"), `: > "${psRan}"\nexit 0\n`);
  // One valid `top -stats pid,command,ports` row (parseTopPorts reads pid, name, count).
  writeScript(
    path.join(dir, "top"),
    `: > "${psRan}-top"\necho "  PID COMMAND          #PORTS"\necho "  579 launchservicesd     1638"\nexit 0\n`,
  );
  return dir;
}
