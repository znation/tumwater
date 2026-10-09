import { openQuestions } from "../backlog/backlog.js";
import { logEventBestEffort } from "../events/events.js";

/** Emit one `question_posted` event per entry QUESTIONS.md's ## Open gained since `before` —
 * the capture-and-diff both merge paths record alongside their `merged` events (landing-merge.ts's
 * tryMerge and landing-stack.ts's ffStackToMain). The capture (`openQuestions(root)` under the
 * merge lock, before the ff) stays with the callers: the lock window is theirs to define, and the
 * diff is only exact while the capture and this call share it. Best-effort: the questions have
 * already been posted to QUESTIONS.md and main already fast-forwarded, so an unwritable feed
 * must not reject the landing around it (landing-merge.ts's tryMerge, landing-stack.ts). */
export function logNewQuestions(root: string, before: string[], role: string): void {
  for (const question of openQuestions(root)) {
    if (!before.includes(question)) {
      logEventBestEffort(root, { loop: role, type: "question_posted", question });
    }
  }
}
