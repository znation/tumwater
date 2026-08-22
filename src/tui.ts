import readline from "node:readline";
import { readEvents, formatEvent } from "./events.js";
import { submitPrompt } from "./inbox.js";
import { clipToWidth, renderStatus, snapshot } from "./status.js";

const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `tumwater run`. */
export async function runTui(root: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("tumwater tui needs an interactive terminal");
  }

  let input = "";
  let flash = "";
  let flashUntil = 0;

  // Every rendered line is clipped to the terminal width (clipToWidth), so one logical
  // line is always one visual line and the height budget below is exact — nothing wraps,
  // nothing scrolls the table off the top.

  const render = () => {
    const rows = process.stdout.rows ?? 40;
    const width = process.stdout.columns ?? 120;
    const snap = snapshot(root);
    const status = renderStatus(root, snap, width);
    const statusLines = status.split("\n").length;
    const eventBudget = Math.max(3, rows - statusLines - 6);
    const events = readEvents(root, eventBudget)
      .map((e) => clipToWidth(formatEvent(e), width))
      .slice(-eventBudget);

    const parts = [
      status,
      "",
      `${BOLD}recent activity${RESET}`,
      events.length ? events.map((e) => `${DIM}${e}${RESET}`).join("\n") : `${DIM}(no events yet)${RESET}`,
      "",
    ];
    if (flash && Date.now() < flashUntil) parts.push(`${BOLD}${clipToWidth(flash, width)}${RESET}`);
    parts.push(
      `${DIM}${clipToWidth("type a prompt for the project, Enter to send · Ctrl+C to quit", width)}${RESET}`,
    );
    // Show the tail of a long prompt so the cursor position stays visible.
    const inputView = input.length > width - 3 ? "…" + input.slice(-(width - 4)) : input;
    parts.push(`> ${inputView}`);
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
      if (key.name === "return") {
        const prompt = input.trim();
        input = "";
        if (prompt) {
          submitPrompt(root, prompt);
          flash = "queued for the director loop";
          flashUntil = Date.now() + 3000;
        }
      } else if (key.name === "backspace") {
        input = input.slice(0, -1);
      } else if (str && !key.ctrl && !key.meta && str >= " ") {
        input += str;
      }
      render();
    });
  });

  clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
}
