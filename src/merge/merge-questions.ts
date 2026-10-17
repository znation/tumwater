import { openQuestions } from "../backlog/backlog.js";
import { logEventBestEffort } from "../events/events.js";

/** Emit one `question_posted` event per entry QUESTIONS.md's ## Open gained since `before` —
 * the capture-and-diff both merge paths record alongside their `merged` events (merge-to-main.ts's
 * tryMerge and merge-stack.ts's ffStackToMain). The capture (`openQuestions(root)` under the
 * merge lock, before the ff) stays with the callers: the lock window is theirs to define, and the
 * diff is only exact while the capture and this call share it. Best-effort: the questions have
 * already been posted to QUESTIONS.md and main already fast-forwarded, so an unwritable feed
 * must not reject the landing around it. `position` is the entry's 1-based place in ## Open (the
 * `<n>` `tumwater questions answer` takes now) and `open` is the list's length, so the page can
 * name the answering command (merge-to-main.ts's tryMerge, merge-stack.ts). */
export function logNewQuestions(root: string, before: string[], role: string): void {
  const titles = openQuestions(root);
  titles.forEach((question, index) => {
    if (!before.includes(question)) {
      logEventBestEffort(root, { source: role, type: "question_posted", question, position: index + 1, open: titles.length });
    }
  });
}
