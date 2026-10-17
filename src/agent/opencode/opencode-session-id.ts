// vocabulary: plain
/** Minting an OpenCode session id (plans/opencode-backend.md "Sessions", finding 3) — a pure
 * reproduction of OpenCode's `Identifier.descending()` (packages/schema/src/identifier.ts), so
 * a fresh run's `--session` id is accepted by the free-tier gate. A `ses_…` id in any other
 * shape is refused with a 403 (finding 3), so this must match OpenCode exactly.
 *
 * The id is `ses_` + 12 hex digits + 14 base-62 characters. The hex is the low 48 bits of the
 * bitwise NOT of (Unix milliseconds × 4096 + a per-millisecond counter), big-endian; the 14
 * characters are drawn from `0-9A-Za-z` one random byte each. */

import crypto from "node:crypto";

/** The 62-character alphabet OpenCode draws a session id's trailing characters from. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Per-process minting state, mirroring OpenCode's per-millisecond counter: the counter
 * restarts at 1 for each new millisecond, and increments within the same millisecond so two
 * ids minted in one tick still differ in their hex. */
let lastMintMs = -1;
let counter = 0;

/** Mint an OpenCode session id. `now` is a Unix-millisecond epoch (injected for tests);
 * `randomBytes` supplies the 14 base-62 characters (defaults to `crypto.randomBytes`, so the
 * trailing part is random, never guessed from the visible prefix). */
export function mintOpencodeSessionId(
  now: number = Date.now(),
  randomBytes: (n: number) => Uint8Array = (n) => crypto.randomBytes(n),
): string {
  if (now === lastMintMs) counter += 1;
  else {
    lastMintMs = now;
    counter = 1;
  }
  // `Identifier.descending()`: current = now × 4096 + counter, then the low 48 bits of ~current.
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const hex = ((~current) & 0xffffffffffffn).toString(16).padStart(12, "0");
  const bytes = randomBytes(14);
  let suffix = "";
  for (let i = 0; i < 14; i += 1) {
    suffix += ALPHABET[(bytes[i] as number) % 62];
  }
  return `ses_${hex}${suffix}`;
}
