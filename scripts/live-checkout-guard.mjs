// First step of package.json's "test" and "test:e2e" scripts, ahead of eslint, tsc and the
// stamp: refuse to run the suite in a checkout that a live fleet runs from. `tumwater run`
// executes that checkout's dist/, and the dashboards poll dist/build-info.json to follow its
// redeploys, while the suite's first steps recompile and restamp that same dist/ — an unvetted
// deploy under the running fleet that races its redeploy swap. On 2026-09-29 a bugfix agent
// ran `cd <primary checkout> && npm run test` from outside its worktree: the rebuild re-exec'd
// the live dashboard, a test's fake stamp re-exec'd it again, and it stayed detached from
// every later redeploy (BUGS.md). The fleet's own suites run in its worktrees
// (.tumwater/worktrees/*), which never hold an orchestrator marker, so they always pass.
//
// Plain Node with no imports from dist/: this runs before the compile, possibly in a checkout
// that has no dist/ yet. The marker path and liveness rule are src/paths.ts's
// orchestratorStatePath and src/fleet/orchestrator-info.ts's orchestratorAlive; the guard's tests write
// the marker through those, so the two cannot drift apart unnoticed.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd(); // npm runs scripts from the package root
let pid = null;
try {
  pid = JSON.parse(fs.readFileSync(path.join(root, ".tumwater", "state", "orchestrator.json"), "utf8")).pid;
} catch {
  // No marker (no fleet ever ran here, or it stopped cleanly) or a torn one: no live fleet.
}
if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
  process.stderr.write(
    `tumwater: refusing to run the suite in ${root} — a live fleet runs from this checkout ` +
      `(\`tumwater run\`, pid ${pid}).\n` +
      "Its first steps recompile and restamp this checkout's dist/, the code that fleet and its dashboards execute.\n" +
      "Run it from a worktree instead: a fleet loop's own is .tumwater/worktrees/<role>, the directory its run started in.\n",
  );
  process.exit(1);
}

/** process.kill(pid, 0) probes without signalling — the harness's own pidAlive rule. */
function alive(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}
