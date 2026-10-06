import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./files/json-files.js";
import { errorMessage } from "./text/text.js";

/** The running harness's own version, read from its package.json — the one bare JSON read
 * the CLI dispatches through. Split out of cli.ts so the failure shapes are unit-testable:
 * cli.ts runs main() on import, so no test can import it. */

/** The running harness's package.json, beside the compiled CLI: the version command's read,
 * the CLI's startup Node-floor gate, and doctor's runtime check share one path so the URL
 * arithmetic cannot drift. */
export const PACKAGE_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));

/** What packageVersion decided: the version to print, or why it could not answer. */
interface PackageVersion {
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

/** Read `file`'s engines.node spec — the Node floor the harness declares, the one source the
 * CLI's startup gate and doctor's runtime check compare against. Tolerant like packageVersion:
 * a missing, unreadable, or malformed file and a missing or non-string engines.node return
 * null, and the gate stands down rather than blocking every command on a floor it cannot
 * evaluate (npm already warned about the mismatch at install time; a broken install is the
 * version command's story, not a runtime verdict). The read routes through readJsonFile so
 * the tolerant read/parse/no-data policy has one home; unlike packageVersion below it needs
 * no distinction between the failure modes, so it needs no error of its own. */
export function packageEnginesNode(file: string): string | null {
  const node = readJsonFile<{ engines?: { node?: unknown } }>(file)?.engines?.node;
  return typeof node === "string" && node !== "" ? node : null;
}

/** Is `version` (e.g. "18.20.4") below the `>=` floor a package.json engines spec declares
 * (e.g. ">=20.3")? A component-wise numeric comparison, so 20.3.0 satisfies ">=20.3" and
 * 20.2.9 does not; a missing minor or patch reads as 0 on either side, so "20" compares as
 * 20.0.0. A spec or version neither side can parse (an engines spec npm itself would reject,
 * a version string that is not dotted integers) returns false — the floor check never
 * blocks on input it cannot interpret. */
export function belowNodeFloor(version: string, floor: string): boolean {
  const spec = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(floor.trim());
  const ver = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!spec || !ver) return false;
  const floorParts = [1, 2, 3].map((i) => Number(spec[i] ?? 0));
  const verParts = [1, 2, 3].map((i) => Number(ver[i] ?? 0));
  for (let i = 0; i < 3; i++) {
    if (verParts[i] !== floorParts[i]) return verParts[i]! < floorParts[i]!;
  }
  return false;
}

/** The CLI startup gate's message when the running Node is below the declared floor —
 * undefined when it satisfies the floor, or when either string is unparseable (see
 * belowNodeFloor). Worded for the operator: what is required, what was found, the fix. */
export function nodeFloorProblem(version: string, floor: string): string | undefined {
  if (!belowNodeFloor(version, floor)) return undefined;
  return `tumwater needs Node ${floor} (found v${version}) — upgrade Node, then run tumwater again`;
}
