/** The tests' single home for "read a JSON file and parse it": the
 * readFileSync(…, "utf8") + JSON.parse dance that 62 call sites across the suite hand-rolled
 * when this was factored out (2026-09-30). Strict on purpose — unlike src/src/files/json-files.ts's tolerant readJsonFile (a missing
 * or torn marker file is "no data", never an error), a test that reads state a process under
 * test was supposed to write WANTS the failure: a missing file or a syntax error must fail
 * the test loudly, not masquerade as an empty result behind a swallowed throw. So a read or
 * parse error throws with the file path named, which raw JSON.parse's "Unexpected end of
 * JSON input" never did. Call sites keep their own `as T` cast (or pass T explicitly) — the
 * shapes asserted per test differ, and the cast is the test's claim about the file, not part
 * of the shared dance. The `string | URL` parameter mirrors fs.readFileSync so callers can
 * pass a `new URL("…", import.meta.url)` without a fileURLToPath detour. */
import fs from "node:fs";

import { errorMessage } from "../src/text/text.js";

export function readJson<T = unknown>(file: string | URL): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file} (expected JSON a fleet process wrote): ${errorMessage(err)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(err)}`);
  }
}
