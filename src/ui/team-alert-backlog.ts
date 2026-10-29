/** The backlog team alerts, in emission order: open questions, refused entries. The two
 * per-domain builders split out of src/ui/team-alerts.ts; the shared types and wording helpers
 * live in team-alert-shared.ts. The stale questions, stalled entries, plan dependencies,
 * stranded plans, duplicated headings, live finished history, validation gaps and false fixes
 * banners moved to `tumwater doctor` rows (Subtract part 1e/6), each printing its row. */

import { entryListDetail, openBacklogAction, type TeamAlert } from "./team-alert-shared.js";
import { entryKindLabel, type RefusedEntry } from "../backlog/backlog-eligibility.js";
import { plural } from "../text/phrases.js";

interface BacklogAlertsInput {
  questions: readonly string[];
  refused: readonly RefusedEntry[];
}

function pushQuestionsAlert(out: TeamAlert[], questions: readonly string[]): void {
  if (questions.length) {
    out.push({
      key: "questions",
      tone: "indigo",
      title: `${plural(questions.length, "question needs", "questions need")} your answer`,
      detail: entryListDetail(questions),
      actions: [{ label: "Answer", act: "questions" }],
    });
  }
}

// Refused entries hold until a human decides; amber because the operator has to act.
function pushRefusedAlert(out: TeamAlert[], refused: readonly RefusedEntry[]): void {
  if (refused.length) {
    const first = refused[0]!;
    out.push({
      key: "refused",
      tone: "amber",
      title: `${plural(refused.length, "refused entry waits", "refused entries wait")} on your decision`,
      detail: `Refused ${entryKindLabel(first.file).toLowerCase()}: ${entryListDetail(refused.map((r) => r.title))} · no role takes it until you release it (tumwater plan|bug --release <n>, or the entry's drawer) or cancel it`,
      actions: openBacklogAction(first),
    });
  }
}

/** The backlog alerts, in emission order: open questions, refused entries. The conditions that
 * used to raise the removed backlog banners each print their `tumwater doctor` row instead
 * (Subtract part 1e/6). Extracted from teamAlerts (part 2/5 of the teamAlerts split) so the
 * shared module stays small; the input names exactly the fields this run reads. The caller
 * pushes the returned alerts at the position this run used to occupy, so the emitted key order
 * is unchanged. Each alert arm is a module-private builder named for its alert, in this same
 * emission order, so a backlog alert is found by name. */
export function buildBacklogAlerts(input: BacklogAlertsInput): TeamAlert[] {
  const out: TeamAlert[] = [];
  const { questions, refused } = input;
  pushQuestionsAlert(out, questions);
  pushRefusedAlert(out, refused);
  return out;
}
