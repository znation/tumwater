/** The model check's probe (src/model-check/model-check.ts holds the per-pair state machine,
 * model-check-gate.ts the per-poll wiring): one short prompt with a known one-word answer, sent
 * to a provider/model pair through the same backend path its runs take (runAgent — pi, claude,
 * opencode or codex alike), and the verdict on what came back. The question is "can this pair
 * answer at all", not "is it smart": a serving fault looks exactly like a model that keeps
 * finishing without changes, so the team kept running on it until someone read a transcript
 * (2026-10-30 Flint: llama.cpp's Metal flash-attention prefill returned word salad for any
 * prompt past a few dozen tokens; 2026-10-29: deepinfra accepted requests and never answered).
 * The prompt is a few hundred tokens on purpose: a prompt under ~32 tokens took a different,
 * working kernel path on Flint and would have passed. */

import type { ResolvedModelConfig } from "../config/config-views.js";
import { seamPairName } from "../config/config-views.js";
import type { PiRunResult } from "../pi/pi-run-result.js";
import { runAgent } from "../agent/agent-run.js";
import { ensureDir, removeTree } from "../files/files.js";
import {
  MODEL_CHECK_RUN_NAME,
  modelCheckSessionDir,
  modelCheckWorkDir,
  nativeLogPath,
  piLogPath,
} from "../paths.js";
import { errorMessage, squash } from "../text/text.js";

/** The probe's question, whose answer is in the paragraph and nowhere else: the river is made
 * up, so no model answers from memory and no broken one lands on the word by chance. About 230
 * tokens. Fakes recognize a probe by MODEL_CHECK_MARKER, so keep that phrase in it. */
export const MODEL_CHECK_PROMPT = [
  "The Varrow is a small river in the uplands of a country that appears on no map. It rises in a",
  "peat bog below the Pellen Hills, at about six hundred metres, and runs north-east through a",
  "narrow wooded valley for roughly one hundred and forty kilometres. Along the way it turns three",
  "old mills, passes under eleven stone bridges and feeds the reservoir that supplies the market",
  "town of Callow. Below Callow the valley opens out, the current slows and the river begins to",
  "meander across wide water meadows that flood most winters. Herons, kingfishers and otters are",
  "common there, and the lower reach is popular with anglers for its brown trout. About twenty",
  "kilometres further on, at the village of Ostry, the Varrow meets a much larger river, the",
  "Isselmar, and joins it; from there the combined water flows on to the sea.",
  "",
  "Question: which river does the Varrow join? Reply with that river's name only, as one word.",
  "Do not use any tools.",
].join("\n");

/** The phrase test fakes match to tell a probe from a role run. */
export const MODEL_CHECK_MARKER = "which river does the Varrow join?";

/** The answer a working model gives. */
export const MODEL_CHECK_ANSWER = "Isselmar";

const ANSWER_RE = new RegExp(`\\b${MODEL_CHECK_ANSWER}\\b`, "i");

/** How much of a wrong reply the warning, the doctor row and the alert quote. */
export const REPLY_EXCERPT_CHARS = 120;

/** The wall-clock budget of one probe. A healthy pair answers in seconds (a local model's
 * prefill plus one word, or a hosted model's queue); five minutes leaves room for a cold local
 * server loading its weights and for a thinking model, while a pair that has not answered by
 * then is held, not waited on — the re-check retries it. */
const MODEL_CHECK_TIMEOUT_S = 300;

/** What one probe found. `ok: null` is no evidence either way: the probe was aborted (the team
 * is stopping), so nothing is recorded. A failure's `reply` is the excerpt of the text that
 * came back (empty when none did) and `detail` the run's own error, when it had one. */
export type ModelCheckVerdict =
  | { ok: true }
  | { ok: false; reason: "no reply" | "wrong answer"; reply: string; detail?: string }
  | { ok: null };

/** The verdict on one probe run: the reply names the river, or it does not (`wrong answer`,
 * quoting the first REPLY_EXCERPT_CHARS of it), or nothing came back (`no reply`, with the
 * run's error, timeout or exit as the detail). */
export function judgeModelReply(result: PiRunResult): ModelCheckVerdict {
  if (result.aborted) return { ok: null };
  const text = result.finalText.trim();
  if (text !== "" && ANSWER_RE.test(text)) return { ok: true };
  if (text !== "") return { ok: false, reason: "wrong answer", reply: squash(text, REPLY_EXCERPT_CHARS) };
  const detail = result.timedOut
    ? `no answer within ${MODEL_CHECK_TIMEOUT_S}s`
    : result.quietKilled
      ? "the backend went quiet"
      : result.errorMessage
        ? squash(result.errorMessage, REPLY_EXCERPT_CHARS)
        : undefined;
  return { ok: false, reason: "no reply", reply: "", ...(detail !== undefined ? { detail } : {}) };
}

/** A pair name as a path segment: anything outside [A-Za-z0-9._-] becomes `_`. */
function pairSlug(pair: string): string {
  return pair.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Probe one seam: run MODEL_CHECK_PROMPT through the seam's own backend (runAgent, the path
 * every role run takes) in a scratch dir under `.tumwater`, with a fresh session that is
 * removed afterwards, and judge the reply. The probe's transcript lands in
 * `.tumwater/log/_model-check.pi.jsonl` beside the roles' own. Never throws: a run that could
 * not start reads as `no reply` with its error. */
export async function runModelCheck(
  root: string,
  seam: ResolvedModelConfig,
  signal: AbortSignal,
): Promise<ModelCheckVerdict> {
  const pair = seamPairName(seam);
  const sessionDir = modelCheckSessionDir(root, `${pairSlug(pair)}-${Date.now()}`);
  try {
    const cwd = modelCheckWorkDir(root);
    ensureDir(cwd);
    const result = await runAgent({
      cwd,
      prompt: MODEL_CHECK_PROMPT,
      config: {
        ...seam,
        runTimeoutSeconds: Math.min(seam.runTimeoutSeconds, MODEL_CHECK_TIMEOUT_S),
        quietTimeoutSeconds: Math.min(seam.quietTimeoutSeconds, MODEL_CHECK_TIMEOUT_S),
      },
      sessionDir,
      sessionName: MODEL_CHECK_RUN_NAME,
      rawLogFile: piLogPath(root, MODEL_CHECK_RUN_NAME),
      nativeLogFile: nativeLogPath(root, MODEL_CHECK_RUN_NAME, seam.agent ?? "pi"),
      signal,
      kind: "gate",
      label: `model check ${pair}`,
    });
    return judgeModelReply(result);
  } catch (err) {
    return { ok: false, reason: "no reply", reply: "", detail: squash(errorMessage(err), REPLY_EXCERPT_CHARS) };
  } finally {
    try {
      removeTree(sessionDir);
    } catch {
      // A leftover probe session is pruned with the rest by the session retention.
    }
  }
}
