/** The repaint loop every `-f/--follow` view shares (`status -f`, `queue -f`,
 * `backlog -f`, `report -f`, `diff -f`): render once, then repaint on a fixed interval until
 * Ctrl+C or the process that started the command exits. Lifted out of
 * cli-query-commands.ts when `report -f` landed so the follow views have one leaf
 * home instead of a per-command copy. */

import { startParentDeathWatch } from "../process/supervisor.js";
import { stripTerminalControls } from "../text/text.js";

/** The default repaint interval for a follow view — a fixed cadence, no knob. */
const FOLLOW_VIEW_INTERVAL_MS = 2000;

/** Test seams for a follow view's repaint interval and parent-death watch, so a test can
 * drive the repaint and its end without waiting on real seconds or a real TTY. */
export interface FollowViewSeams {
  ppid?: () => number;
  intervalMs?: number;
  tty?: boolean;
}

/** A follow view's live loop: render once, then repaint on an interval until Ctrl+C or the
 * process that started this one is gone (the same parent-death rule `logs -f` uses).
 * Repaints in place with the `watch` clear-screen shape on a TTY, and prints frames
 * separated by a blank line when stdout is not a TTY so a piped follow stays readable.
 * The frame text may be read synchronously or async (a `diff -f` frame re-reads the change
 * by running git plumbing). A sync read paints synchronously — each interval tick paints
 * exactly one frame, the deterministic shape the mock-clock follow tests (status, queue,
 * backlog) depend on; an async read is guarded so a slow frame is not stacked by the ticks
 * that arrive while it is still painting. */
export async function followView(frameText: () => string | Promise<string>, seams: FollowViewSeams): Promise<void> {
  const tty = seams.tty ?? process.stdout.isTTY;
  const interval = seams.intervalMs ?? FOLLOW_VIEW_INTERVAL_MS;
  // The frame's text is rendered from model-written data (role live progress, run
  // summaries, backlog titles) that can carry terminal escape sequences. The one-shot
  // forms of these commands sanitize at say(); this live reprint writes raw to the
  // terminal while rerendering its own clear-screen prefix, so it must strip controls
  // itself — the display-boundary rule stripTerminalControls documents, applied here.
  const paint = (text: string): void => {
    const clean = stripTerminalControls(text);
    process.stdout.write(tty ? "\x1b[H\x1b[2J" + clean + "\n" : clean + "\n\n");
  };
  // First paint: render once before the repaint loop's interval is registered, awaiting a
  // slow async read so the first frame is on screen before the loop begins.
  await Promise.resolve(frameText()).then(paint);
  // Repaint on the interval. `painting` guards an async read against stacking frames: while
  // one async frame is in flight, a tick that arrives skips its repaint rather than queueing
  // a second write on top of the first. The guard is checked BEFORE the read, so a tick that
  // lands mid-frame does not start another (git-spawning) read just to discard it — which
  // would also leave that read's rejections unhandled. Sync callers never set `painting`, so
  // the check is a no-op for them: each of their ticks still paints exactly one frame.
  let painting = false;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (painting) return;
      const result = frameText();
      if (result instanceof Promise) {
        painting = true;
        void result
          .then(paint)
          .catch(() => {})
          .finally(() => {
            painting = false;
          });
        return;
      }
      paint(result);
    }, interval);
    startParentDeathWatch(() => {
      clearInterval(timer);
      resolve();
    }, {
      ...(seams.ppid ? { ppid: seams.ppid } : {}),
      ...(seams.intervalMs !== undefined ? { intervalMs: seams.intervalMs } : {}),
    });
  });
}
