import fs from "node:fs";
import path from "node:path";
import { inboxDir } from "./paths.js";

/** File-based queue of user prompts for the director loop. Any process can enqueue;
 * the orchestrator pops. Ordering comes from the timestamped filenames. */

let seq = 0;

export function enqueuePrompt(root: string, prompt: string): string {
  const dir = inboxDir(root);
  fs.mkdirSync(dir, { recursive: true });
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

export function inboxSize(root: string): number {
  return queuedFiles(root).length;
}

/** Remove and return the oldest queued prompt, or null when empty. */
export function dequeuePrompt(root: string): string | null {
  const [oldest] = queuedFiles(root);
  if (!oldest) return null;
  const text = fs.readFileSync(oldest, "utf8");
  fs.rmSync(oldest);
  return text;
}
