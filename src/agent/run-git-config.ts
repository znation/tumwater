/** A run's private global git config. Every agent runs with `GIT_CONFIG_GLOBAL` pointing at a
 * file in its private TMPDIR that `[include]`s the global config git would otherwise read, so
 * the run still sees the user's settings (git follows the include whenever it searches every
 * scope: a commit's identity, a bare `git config user.name`), while a `git config --global …`
 * write lands in the run's own file and is removed with the TMPDIR when the run settles.
 *
 * Without it a model's shell writes the user's real ~/.gitconfig. From 2026-10-24 the ci
 * role, executing .github/workflows/ci.yml's run: steps verbatim, ran the workflow's
 * `git config --global user.name "tumwater ci"` identity step on the host, and every repository
 * on the machine committed as `tumwater ci` for two weeks — in other projects too, where GitHub
 * squash-merges then credited "tumwater ci" as a co-author. The prompt now says not to run such
 * steps; this keeps the next model that runs one anyway from reaching outside its run. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { xdgConfigHomeDir } from "../files/files.js";

/** The run's global config file's name inside its TMPDIR: a dotfile, so a model's
 * `rm -rf "$TMPDIR"/*` cleanup does not glob it away mid-run. */
const RUN_GIT_CONFIG_NAME = ".tumwater-gitconfig";

/** The files git reads as the global scope for a process with environment `env`: the file
 * `GIT_CONFIG_GLOBAL` names when set (an outer tumwater run's own file, or the user's
 * override), otherwise the XDG file then `~/.gitconfig`, in git's own order so the latter still
 * wins a conflict. A missing file is listed anyway: git skips an include whose target does not
 * exist, and one created later mid-run is then seen like git would see it. */
export function globalGitConfigFiles(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.GIT_CONFIG_GLOBAL;
  if (explicit !== undefined && explicit !== "") return [explicit];
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : os.homedir();
  return [path.join(xdgConfigHomeDir(env, home), "git", "config"), path.join(home, ".gitconfig")];
}

/** A git config value quoted so any path survives the parser: backslash, double quote and
 * newline are the characters a quoted value must escape. */
function quoteConfigValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Write the run's global git config into `runTmp` and return the environment entry that points
 * git at it. `env` is the environment the backend built for the child, so the include names the
 * files the child's git would otherwise have read as its global config. */
export function runGitConfigEnv(runTmp: string, env: NodeJS.ProcessEnv): { GIT_CONFIG_GLOBAL: string } {
  const file = path.join(runTmp, RUN_GIT_CONFIG_NAME);
  const includes = globalGitConfigFiles(env).map((f) => `\tpath = ${quoteConfigValue(f)}\n`);
  const content =
    "# tumwater: this run's global git config. Reads include the user's global config\n" +
    "# below; a `git config --global` write lands in this file and is removed with the run.\n" +
    `[include]\n${includes.join("")}`;
  fs.writeFileSync(file, content);
  return { GIT_CONFIG_GLOBAL: file };
}
