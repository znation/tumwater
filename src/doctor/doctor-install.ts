/** The doctor's `root install` row: whether the root checkout's node_modules still matches
 * package-lock.json's direct pins. A failed post-merge re-sync (syncRootInstall) leaves the root
 * behind, and every check then installs into its own tree until a later merge retries. */
import fs from "node:fs";
import path from "node:path";
import { installDrift } from "../build/dep-install.js";
import { readEventsSince } from "../events/event-window.js";
import { plural, shortSpanPhrase } from "../text/phrases.js";
import { errorMessage, textOr } from "../text/text.js";
import { type CheckOutcome, okOutcome, warnOutcome } from "./outcome.js";

/** How far back a failed `dep_install` event may sit and still explain the drift. */
const DEP_INSTALL_CHECK_WINDOW_MS = 24 * 3600_000;

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
