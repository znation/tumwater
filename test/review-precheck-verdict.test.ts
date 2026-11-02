/** The deterministic diff rules the gate rejects on, split from review-precheck.test.ts with the
 * other gate slices. Since Subtract part 3b/7 the gate runs only these rules and approves — it
 * runs no build check and no model reviewer — so this file covers the rules the gate still
 * enforces pre-merge: the gate scope (the three findings a later commit cannot repair) and the
 * watch scope (which also reports the repairable findings). The check's own unit tests live in
 * build-check.test.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { diffRuleReasons } from "../src/review/diff-rules.js";
import { headOf } from "../src/git/git.js";
import { treeDiffFiles } from "../src/git/git-diff.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { commitIn, makeRepo } from "./fixtures/repo-fixtures.js";
import { ROLE } from "./fixtures/gate-fixtures.js";

test("diffRuleReasons returns the gate's rules in order", async () => {
  const changedFiles = async (wt: string, base: string): Promise<string[]> =>
    (await treeDiffFiles(wt, base, await headOf(wt, "HEAD"))) ?? [];

  // conflict marker
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "app.ts"), "const a = 1;\n<<<<<<< HEAD\n");
    commitIn(wt, "leaves a conflict marker");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
    assert.match(reasons[0] ?? "", /conflict markers remain in: app\.ts/);
  }

  // secret leak (a secret-named env value not present at the base)
  {
    process.env.TUMWATER_TEST_SECRET = "leaky-secret-value-9876543210";
    try {
      const root = makeRepo();
      const wt = await ensureWorktree(root, ROLE, "main");
      const base = await headOf(wt, "HEAD");
      fs.writeFileSync(path.join(wt, "dump.txt"), "the value is leaky-secret-value-9876543210\n");
      commitIn(wt, "leaks a secret");
      const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
      assert.match(reasons[0] ?? "", /contains the value of \$TUMWATER_TEST_SECRET/);
    } finally {
      delete process.env.TUMWATER_TEST_SECRET;
    }
  }

  // protected edit
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "PRINCIPLES.md"), "One principle.\n");
    commitIn(wt, "edits PRINCIPLES");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
    assert.match(reasons[0] ?? "", /PRINCIPLES\.md is edited by the \w+ role/);
  }

  // an empty role (the watch cannot name the merging role) still runs the role-independent
  // brief-block rule, but not the PRINCIPLES rule that needs an attribution
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const brief = "# T\n\n<!-- tumwater:prompt:start -->\nthe prompt\n<!-- tumwater:prompt:end -->\n\n## Status\n\nold\n";
    fs.writeFileSync(path.join(wt, "README.md"), brief);
    commitIn(wt, "adds a brief");
    const briefBase = await headOf(wt, "HEAD"); // the brief block now sits at the base
    fs.writeFileSync(path.join(wt, "README.md"), brief.replace("the prompt", "other"));
    commitIn(wt, "changes the brief");
    const reasons = await diffRuleReasons(wt, briefBase, await changedFiles(wt, briefBase), "", false, "watch");
    assert.match(reasons[0] ?? "", /changes the brief between the tumwater:prompt markers/);
  }
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "PRINCIPLES.md"), "One principle.\n");
    commitIn(wt, "edits PRINCIPLES");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), "", false, "watch");
    assert.deepEqual(reasons, [], "an unknown role is no basis for condemning a PRINCIPLES edit");
  }

  // backlog structure
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "BUGS.md"), "# Bugs\n\n## Open\n\nentry one\n\n## Open\n\nentry two\n");
    commitIn(wt, "duplicates a section");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
    assert.match(reasons[0] ?? "", /adds another "## Open" heading/);
  }

  // an md-only diff runs the false-fix rule; a code diff does not
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(
      path.join(wt, "BUGS.md"),
      "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### Phantom bug (found 2026-10-01; fixed 2026-10-18)\n\n**Fix:** `noSuchSymbolOnTree` was added.\n",
    );
    commitIn(wt, "claims a phantom fix");
    const mdOnly = await changedFiles(wt, base);
    const reasons = await diffRuleReasons(wt, base, mdOnly, ROLE, true, "watch");
    assert.match(reasons[0] ?? "", /noSuchSymbolOnTree/);
    fs.writeFileSync(path.join(wt, "app.ts"), "export {};\n");
    commitIn(wt, "adds code beside the claim");
    const reasons2 = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
    assert.ok(!reasons2.some((r) => r.includes("noSuchSymbolOnTree")), "a code diff does not run the false-fix rule");
  }

  // short-circuit: when an earlier rule already rejects, a later rule never runs
  {
    process.env.TUMWATER_TEST_SECRET = "short-circuit-secret-5555";
    try {
      const root = makeRepo();
      const wt = await ensureWorktree(root, ROLE, "main");
      const base = await headOf(wt, "HEAD");
      fs.writeFileSync(path.join(wt, "app.ts"), "const a = 1;\n<<<<<<< HEAD\nconst leak = \"short-circuit-secret-5555\";\n");
      commitIn(wt, "leaves a conflict marker and leaks a secret");
      const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
      assert.match(reasons[0] ?? "", /conflict markers remain in: app\.ts/);
      assert.equal(reasons.length, 1, "the secret rule never runs once the marker already rejects");
    } finally {
      delete process.env.TUMWATER_TEST_SECRET;
    }
  }

  // a clean diff returns []
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "note.txt"), "hello\n");
    commitIn(wt, "a clean change");
    const reasons = await diffRuleReasons(wt, base, await changedFiles(wt, base), ROLE, false, "watch");
    assert.deepEqual(reasons, []);
  }
});

// Part 3m/3 narrowed the gate to the three findings a later commit cannot repair (a brief-block
// edit, a protected edit and a leaked credential); the other three — a conflict marker, a false
// fix claim and a broken backlog structure — are repairable by a later commit, so they stop
// refusing a diff pre-merge and the main watch reports them on main's tip instead.
test("the gate scope runs only the three unrepairable rules", async () => {
  const changedFiles = async (wt: string, base: string): Promise<string[]> =>
    (await treeDiffFiles(wt, base, await headOf(wt, "HEAD"))) ?? [];

  // a conflict marker and a false-fix claim on an exempt diff: the gate passes them ([]) while
  // the watch reports the conflict marker (which precedes the false-fix rule in watch order)
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const base = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "app.ts"), "const a = 1;\n<<<<<<< HEAD\n");
    fs.writeFileSync(
      path.join(wt, "BUGS.md"),
      "# Bugs\n\n## Open\n\n_None yet._\n\n## Fixed\n\n### Phantom bug (found 2026-10-01; fixed 2026-10-18)\n\n**Fix:** `noSuchSymbolOnTree` was added.\n",
    );
    commitIn(wt, "leaves a conflict marker and claims a phantom fix");
    const files = await changedFiles(wt, base);
    assert.deepEqual(
      await diffRuleReasons(wt, base, files, ROLE, true, "gate"),
      [],
      "the gate lets a conflict marker and a false-fix claim land for the watch to report",
    );
    assert.match(
      (await diffRuleReasons(wt, base, files, ROLE, true, "watch"))[0] ?? "",
      /conflict markers remain in: app\.ts/,
      "the watch still reports the conflict marker",
    );
  }

  // a brief-block edit and a secret leak are found under both scopes
  {
    const root = makeRepo();
    const wt = await ensureWorktree(root, ROLE, "main");
    const brief = "# T\n\n<!-- tumwater:prompt:start -->\nthe prompt\n<!-- tumwater:prompt:end -->\n\n## Status\n\nold\n";
    fs.writeFileSync(path.join(wt, "README.md"), brief);
    commitIn(wt, "adds a brief");
    const briefBase = await headOf(wt, "HEAD");
    fs.writeFileSync(path.join(wt, "README.md"), brief.replace("the prompt", "other"));
    commitIn(wt, "changes the brief");
    for (const scope of ["gate", "watch"] as const) {
      const reasons = await diffRuleReasons(wt, briefBase, await changedFiles(wt, briefBase), ROLE, true, scope);
      assert.match(reasons[0] ?? "", /changes the brief between the tumwater:prompt markers/, scope);
    }
    process.env.TUMWATER_TEST_SECRET = "gate-scope-secret-7777777";
    try {
      const root2 = makeRepo();
      const wt2 = await ensureWorktree(root2, ROLE, "main");
      const base2 = await headOf(wt2, "HEAD");
      fs.writeFileSync(path.join(wt2, "dump.txt"), "leak gate-scope-secret-7777777\n");
      commitIn(wt2, "leaks a secret");
      for (const scope of ["gate", "watch"] as const) {
        const reasons = await diffRuleReasons(wt2, base2, await changedFiles(wt2, base2), ROLE, false, scope);
        assert.match(reasons[0] ?? "", /contains the value of \$TUMWATER_TEST_SECRET/, scope);
      }
    } finally {
      delete process.env.TUMWATER_TEST_SECRET;
    }
  }
});
