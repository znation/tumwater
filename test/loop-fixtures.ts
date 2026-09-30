/** Fixtures around a LoopRunner and the build/baseline shapes its gates need: the constructor
 * call every loop test repeats, the counter-seeding and counter-reading pair, and the two
 * scratch-project shapes the build check and the main-baseline gate expect. The live
 * orchestrator tier has its own scaffolding in orchestrator-fixtures.ts; the fake toolchain
 * scripts these fixtures install come from fake-commands.ts. */
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { LoopRunner } from "../src/loop.js";
import { freshLoopState, saveLoopState } from "../src/loop-state.js";
import type { TumwaterConfig } from "../src/config-schema.js";
import { gitInit, sh, tmpdir } from "./repo-fixtures.js";
import { projManifest, writeScript } from "./fake-commands.js";
import { ensureParentDir } from "../src/files.js";

/** A real LoopRunner for one role — the constructor call every loop test repeats with the
 * same `defaultConfig()` and `"main"` trailing arguments, so those stay implied here and a
 * test states only what differs (config, base branch, abort signal). Cheap by design: the
 * constructor only loads loop state from disk and starts no processes. */
export function makeLoopRunner(
  repo: string,
  role: string,
  config: TumwaterConfig = defaultConfig(),
  mainBranch = "main",
  signal?: AbortSignal,
  sleep?: (ms: number) => Promise<void>,
): LoopRunner {
  return new LoopRunner(repo, role, config, mainBranch, signal, sleep);
}

/** Scratch project for the build-check tests (build-check.test.ts and review.test.ts's gate
 * integration): `root` has package.json + a fake toolchain in node_modules/.bin; `wt` sits
 * INSIDE it at the real worktree location (`.tumwater/worktrees/improve`) with its own tracked
 * package.json and no install — so root is an ancestor, as detectBuildCheck requires. */
export function buildCheckFixture(): { root: string; wt: string } {
  const base = tmpdir("buildcheck-");
  const root = path.join(base, "project");
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  writeScript(path.join(binDir, "buildcheck-tool"), "echo buildcheck-ok");

  const wt = path.join(root, ".tumwater", "worktrees", "improve");
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ build: "buildcheck-tool --ok" }),
  );
  return { root, wt };
}

/** A git repo whose main is "installed" (package.json + node_modules at root) with a linked
 * worktree checked out to it — the shape checkMainBaseline expects (a pristine main HEAD) —
 * shared by main-red.test.ts and main-baseline.test.ts. `testScript` is committed to main so
 * the worktree's checkout carries it; node_modules stays untracked — the install marker
 * detectBuildCheck walks up to, gitignored in real projects. Each fixture gets its own temp
 * dir, hence its own SHA: the gate's verdict cache and red-SHA warning state are module-level,
 * so tests must never share a HEAD. */
export function baselineFixture(role: string, testScript: string): { root: string; wt: string } {
  const root = path.join(tmpdir("baseline-"), "project");
  fs.mkdirSync(root, { recursive: true });
  gitInit(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ test: testScript }),
  );
  fs.mkdirSync(path.join(root, "node_modules")); // untracked install marker
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-m", "seed");
  const wt = path.join(root, ".tumwater", "worktrees", role);
  ensureParentDir(wt);
  sh(root, "git", "worktree", "add", "-b", `tumwater/${role}`, wt, "main");
  return { root, wt };
}

/** Seed each role's state file with non-zero counters plus scheduling fields. Variadic so a
 * multi-role test seeds all its runners through this one home (the reset tests do). */
export function seedCounters(repo: string, ...roles: string[]): void {
  for (const role of roles) seedOneCounter(repo, role);
}

function seedOneCounter(repo: string, role: string): void {
  const s = freshLoopState(role);
  s.ticks = 7;
  s.commits = 3;
  s.generatedTokens = 424242;
  s.totalCostUsd = 1.5;
  s.peakContextTokens = 65536; // last tick's peak — cleared by the reset
  s.nextRunAt = Date.now() + 60_000;
  s.backoffSeconds = 15;
  s.lastMainHead = "deadbeef";
  saveLoopState(repo, s);
}

/** How many times a fixture's test script actually ran (its appends to `counter`). Zero when
 * the counter was never written — an environmental skip ran nothing. */
export function runsOf(counter: string): number {
  try {
    return fs.readFileSync(counter, "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}
