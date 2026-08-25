import readline from "node:readline";
import { readEvents } from "./events.js";
import { formatEvent } from "./event-format.js";
import { submitPrompt } from "./inbox.js";
import { snapshot } from "./status.js";
import { clipToWidth, renderStatus } from "./status-render.js";
import { readTranscript } from "./transcript.js";

const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** The key fields applyKey cares about (a structural subset of readline.Key, so tests can
 * pass plain objects without a TTY). */
export interface KeyLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** Apply one keypress to the prompt text (pure, so it is unit-testable without a TTY).
 * Printable characters insert at the cursor; backspace deletes before it, delete after it,
 * and left/right move it. Control/meta combinations are ignored. Returns the new state;
 * an out-of-range cursor is clamped instead of corrupting the edit. */
export function applyKey(
  text: string,
  cursor: number,
  str: string | undefined,
  key: KeyLike,
): { text: string; cursor: number } {
  const c = Math.max(0, Math.min(cursor, text.length));
  switch (key.name) {
    case "left":
      return { text, cursor: Math.max(0, c - 1) };
    case "right":
      return { text, cursor: Math.min(text.length, c + 1) };
    case "backspace":
      if (c === 0) return { text, cursor: 0 };
      return { text: text.slice(0, c - 1) + text.slice(c), cursor: c - 1 };
    case "delete":
      if (c >= text.length) return { text, cursor: c };
      return { text: text.slice(0, c) + text.slice(c + 1), cursor: c };
  }
  if (str && !key.ctrl && !key.meta && str >= " ") {
    return { text: text.slice(0, c) + str + text.slice(c), cursor: c + 1 };
  }
  return { text, cursor: c };
}

/** The visible slice of the prompt line for a terminal `width` columns: the whole text
 * when it fits, otherwise a window that keeps the cursor at (or near) the right edge so
 * mid-text edits stay visible. With the "> " prefix the rendered line never exceeds
 * `width` columns for width >= 4, preserving the one-logical-line-per-visual-line invariant.
 */
export function renderInputView(text: string, cursor: number, width: number): string {
  const room = Math.max(1, width - 3); // headroom for the "> " prefix and a leading ellipsis
  if (text.length <= room) return text;
  const start = Math.max(0, Math.min(cursor - (room - 1), text.length - room));
  return (start > 0 ? "…" : "") + text.slice(start, start + room);
}

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `tumwater run`. */
export async function runTui(root: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tumwater tui needs an interactive terminal");
  }

  let input = "";
  let cursor = 0;
  let flash = "";
  let flashUntil = 0;
  // The activity pane cycles: 0 = recent events, then one transcript per loop (Ctrl+T).
  let view = 0;
  let roleIds: string[] = [];

  // Every rendered line is clipped to the terminal width (clipToWidth), so one logical
  // line is always one visual line and the height budget below is exact — nothing wraps,
  // nothing scrolls the table off the top.

  const render = () => {
    const rows = process.stdout.rows ?? 40;
    const width = process.stdout.columns ?? 120;
    const snap = snapshot(root);
    roleIds = snap.loops.map((s) => s.role);
    view = Math.min(view, roleIds.length); // clamp a stale index if roles changed
    const status = renderStatus(root, snap, width);
    const statusLines = status.split("\n").length;
    const eventBudget = Math.max(3, rows - statusLines - 6);
    // The pane occupies the same slot as recent activity: one header line plus at most
    // eventBudget clipped lines, so the height-budget math is unchanged either way.
    let header: string;
    let body: string[];
    const role = view > 0 ? roleIds[view - 1] : undefined; // defined: view is clamped above
    if (role) {
      header = `${BOLD}${clipToWidth(`transcript: ${role} — Ctrl+T to cycle`, width)}${RESET}`;
      body = readTranscript(root, role, eventBudget)
        .map((l) => clipToWidth(l, width))
        .slice(-eventBudget);
    } else {
      header = `${BOLD}recent activity${RESET}`;
      body = readEvents(root, eventBudget)
        .map((e) => clipToWidth(formatEvent(e), width))
        .slice(-eventBudget);
    }

    const parts = [
      status,
      "",
      header,
      body.length ? body.map((l) => `${DIM}${l}${RESET}`).join("\n") : view > 0 ? `${DIM}(no transcript yet)${RESET}` : `${DIM}(no events yet)${RESET}`,
      "",
    ];
    if (flash && Date.now() < flashUntil) parts.push(`${BOLD}${clipToWidth(flash, width)}${RESET}`);
    parts.push(
      `${DIM}${clipToWidth("type a prompt for the project, Enter to send · Ctrl+C to quit", width)}${RESET}`,
    );
    // Window long prompts around the cursor so its position stays visible.
    parts.push(`> ${renderInputView(input, cursor, width)}`);
    process.stdout.write(CLEAR + parts.join("\n"));
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const timer = setInterval(render, 1000);
  render();

  await new Promise<void>((resolve) => {
    process.stdin.on("keypress", (str: string | undefined, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        resolve();
        return;
      }
      if (key.ctrl && key.name === "t") {
        view = (view + 1) % (roleIds.length + 1); // events → each loop's transcript → events
        render();
        return;
      }
      if (key.name === "return") {
        const prompt = input.trim();
        input = "";
        cursor = 0;
        if (prompt) {
          submitPrompt(root, prompt);
          flash = "queued for the director loop";
          flashUntil = Date.now() + 3000;
        }
      } else {
        const next = applyKey(input, cursor, str, key);
        input = next.text;
        cursor = next.cursor;
      }
      render();
    });
  });

  clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
}
