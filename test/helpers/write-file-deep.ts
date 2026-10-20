import fs from "node:fs";
import path from "node:path";

/** Write `data` to `file`, creating its missing parent directories first — fixture setup for a
 * path whose directory the test has not made. */
export function writeFileDeep(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
