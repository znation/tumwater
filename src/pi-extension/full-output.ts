/**
 * Finding the harness root and persisting a complete tool output under it — the filesystem
 * half the two context extensions share: bounded-output writes a bash result pi did not
 * truncate before it is bounded (see bounded-output.ts), and context-shake re-persists a
 * result whose text it is about to elide (context-shake.ts). Both extend a pi run, whose
 * working directory may be the repo checkout or a worktree under it, so the root is found
 * by walking up rather than taken from the caller.
 *
 * Kept apart from the bounding logic on purpose: that logic is pure and filesystem-free so
 * its rules are unit-testable offline, while the root walk and the write are exactly the
 * side effects it must not grow. pi itself loads the bundled extensions, so this stays
 * dependency-free beyond node built-ins and the path helper.
 */

import fs from "node:fs";
import path from "node:path";
import { toolOutputDir } from "../paths.js";

/** Walk up from `startDir` looking for a `.tumwater/` directory — the harness root. Worktrees
 * under it (`.tumwater/worktrees/<role>`, lander, gate alike) reach it three levels up
 * (`../../..`, the repo checkout that owns `.tumwater/`); a harness root carries it directly.
 * Returns null when no ancestor has one, so a bare pi run outside the harness writes nothing.
 * Exported for tests. */
export function findTumwaterRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (fs.statSync(path.join(dir, ".tumwater")).isDirectory()) return dir;
    } catch {
      // Not here — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Persist a full tool output under the harness's gitignored `.tumwater/` area and return
 * its path, or null when there is no harness root (or the write fails). Files are named
 * by `toolCallId` because parallel tool mode can interleave tool_result events. The
 * orchestrator's retention passes prune this directory with the fleet's
 * sessionRetentionDays window (paths.ts's toolOutputDir, the single home of this path that
 * this module shares instead of re-joining it), so a pointer to a full output stays readable
 * while its tick is recent and never accumulates forever. */
export function writeFullOutput(
  text: string,
  toolCallId: unknown,
  startDir: string = process.cwd(),
): string | null {
  const root = findTumwaterRoot(startDir);
  if (!root) return null;
  try {
    const dir = toolOutputDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const id = typeof toolCallId === "string" && toolCallId
      ? toolCallId.replace(/[^\w-]/g, "_")
      : `result-${Date.now()}`;
    const file = path.join(dir, `${id}.log`);
    fs.writeFileSync(file, text, "utf-8");
    return file;
  } catch {
    return null;
  }
}
