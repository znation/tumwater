# Plans

Planned features, written by the plan loop and implemented by the feature loop.
Each plan: goal, approach, files touched, acceptance criteria. Move finished plans to Done;
tumwater then archives them in PLANS-DONE.md, so this file holds only open work.

## Planned

### TUI Transcript change step Ctrl+Y shows the viewed role's diffstat instead of its full patch, and the full patch again on a second press: the terminal twin of `tumwater diff --role <id> --stat` and the dashboard drawer's Stat only toggle (planned 2026-10-20 by the plan role; independent of every eligible plan: the TUI Inbox `/` search plan edits the `/` plumbing and the Inbox hint line, and the TUI Pending Ctrl+G plan edits the Ctrl+G route and the Pending hint line, both in src/ui/tui/tui-panes.ts and src/ui/tui/tui-frame.ts. This plan edits only the Ctrl+Y route and the transcript hint line there, so at most a neighbouring-line rebase. The role-less `/api/run?last=1` plan touches src/gui and src/run only. Touches src/ui/tui/tui-pane-transcript.ts, src/ui/tui/tui-panes.ts, src/ui/tui/tui-keys.ts, src/ui/tui/tui-pane-session.ts, src/ui/tui/tui-frame.ts, src/ui/tui/tui.tsx, docs/cli.md, test/tui-keys.test.ts and test/tui-frame.test.ts)

**Goal.** A role's Transcript view cycles transcript → notes → change with Ctrl+N (`createTranscriptPane` in src/ui/tui/tui-pane-transcript.ts). The change step always renders the full patch (`session.collectChange(session.root, target)` then `renderRoleChange`). The CLI has `diff --role <id> --stat`, and the dashboard drawer gained a Stat only toggle (`GET /api/diff?role=<id>&stat=1`, PLANS-DONE.md). The terminal has neither. A large pending change fills many pages in the TUI, but the first question is usually just "which files does it touch". `collectRoleChange` (src/change/change-data.ts) already takes `opts.stat`, and `renderRoleChange` renders that view unchanged, so only the TUI plumbing is missing.

**Key choice.** Ctrl+Y (mnemonic: summar**Y**, as in the History pane's summary toggle). On a Transcript view it does nothing useful today. The Activity-only claude-reserve editor (`tui-editor-claude-reserve.ts`, built by `createTeamConfigKeyEditor`, which returns false off view 0) lets the key fall through. The `tui-panes.ts` router then sends it to `history.handleKey`, which flips the History pane's `historySummary` behind the scenes. The other Transcript keys are taken (see docs/cli.md's TUI keys table).

**Approach.**
1. src/ui/tui/tui-pane-session.ts and src/ui/tui/tui-keys.ts: widen the `collectChange` seam's `opts` type in all three declarations (`TuiPanesDeps` and `TuiPaneSession` in tui-pane-session.ts, and `TuiKeysDeps`' optional one in tui-keys.ts) from `{ path?: string }` to `{ path?: string; stat?: boolean }`. The default `collectRoleChange` already accepts it. No other change there.
2. src/ui/tui/tui-pane-transcript.ts, `createTranscriptPane`:
   - Add `let changeStat = false;` beside `changeMode`/`changeCache`.
   - Pull the merge-queue header and collector call out of the notes → change arm into a local `loadChange(role: string)`. It computes `queueText` with the same try/catch, then calls `session.collectChange(session.root, target, changeStat ? { stat: true } : undefined)`. The `.then` guards stay as they are (`changeMode` still on, same role at the same index). The notes → change arm calls it after setting `changeMode = true; changeCache = null`.
   - A new arm: `key.ctrl && key.name === "y" && changeMode && promptLineFree(ctx.es) && session.view >= 1 && session.view <= session.roleIds.length`. It flips `changeStat`, sets `changeCache = null` (the pane paints its loading note), sets `session.paneScroll = 0`, calls `loadChange(role)`, requests a render, and returns true. With any of those conditions false it returns false, so the router falls through.
   - Leaving the change step (the Ctrl+N change → transcript branch) and `reset()` both set `changeStat = false`. Every new entry to the change step then starts on the full patch, like the drawer, which refetches without stat on reopen.
   - `state()` adds `changeStat`.
3. src/ui/tui/tui-panes.ts: the Ctrl+Y route becomes `if (transcript.handleKey?.(key, ctx)) return true; return history.handleKey?.(key, ctx) ?? false;`, with a one-line comment saying the transcript change-step arm goes first and falls through off it. Add `changeStat: tra.changeStat` to the aggregated state beside `changeCache`. Add the matching `changeStat: boolean` field, with a doc comment, to `TuiKeysState` in src/ui/tui/tui-keys.ts beside `changeCache`.
4. src/ui/tui/tui-frame.ts: the transcript view kind gains `changeStat?: boolean`. On the transcript hint line, when `view.change` is true, add `["Ctrl+Y", view.changeStat ? "full patch" : "stat only"]` after the Ctrl+N pair. src/ui/tui/tui.tsx passes `changeStat: s.changeStat` where it builds the transcript view.
5. docs/cli.md: in the TUI keys table's `Ctrl+N` | Transcript row, append "; on the change, `Ctrl+Y` shows the diffstat instead of the full patch, and the patch again on a second press (the `diff --role <id> --stat` text and the dashboard drawer's Stat only)".

**Acceptance criteria** (test/tui-keys.test.ts, modelled on "Ctrl+N cycles transcript → notes → change and back, caching the collector's render"; the collector stub records each call's `opts`):
- New test "Ctrl+Y on the Transcript change step toggles the diffstat". Enter the change step with Ctrl+T, then Ctrl+N twice. The first collector call has no `stat`, and `state().changeStat` is false. Ctrl+Y sets `changeStat` true, resets `changeCache` to null, and makes a second collector call with `{ stat: true }`. Once that resolves, `changeCache` equals `renderRoleChange(statView)`. A second Ctrl+Y makes a call without `stat` and sets `changeStat` back to false.
- In the same test, Ctrl+Y on the stat step, then Ctrl+N (change → transcript), then Ctrl+N twice back to the change step: `changeStat` is false and the newest collector call has no `stat`.
- Ctrl+Y on the live transcript step (not the change step) leaves `changeStat` false and makes no collector call. That keeps the History fallthrough intact. Assert the router still reaches History: on the History view, Ctrl+Y still cycles the summary, and the existing History Ctrl+Y tests pass unedited.
- test/tui-frame.test.ts: the transcript hint with `change: true` contains `Ctrl+Y stat only`, and with `changeStat: true` contains `Ctrl+Y full patch`. With `change: false` it contains no `Ctrl+Y`.
- The existing Ctrl+N cycle test passes unedited. `npm run test:gate` is green.

## Done
