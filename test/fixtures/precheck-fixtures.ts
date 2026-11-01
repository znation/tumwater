/** Shared scaffolding for the review gate's build pre-check slices — review-precheck.test.ts
 * (a red main), review-precheck-verdict.test.ts (the gate deciding alone),
 * review-precheck-green.test.ts (a green main or none) and review-precheck-closed.test.ts (a
 * pre-check that fails closed). The repo fixture, main's baseline helpers and the build_check
 * event reader live here so the four files cannot drift; the gate context and the role constant
 * stay in gate-fixtures.ts. */
import fs from "node:fs";
import path from "node:path";
import { ensureWorktree } from "../../src/git/worktree.js";
import { readEvents } from "../../src/events/event-read.js";
import { noteGreenBaseline } from "../../src/baseline/main-baseline.js";
import { projManifest, writeScript } from "../fakes/fake-commands.js";
import { commitIn, mainSha, makeRepo, sh } from "./repo-fixtures.js";
import { ROLE } from "./gate-fixtures.js";

/** A repo whose root carries the install signature (package.json + node_modules) and a
 * worktree with a committed change; both manifests declare the same check script under
 * `scriptName` (default `build`). `toolBody`, when given, is installed as an executable at
 * the root's node_modules/.bin/buildcheck-tool — the dogfood layout where the worktree
 * resolves its toolchain from the installed root. */
export async function gateBuildFixture(
  buildScript: string,
  toolBody?: string,
  scriptName = "build",
  /** What the root install's manifest declares — main's own check walks up to this, while the
   * change worktree carries its own copy of `buildScript`. Defaults to the same script; a test
   * whose change fails while main should stay green passes a passing script here, so the gate's
   * fresh main re-check (BUGS.md 2026-10-06) really passes. */
  rootScript = buildScript,
): Promise<{ root: string; wt: string }> {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  if (toolBody) {
    writeScript(path.join(root, "node_modules", ".bin", "buildcheck-tool"), toolBody);
  }
  fs.writeFileSync(
    path.join(root, "package.json"),
    projManifest({ [scriptName]: rootScript }),
  );
  const wt = await ensureWorktree(root, ROLE, "main");
  fs.writeFileSync(
    path.join(wt, "package.json"),
    projManifest({ [scriptName]: buildScript }),
  );
  fs.appendFileSync(path.join(wt, "seed.txt"), "change\n");
  commitIn(wt, "wip change");
  return { root, wt };
}

// makeRepo's seed commit is byte-identical across tests run in the same second, and the baseline
// cache is keyed by SHA and process-wide, so a test that needs main red or unverdicted gives main
// a commit of its own (uniqueMain) instead of trusting whatever an earlier test cached for the
// shared seed SHA.

/** Seed main's baseline green at `root`'s tip — what every merge leaves behind for the SHA it
 * moved main to (noteGreenBaseline), so the gate's attribution is a cache hit, no run. */
export function seedGreenMain(root: string): void {
  noteGreenBaseline(mainSha(root));
}

/** Give `root`'s main a commit no other test shares and return its sha: the baseline cache then
 * has no verdict for it, and the attribution check runs main's declared check for real. */
export function uniqueMain(root: string): string {
  const file = `main-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, file), "main moved\n");
  sh(root, "git", "add", file);
  sh(root, "git", "commit", "-m", "main moves on its own");
  return mainSha(root);
}

/** Each build_check event at `root` as `scope:status`, in order — how a test counts the gate's
 * attempts and main's baseline run. */
export const buildCheckEvents = (root: string): string[] =>
  readEvents(root)
    .filter((e) => e.type === "build_check")
    .map((e) => `${e.scope}:${e.status}`);
