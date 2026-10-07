import fs from "node:fs";
import path from "node:path";
import { writeScript } from "./fake-commands.js";
// The process-table fake's single home is the shared test-fake catalog (test/fakes/process.ts,
// PLANS.md 2026-10-04); these re-exports keep the doctor files' existing import surface while
// the fake itself lives with its siblings. That host-facing fixture was doctor-fixtures's only
// process-table content — the doctor files never read the host's real state.
export { noProcesses, fakeProbe } from "./fakes/process.js";
import { makeRepo, tmpdir, writeConfig } from "./repo-fixtures.js";

/** Fixtures shared by the doctor test files (doctor.test.ts, doctor-checks.test.ts,
 * doctor-orphans.test.ts): a
 * deterministic PATH for the binary checks, a ready repo, and a fake process table so the
 * orphan and report checks never read the host's real state. */

/** A bin dir holding executable files with the given names — a deterministic PATH for the binary checks. */
export function fakeBins(...names: string[]): string {
  const dir = tmpdir("doctor-bins-");
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

/** A ready repo: one commit on main plus a valid tumwater.json (the empty object — all
 * defaults). */
export function readyRepo(): string {
  const root = makeRepo();
  writeConfig(root, {});
  return root;
}

/** The doctor CLI wiring tests' PATH entry: a fake `pi` (exit 0) and a fake `ps` that touches
 * `psRan` and prints an empty process table. The CLI's orphan scan must never read the host's
 * real table here — any PPID-1 carrier of a dead run's mark anywhere on the machine (a leak;
 * they have happened, see the sweep entries in Fixed) would flip doctor's exit to 1 and fail
 * every landing's build check while the failure names an unrelated commit (found 2026-09-30).
 * The tests assert the marker file exists, so a revert to the host probe fails loudly in the
 * suite instead of silently at the next real leak; the orphan check's own semantics stay
 * covered in test/doctor-orphans.test.ts under fakeProbe. */
export function hermeticHostBins(psRan: string): string {
  const dir = tmpdir("doctor-host-bins-");
  writeScript(path.join(dir, "pi"), "exit 0");
  writeScript(path.join(dir, "ps"), `: > "${psRan}"\nexit 0\n`);
  return dir;
}
