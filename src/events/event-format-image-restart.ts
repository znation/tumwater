import type { HarnessEvent } from "./events.js";
import { commitsBehindPhrase, plural, restartHoldStagePhrase } from "../text/phrases.js";
import { shortSha } from "../text/format.js";
import { textOr } from "../text/text.js";
import { finiteNumber } from "../files/json-object.js";
import { minutes } from "./event-format-fragments.js";

export function imageRestartEventMessage(e: HarnessEvent): string {
  switch (e.type) {
    case "image_blind":
      return imageBlindMessage(e);
    case "image_reroute":
      return imageRerouteMessage(e);
    case "build_stale":
      return buildStaleMessage(e);
    case "restart_pending":
      return restartPendingMessage(e);
    case "restart":
      return restartMessage(e);
    case "restart_refused":
      return restartRefusedMessage(e);
    case "restart_blocked":
      return restartBlockedMessage(e);
    case "restart_forced":
      return restartForcedMessage(e);
    case "supervisor_exit":
      return supervisorExitMessage(e);
    default: return textOr(e.type);
  }
}

function imageBlindMessage(e: HarnessEvent): string {
  // Routine-with-explanation — no warning prefix: the run was stopped (or a gate run
  // noted) because the model cannot see the image. Names the file, the model, and
  // whether the run failed on it or a gate run only logged it.
  const action =
    e.action === "logged"
      ? " (gate run logged)"
      : e.action === "fail"
        ? " — run failed"
        : "";
  return `blind image read: ${textOr(e.path)} on ${textOr(e.model, "the model")}${action}`;
}

function imageRerouteMessage(e: HarnessEvent): string {
  // The run's work moves to a model that can read the image (plans/image-input.md part
  // 4/5). Routine-with-explanation — no warning prefix: names the hop the way the
  // handoff reads, and whether the traits-of-attachment preflight avoided a failed run.
  return e.preflight === true
    ? `image attachment routed to ${textOr(e.to, "the target")} (${textOr(e.tier, "a peer tier")}) to read its image — no failed run`
    : `image rerouted to ${textOr(e.to, "the target")} (${textOr(e.tier, "a peer tier")}) — next run goes there after a blind read on ${textOr(e.from, "the prior model")}`;
}

function buildStaleMessage(e: HarnessEvent): string {
  // Self-hosting teams only (src/redeploy/redeploy.ts): the code main describes is not the
  // code running. Not a warning prefix — a stale build is a state, and auto-restart resolves
  // it.
  return `update available (${commitsBehindPhrase(e.aheadCommits)}) — restarts after cooldown; work continues`;
}

function restartPendingMessage(e: HarnessEvent): string {
  // A self-redeploy holding new runs, one line per step it enters (BuildStatus.restartHold):
  // the step phrase is the build badge's own (restartHoldStagePhrase). A stage-less event
  // predates the hold-begin event and was logged as the compile started.
  if (e.stage === undefined)
    return `restart pending — main ${shortSha(e.head)} is green; finishing current runs (no new runs start)`;
  return `restart pending — holding new runs: ${restartHoldStagePhrase(e.stage, e.head, e.runs)} before restarting${
    e.prewarmed === true ? " (pre-warmed during the cooldown)" : ""
  }`;
}

function restartMessage(e: HarnessEvent): string {
  const aborted = finiteNumber(e.abortedRuns, 0);
  return `restarting onto update ${shortSha(e.to)} (finished current work in ${minutes(e.finishedMs)}m${
      aborted > 0 ? `, ${plural(aborted, "run")} resume after the restart` : ""
    })`;
}

function restartRefusedMessage(e: HarnessEvent): string {
  // The restart is refused, not failed: the running build stays and the gate is re-asked
  // every poll, so the line names both builds and what the operator must repair.
  return `restart onto update ${shortSha(e.to)} refused — the new version could not start here: ${textOr(e.reason)}; staying on version ${shortSha(e.from)} until it can`;
}

function restartBlockedMessage(e: HarnessEvent): string {
  // The restart is blocked, not refused: a verdict latched this head, so the line names
  // what failed and that only main moving can end it.
  return `restart blocked for main ${shortSha(e.to)} — ${textOr(e.reason)}; staying on version ${shortSha(e.from)} until main moves`;
}

function restartForcedMessage(e: HarnessEvent): string {
  // The operator's own override: names the running build, the one fact the type code lacks.
  return `restart forced by you — the update skips its cooldown (running version ${shortSha(e.build)})`;
}

function supervisorExitMessage(e: HarnessEvent): string {
  // The team is DOWN and nothing will bring it back: the one line that must say so, since
  // the dead generation's own stderr reached only the supervisor's terminal.
  const how = e.signal ? `was killed by ${textOr(e.signal)}` : `exited ${textOr(e.code)}`;
  return `tumwater is down — restart ${textOr(e.generation)} ${how}${e.reason ? `: ${textOr(e.reason)}` : ""}; start it again with \`tumwater start\``;
}
