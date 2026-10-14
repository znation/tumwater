/**
 * The dashboard's POST operator endpoint namespace (src/gui/gui-server.ts routes to these
 * handlers): one file per domain, each adapting HTTP onto the domain work one layer down, all
 * gathered here. The GET data endpoints (transcript, backlog, report, failures, history, tick,
 * diff, config) stay in gui/gui-endpoints.ts; the shared request-body helpers
 * (readPostBody, readRoleBody, sendRequestResult) live in gui/gui-endpoint-common.ts. The
 * per-domain command modules, each a thin HTTP adapter touching no socket beyond its own `res`:
 * prompt queueing/cancel/edit (gui/gui-prompt-commands), backlog entry file/cancel/edit +
 * question-answer (gui/gui-backlog-commands), config set/unset + budget (gui/gui-config-commands),
 * fleet pause/role-pause/wake (gui/gui-fleet-commands), and operator lifecycle restart/reclaim/
 * abort/reset-counters/stop-schedule/role-notes/brief-edit (gui/gui-operator-commands).
 */
export { handlePrompt, handlePromptRole, handlePromptCancel, handlePromptEdit } from "./gui-prompt-commands.js";
export { handleQuestionAnswer, handleBacklogFile, handleBacklogCancel, handleBacklogEdit } from "./gui-backlog-commands.js";
export { handleConfigSet, handleConfigUnset, handleBudget } from "./gui-config-commands.js";
export { handlePause, handlePauseRole, handleWake, handleWakeCancel } from "./gui-fleet-commands.js";
export { handleResetCounters, handleRestart, handleReclaim, handleAbort, handleStopSchedule, handleRoleNotes, handleBriefEdit } from "./gui-operator-commands.js";
