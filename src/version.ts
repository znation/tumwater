import fs from "node:fs";

import { errorMessage } from "./text.js";

/** The running harness's own version, read from its package.json — the one bare JSON read
 * the CLI dispatches through. Split out of cli.ts so the failure shapes are unit-testable:
 * cli.ts runs main() on import, so no test can import it. */

/** What packageVersion decided: the version to print, or why it could not answer. */
export interface PackageVersion {
  /** The `version` field's value — a non-empty string, set exactly when there is no problem. */
  version?: string;
  /** The reason the file could not answer: unreadable, malformed JSON, or a missing/blank
   * version field. Worded for the operator: a broken install is the story, not the stack. */
  problem?: string;
}

/** Read `file`'s version field. A missing or unreadable package.json (a half-pruned global
 * install, a hand-copied dist/ without its root) and a malformed one return a problem instead
 * of throwing, and a non-string or empty version fails the same way — printing "undefined"
 * would masquerade as an answer. `JSON.parse("null")` and a top-level array read the same as
 * any other shape without the field. */
export function packageVersion(file: string): PackageVersion {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return {
      problem: `cannot read package.json (the running harness's install looks broken): ${errorMessage(err)}`,
    };
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version === "")
    return { problem: "package.json carries no version field (the running harness's install looks broken)" };
  return { version };
}
