import fs from "node:fs";
import path from "node:path";
import type { ProcessProbe, ProcessRow } from "../src/process-table.js";
import { writeScript } from "./fake-commands.js";
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

/** An empty process table and a healthy launchservicesd: runDoctor's report tests pin every
 * other check without reading the host's real table or daemon (the orphan check's own tests
 * drive it with fakeProbe in test/doctor-orphans.test.ts; the port check's live in
 * launch-services.test.ts). */
export const noProcesses: ProcessProbe = {
  list: async () => [],
  cwds: async () => new Map(),
  runMarkers: async () => new Map(),
  launchServicesPorts: async () => 1_000,
};

/** A fake process table for checkOrphans: each row defaults to a parentless (PPID 1) process
 * of this user, `cwds` answers from the given map, and `marks` gives each pid's raw
 * `TUMWATER_RUN` environment value (comma-separated markers) for the run-mark half of the
 * check. `asked` records every cwd lookup, so a test can pin that only parentless candidates
 * reach lsof. No real process is spawned. */
export function fakeProbe(
  rows: Array<Partial<ProcessRow> & { pid: number; command: string }>,
  cwds: Record<number, string> = {},
  marks: Record<number, string> = {},
): { probe: ProcessProbe; asked: number[][] } {
  const asked: number[][] = [];
  const uid = process.getuid?.() ?? 0;
  const probe: ProcessProbe = {
    list: async () => rows.map((r) => ({ ppid: 1, uid, etime: "01:00", time: "0:00.10", ...r })),
    cwds: async (pids) => {
      asked.push(pids);
      return new Map(pids.flatMap((p): Array<[number, string]> => (cwds[p] !== undefined ? [[p, cwds[p]]] : [])));
    },
    runMarkers: async (pids) =>
      new Map(
        pids.flatMap((p): Array<[number, string[]]> =>
          marks[p] !== undefined ? [[p, marks[p].split(",")]] : [],
        ),
      ),
    launchServicesPorts: async () => null,
  };
  return { probe, asked };
}
