/** The doctor's `root install` row, in its own module so the check that reads the install drift
 * stays apart from the environment and repo-file checks in doctor-checks.ts. */
import fs from "node:fs";
import path from "node:path";
import { installDrift } from "../build/dep-install.js";
import { readEventsSince } from "../events/event-window.js";
import { DAY_MS } from "../text/datetime.js";
import { plural, shortSpanPhrase } from "../text/phrases.js";
import { errorMessage, textOr } from "../text/text.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./doctor-outcome.js";

/** How far back a failed `dep_install` event may sit and still explain the drift. */
const DEP_INSTALL_CHECK_WINDOW_MS = DAY_MS;

/** Whether the root checkout's node_modules still matches package-lock.json's direct pins. A failed
 * post-merge re-sync (syncRootInstall) leaves the root behind, and every check then installs into
 * its own tree until a later merge retries, so the warn names the last failed `dep_install` event
 * inside DEP_INSTALL_CHECK_WINDOW_MS when one explains the drift. ok when nothing is pinned or
 * nothing drifts; warn otherwise — never a fail. */
export function checkRootInstall(root: string, now = Date.now()): CheckOutcome {
  if (!fs.existsSync(path.join(root, "package-lock.json")))
    return okOutcome("no package-lock.json — nothing pinned");
  const drift = installDrift(root);
  if (drift.length === 0) return okOutcome("node_modules matches package-lock.json");
  let detail = `${plural(drift.length, "direct dependency", "direct dependencies")} not installed as package-lock.json pins (${drift.join(", ")}) — run npm install in ${root}; until then each check installs into its own tree`;
  try {
    const installs = readEventsSince(root, DEP_INSTALL_CHECK_WINDOW_MS).events.filter(
      (ev) => ev.type === "dep_install",
    );
    const ev = installs[installs.length - 1];
    if (ev?.status === "failed")
      detail += `; the last re-sync failed ${shortSpanPhrase(now - ev.ts)} ago: ${textOr(ev.error)}`;
  } catch (err) {
    detail += `; could not read the event log: ${errorMessage(err)}`;
  }
  return warnOutcome(detail);
}
