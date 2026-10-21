/** The repaint loop every `-f/--follow` view shares (`status -f`, `queue -f`,
 * `backlog -f`, `report -f`): render once, then repaint on a fixed interval until
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
 * separated by a blank line when stdout is not a TTY so a piped follow stays readable. */
export async function followView(frameText: () => string, seams: FollowViewSeams): Promise<void> {
  const tty = seams.tty ?? process.stdout.isTTY;
  const interval = seams.intervalMs ?? FOLLOW_VIEW_INTERVAL_MS;
  const frame = (): void => {
    // The frame's text is rendered from model-written data (role live progress, run
    // summaries, backlog titles) that can carry terminal escape sequences. The one-shot
    // forms of these commands sanitize at say(); this live reprint writes raw to the
    // terminal while rerendering its own clear-screen prefix, so it must strip controls
    // itself — the display-boundary rule stripTerminalControls documents, applied here.
    const text = stripTerminalControls(frameText());
    process.stdout.write(tty ? "\x1b[H\x1b[2J" + text + "\n" : text + "\n\n");
  };
  frame();
  await new Promise<void>((resolve) => {
    const timer = setInterval(frame, interval);
    startParentDeathWatch(() => {
      clearInterval(timer);
      resolve();
    }, {
      ...(seams.ppid ? { ppid: seams.ppid } : {}),
      ...(seams.intervalMs !== undefined ? { intervalMs: seams.intervalMs } : {}),
    });
  });
}
