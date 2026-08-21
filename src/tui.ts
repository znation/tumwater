import readline from "node:readline";
import { readEvents, formatEvent } from "./events.js";
import { submitPrompt } from "./inbox.js";
import { renderStatus, snapshot } from "./status.js";

const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Observer TUI: renders status + recent events from the on-disk state, and feeds
 * typed prompts into the inbox. Works alongside (not instead of) `automaton run`. */
export async function runTui(root: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("automaton tui needs an interactive terminal");
  }

  let input = "";
  let flash = "";
  let flashUntil = 0;

  const render = () => {
    const rows = process.stdout.rows ?? 40;
    const snap = snapshot(root);
    const status = renderStatus(root, snap);
    const statusLines = status.split("\n").length;
    const eventBudget = Math.max(3, rows - statusLines - 6);
    const events = readEvents(root, eventBudget).map(formatEvent).slice(-eventBudget);

    const parts = [
      status,
      "",
      `${BOLD}recent activity${RESET}`,
      events.length ? events.map((e) => `${DIM}${e}${RESET}`).join("\n") : `${DIM}(no events yet)${RESET}`,
      "",
    ];
    if (flash && Date.now() < flashUntil) parts.push(`${BOLD}${flash}${RESET}`);
    parts.push(`${DIM}type a prompt for the project, Enter to send · Ctrl+C to quit${RESET}`);
    parts.push(`> ${input}`);
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
