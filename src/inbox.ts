import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./files.js";
import { logEvent } from "./events.js";
import { inboxDir } from "./paths.js";
import { DIRECTOR_ROLE } from "./roles.js";
import { truncate } from "./text.js";

/** File-based queue of user prompts for the director loop. Any process can enqueue;
 * the orchestrator pops. Ordering comes from the timestamped filenames. */

/** Cap on a queued prompt's one-line preview, so an over-long prompt cannot bloat an event
 * log line, the dashboard payload, or the CLI output. */
const PROMPT_PREVIEW_MAX = 80;

/** One-line preview of a queued prompt — the single width shared by the prompt_enqueued and
 * prompt_cancelled event previews (this module), the dashboards' inboxPrompts (status.ts), and
 * the CLI's cancel output (cli.ts). Surrogate-safe via truncate: an over-long prompt is marked
 * with an ellipsis like every other label and never carries a lone surrogate at the cut point. */
export function promptPreview(text: string): string {
  return truncate(text, PROMPT_PREVIEW_MAX);
}

let seq = 0;

/** Append a prompt to the queue as one timestamped file (creating the inbox dir if needed)
 * and return its path. The filename orders prompts across processes by wall-clock time; the
 * per-process counter and pid break ties within one process. No event is logged — submitPrompt
 * is the user-facing wrapper that adds the prompt_enqueued line, and loop.ts's re-queue of an
 * unfulfilled director prompt calls this directly. */
export function enqueuePrompt(root: string, prompt: string): string {
  const dir = inboxDir(root);
  ensureDir(dir);
  // Timestamp orders across processes; the counter orders within one; pid breaks ties.
  const name = `${Date.now()}-${String(seq++).padStart(6, "0")}-${process.pid}.md`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, prompt);
  return file;
}

function queuedFiles(root: string): string[] {
  const dir = inboxDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Number of prompts currently queued — a directory listing only; no file content is read.
 * A missing inbox dir reads as 0, like queuedPrompts and dequeuePrompt. */
export function inboxSize(root: string): number {
  return queuedFiles(root).length;
}

/** Full text of every queued prompt in execution order (oldest first) — the same filename
 * sort dequeuePrompt pops by. A missing inbox directory reads as an empty queue, like
 * inboxSize and dequeuePrompt. */
export function queuedPrompts(root: string): string[] {
  return queuedFiles(root).map((f) => fs.readFileSync(f, "utf8"));
}

/** Outcome of cancelPrompt: the cancelled prompt's text, or "gone" when the director dequeued
 * it between listing and removal (a concurrent pop is a normal race, not an error). */
export type CancelOutcome = { status: "cancelled"; text: string } | { status: "gone" };

/** Remove the Nth queued prompt — 1-based, as shown by `tumwater prompt --list` — and log one
 * prompt_cancelled event under the director loop (preview via promptPreview, exactly like its
 * prompt_enqueued sibling). Throws for out-of-range positions with no side effects; returns
 * { status: "gone" } when the file disappears between listing and removal instead of throwing.
 * The event is logged only after a successful removal — a prompt the director just dequeued
 * ran, it was not cancelled. */
export function cancelPrompt(root: string, position: number): CancelOutcome {
  const files = queuedFiles(root);
  if (position < 1 || position > files.length) {
    throw new Error(`no prompt at position ${position} (${files.length} queued)`);
  }
  const file = files[position - 1];
  if (!file) throw new Error(`no prompt at position ${position} (${files.length} queued)`); // Unreachable: the range check above.
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "gone" };
    throw err;
  }
  try {
    fs.rmSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "gone" };
    throw err;
  }
  logEvent(root, { loop: DIRECTOR_ROLE, type: "prompt_cancelled", preview: promptPreview(text) });
  return { status: "cancelled", text };
}

/** Remove and return the oldest queued prompt, or null when empty. */
export function dequeuePrompt(root: string): string | null {
  const [oldest] = queuedFiles(root);
  if (!oldest) return null;
  const text = fs.readFileSync(oldest, "utf8");
  fs.rmSync(oldest);
  return text;
}

/** A user submits a new prompt (TUI, GUI, or CLI): enqueue it for the director and
 * record it in the event log. Returns the trimmed prompt that was queued. The logged preview
 * goes through promptPreview — not a raw slice — so an over-long prompt is marked with an
 * ellipsis like every other label and never carries a lone surrogate at the cut point. */
export function submitPrompt(root: string, text: string): string {
  const prompt = text.trim();
  enqueuePrompt(root, prompt);
  logEvent(root, { loop: DIRECTOR_ROLE, type: "prompt_enqueued", preview: promptPreview(prompt) });
  return prompt;
}
