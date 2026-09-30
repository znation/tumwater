import fs from "node:fs";
import path from "node:path";
import type { ProcessProbe, ProcessRow } from "../src/process.js";
import { makeRepo, tmpdir, writeConfig } from "./repo-fixtures.js";

/** Fixtures shared by the doctor test files (doctor.test.ts, doctor-orphans.test.ts): a
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

/** An empty process table and a healthy launchservicesd: runDoctor's report tests pin every
 * other check without reading the host's real table or daemon (the orphan check's own tests
 * drive it with fakeProbe in test/doctor-orphans.test.ts; the port check's live in
 * launch-services.test.ts). */
export const noProcesses: ProcessProbe = {
  list: async () => [],
  cwds: async () => new Map(),
  launchServicesPorts: async () => 1_000,
};

/** A fake process table for checkOrphans: each row defaults to a parentless (PPID 1) process
 * of this user, and `cwds` answers from the given map. `asked` records every cwd lookup, so a
 * test can pin that only parentless candidates reach lsof. No real process is spawned. */
export function fakeProbe(
  rows: Array<Partial<ProcessRow> & { pid: number; command: string }>,
  cwds: Record<number, string> = {},
): { probe: ProcessProbe; asked: number[][] } {
  const asked: number[][] = [];
  const uid = process.getuid?.() ?? 0;
  const probe: ProcessProbe = {
    list: async () => rows.map((r) => ({ ppid: 1, uid, etime: "01:00", time: "0:00.10", ...r })),
    cwds: async (pids) => {
      asked.push(pids);
      return new Map(pids.flatMap((p): Array<[number, string]> => (cwds[p] !== undefined ? [[p, cwds[p]]] : [])));
    },
    launchServicesPorts: async () => null,
  };
  return { probe, asked };
}
