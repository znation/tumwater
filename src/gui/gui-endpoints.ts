/**
 * The dashboard's GET data endpoint handlers (src/gui/gui-server.ts routes to them), gathered
 * from the per-family modules gui-history-endpoints (transcript, history, logs, run, role),
 * gui-backlog-endpoints (backlog, backlog-match, diff), gui-report-endpoints (report,
 * failures), and gui-admin-endpoints (prompt-text, doctor, config, retire-list, brief) — the
 * read-only surface, split one family per file the way the POST side keeps a file per command
 * domain. The per-family modules adapt HTTP onto the domain work a layer down; server
 * lifecycle, routing, the static page, and the token gate stay in gui/gui-server.ts.
 */
export { handleTranscript, handleHistory, handleLogs, handleRun, handleRole } from "./gui-history-endpoints.js";
export { handleBacklog, handleBacklogMatch, handleDiff } from "./gui-backlog-endpoints.js";
export { handleReport, handleFailures } from "./gui-report-endpoints.js";
export { handlePromptText, handleDoctor, handleConfig, handleRetireList, handleBrief } from "./gui-admin-endpoints.js";
