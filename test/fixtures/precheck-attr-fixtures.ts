/** Scaffolding for Hourly full check part 1a/4's pre-check tests — the gate's build check and
 * its attribution of a twice-failed run to main's tip. The check is a fake npm `build` script
 * (plus an optional `test:rerun` for the named-test re-run), stateful through a counter file so a
 * test can make a tree's check fail a set number of times before passing. The change worktree's
 * build script is what the gate runs; the main tip's build script is the root's committed one,
 * which mainTipGateVerdict and main's baseline run read at main's tip. */
import fs from "node:fs";
import path from "node:path";
import { ensureWorktree } from "../../src/git/worktree.js";
import { projManifest } from "../fakes/fake-commands.js";
import { commitIn, makeRepo, sh } from "./repo-fixtures.js";
import { ROLE } from "./gate-fixtures.js";

/** A build that fails with named test X on its FIRST run only (then passes): the flake case.
 * `counterFile` is created on the first run so every later run passes. */
function flakeBuildScript(counterFile: string): string {
  return [
    "#!/bin/sh",
    `if [ ! -f '${counterFile}' ]; then touch '${counterFile}'; echo "✖ X (1ms)"; echo "test at t.test.js:1:1"; exit 1; fi`,
    "exit 0",
    "",
  ].join("\n");
}

/** A repo for the flake case: the change worktree's check fails with named test X on its FIRST
 * run only (the pre-check's immediate re-run passes), and the named re-run (`test:rerun`) is
 * filter-tolerant (`true`). Main's tip check passes. `counter` is a fresh per-test file. */
export async function flakeGateFixture(): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  const counter = path.join(root, `flake-${process.pid}-${Date.now()}.txt`);
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ build: "exit 0", "test:rerun": "true" }));
  sh(root, "git", "add", "package.json");
  sh(root, "git", "commit", "-m", "declare the check");
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "package.json"), projManifest({ build: flakeBuildScript(counter), "test:rerun": "true" }));
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  commitIn(wt, "wip change");
  return { root, wt };
}

/** A repo for the known-failure case: the change worktree's check fails with named test X on
 * every run, and main's tip check passes. The test seeds X into the known-failure store (the
 * quarantine list `knownMainFailures` reads) so the pre-check can be short-circuited by the
 * known-failure match instead of re-running. */
export async function knownFailureFixture(): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), projManifest({ build: "exit 0", "test:rerun": "true" }));
  sh(root, "git", "add", "package.json");
  sh(root, "git", "commit", "-m", "declare the check");
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(path.join(wt, "package.json"), projManifest({ build: "echo \"✖ X (1ms)\"; echo \"test at t.test.js:1:1\"; exit 1", "test:rerun": "true" }));
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  commitIn(wt, "wip change");
  return { root, wt };
}
