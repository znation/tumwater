/** Setup the main watch's test slices share (main-watch.test.ts, main-watch-failures.test.ts,
 * main-watch-spells.test.ts, main-watch-rules.test.ts): a red check's output, a one-file commit
 * on main, one settled poll of the watch, and the fixture a red tip's culprit tests start from.
 * The baseline project itself is runner-fixtures' baselineFixture. */
import fs from "node:fs";
import path from "node:path";
import type { createMainWatch } from "../../src/baseline/main-watch.js";
import { defaultConfig } from "../../src/config/config.js";
import { baselineFixture } from "./runner-fixtures.js";
import { headSha, sh } from "./repo-fixtures.js";

/** A failing check's output in node:test's spec shape: three failing tests, then the summary that
 * lists the first again. The verdict's failing tests are first, second and third. */
export const FAILING_OUTPUT = "printf '✖ first (1.2ms)\\n✖ second\\n✖ third (3ms)\\n✖ failing tests:\\n✖ first (1.2ms)\\n'";

/** Commit `content` as `file` on the fixture's main. Returns main's new SHA. */
export function change(root: string, file: string, content: string): string {
  fs.writeFileSync(path.join(root, file), content);
  // Only the named file: `add -A` would also stage the fixture's role worktree under .tumwater/.
  sh(root, "git", "add", "--", file);
  sh(root, "git", "commit", "-m", `edit ${file}`);
  return headSha(root);
}

/** Poll `watch` at main's current head (`held`: the team is held) and wait until it settles. */
export async function watchAt(watch: ReturnType<typeof createMainWatch>, root: string, held = false): Promise<void> {
  watch.poll(headSha(root), held, defaultConfig());
  await watch.idle();
}

/** A baseline fixture whose check fails with FAILING_OUTPUT while bad.txt is tracked, so a test
 * turns main red with a commit and asserts which tip the watch names as the culprit. */
export function culpritFixture(): { root: string } {
  const script = `[ -f bad.txt ] && { ${FAILING_OUTPUT}; exit 1; }; echo ok`;
  return { root: baselineFixture("improve", script).root };
}
