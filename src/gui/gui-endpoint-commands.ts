/**
 * The dashboard's POST operator endpoint namespace (src/gui/gui-server.ts routes to these
 * handlers): one file per domain, each adapting HTTP onto the domain work one layer down, all
 * gathered here. The GET data endpoints are barrelled into gui/gui-endpoints.ts from one module
 * per family (gui-history-endpoints, gui-backlog-endpoints, gui-report-endpoints,
 * gui-admin-endpoints); the shared request-body helpers
 * (readPostBody, readRoleBody, sendRequestResult) live in gui/gui-endpoint-common.ts. The
 * per-domain command modules, each a thin HTTP adapter touching no socket beyond its own `res`:
 * prompt queueing/cancel/edit (gui/gui-prompt-commands), backlog entry file/cancel/edit +
 * question-answer (gui/gui-backlog-commands), config set/unset + budget + notify-test
 * (gui/gui-config-commands), team pause/role-pause/wake (gui/gui-team-commands),
 * and operator lifecycle restart/reclaim/abort/reset-counters/stop-schedule/role-notes/
 * retire/brief-edit (gui/gui-operator-commands).
 */
export { handlePrompt, handlePromptRole, handlePromptCancel, handlePromptEdit, handlePromptTop } from "./gui-prompt-commands.js";
export { handleQuestionAnswer, handleBacklogFile, handleBacklogCancel, handleBacklogRelease, handleBacklogTop, handleBacklogEdit } from "./gui-backlog-commands.js";
export { handleConfigSet, handleConfigUnset, handleBudget, handleRoleCap, handleRoleReviewAfterMerge, handleRoleEnable, handleRoleDisable, handleRoleInstances, handleRoleInterval, handleRoleInstructions, handleRoleModel, handleRoleQuietHours, handleNotifyTest } from "./gui-config-commands.js";
export { handlePause, handlePauseRole, handleWake, handleWakeCancel } from "./gui-team-commands.js";
export { handleResetCounters, handleRestart, handleReclaim, handleKillOrphans, handleDropBrokenPins, handleCommitBacklog, handleResyncInstall, handleDoctorReprobe, handleAbort, handleStopSchedule, handleRoleNotes, handleRetire, handleRevert, handleQueueCancel, handleQueueTop, handlePostReviewAccept, handleBriefEdit } from "./gui-operator-commands.js";
