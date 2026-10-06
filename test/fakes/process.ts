/** A fake process table for the host-facing checks, under the shared test-fake catalog
 * (test/fakes/, PLANS.md 2026-10-04): `list` answers the scripted rows, `cwds`/`runMarkers`
 * answer from given maps, `launchServicesPorts` answers the scripted count — so doctor's
 * orphan and port checks (and the fleet's port watch) run against a fake host in tests,
 * never against real spawned orphans, the real Mac's daemon, or the host's REAL process
 * table (BUGS.md "The doctor CLI tests in test/doctor.test.ts assert exit 0 against the
 * host's REAL process table"). No real process is spawned. Node built-ins only.
 */
import type { ProcessProbe, ProcessRow } from "../../src/process/process-table.js";

/** An empty process table and a healthy launchservicesd: the inert host the check tests pin
 * every other check with while driving one check's own tests with `fakeProbe`. */
export const noProcesses: ProcessProbe = {
  list: async () => [],
  cwds: async () => new Map(),
  runMarkers: async () => new Map(),
  launchServicesPorts: async () => 1_000,
};

/** A fake process table: each row defaults to a parentless (PPID 1) process of this user,
 * `cwds` answers from the given map, `marks` gives each pid's raw `TUMWATER_RUN` environment
 * value (comma-separated markers) for the run-mark half of the orphan check, and `ports`
 * scripts what launchservicesd's port count reads as (null = unreadable/off-macOS).
 * `asked` records every cwd lookup, so a test can pin that only parentless candidates reach
 * lsof. */
export function fakeProbe(
  rows: Array<Partial<ProcessRow> & { pid: number; command: string }>,
  cwds: Record<number, string> = {},
  marks: Record<number, string> = {},
  opts: { ports?: number | null } = {},
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
    launchServicesPorts: async () => (opts.ports === undefined ? null : opts.ports),
  };
  return { probe, asked };
}