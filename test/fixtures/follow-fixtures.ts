/** Follow-view seam fixtures shared by the `-f/--follow` tests so the one-line test seam
 * literal lives in one place. `followSeams` spells the shape those tests use — a parent-death
 * watch (`ppid`), a fast 5 ms repaint cadence (`intervalMs`), and no live TTY (`tty: false`) —
 * with only `ppid` varying (most tests pass `() => parent.value` so a `flipParent` in the body
 * can kill the poll). A fresh object per call, so a seam cannot leak across tests.
 *
 * Deliberately NOT a stand-in for (kept as inline literals): a seam that keeps the live TTY
 * (`tty: true`), one that omits `tty` to exercise the `?? isTTY` default, or one that widens
 * `intervalMs` (a deliberate slower cadence) — those set a value, not the common stand-in. */
import type { FollowViewSeams } from "../../src/follow-view.js";

export function followSeams(ppid: () => number): FollowViewSeams {
  return { ppid, intervalMs: 5, tty: false };
}
