/** A role run that an exception ends after its agent edited releases its slot unsettled, and the
 * role's next run gets those edits back (src/git/slot-salvage.ts, restoreSalvagedPhase in
 * src/runner/runner-run.ts). On 2026-10-21 the process-table wedge made the harness's own git
 * calls fail after agents had worked for many minutes; their slots were released unpinned with
 * the work still in them, and nothing gave it back. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRoleRunner, roleWt } from "./fixtures/runner-fixtures.js";
import { initializedRepo, sh, tmpdir } from "./fixtures/repo-fixtures.js";
import { logPromptsTo, readRunBlocks, withPi } from "./fakes/fake-pi.js";
import { assistantLine } from "./fixtures/pi-events.js";
import { eventsOfType } from "./fixtures/log-fixtures.js";
import { salvagePendingDir } from "../src/paths.js";

test("edits a run left when git failed under it come back to the role's next run as a handoff", async () => {
  const repo = await initializedRepo();
  const prompts = path.join(tmpdir(), "prompts-salvage.log");
  const counter = path.join(tmpdir(), "salvage-run-count");
  await withPi(
    [
      logPromptsTo(prompts),
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"`,
      `if [ "$n" = 1 ]; then`,
      `  printf 'half of the feature\\n' > feature.md`,
      // Every git call the harness makes in this worktree from here on fails, as every spawn
      // did in the wedge: the run's dirty check throws instead of reaching a verdict.
      `  chmod 000 "$(git rev-parse --absolute-git-dir)/index"`,
      `  printf '%s\\n' '${assistantLine("done\nSUMMARY: add the feature")}'`,
      `else`,
      `  printf 'the rest of it\\n' >> feature.md`,
      `  printf '%s\\n' '${assistantLine("finished\nSUMMARY: add the feature")}'`,
      `fi`,
    ].join("\n"),
    async () => {
      const runner = makeRoleRunner(repo, "feature");
      const first = await runner.run();
      assert.equal(first.result, "error", "the failing git call ended the run");
      const wt = roleWt(repo, "feature");
      // git works again (the wedge cleared) before the role's next run.
      fs.chmodSync(path.join(sh(wt, "git", "rev-parse", "--absolute-git-dir"), "index"), 0o644);

      const second = await runner.run();
      assert.equal(second.result, "queued");
      const runs = readRunBlocks(prompts);
      assert.equal(runs.length, 2);
      assert.match(runs[1]!, /cut short before tumwater could save its work/, "the run is told the edits are there");
      assert.doesNotMatch(runs[1]!, /--continue/, "a fresh session, not a resume of the failed one");
      assert.equal(
        sh(repo, "git", "show", `${second.commit}:feature.md`),
        "half of the feature\nthe rest of it",
        "the commit carries the first run's edits and the second's",
      );
      const resume = eventsOfType(repo, "resume").at(-1);
      assert.equal(resume?.cause, "salvaged");
      assert.match(String(resume?.restored), /^\.tumwater\/salvage\/\S+-feature\.patch$/);
      assert.deepEqual(fs.readdirSync(salvagePendingDir(repo, "feature")), [], "nothing is left waiting");
    },
  );
});
