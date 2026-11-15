# tumwater 0.8.0

## Highlights

- **Role lessons.** Each role now keeps a durable store of lessons, kept word for word beside
  its rewritten note. Runs add lessons with `tumwater-notes lesson`, and every run prompt shows
  them along with guidance on what belongs in a lesson and what belongs in the note.
  Operators see the lessons in `tumwater role`, the TUI pane and the dashboard drawer, and can
  clear them there. The doctor `role notes` row warns when the store goes over its cap.
- **Runs survive compaction.** A new bundled `pin-prompt` pi extension keeps a run's prompt
  verbatim through every compaction. A new `checkpoint` tool and rubric let pi compact at step
  boundaries instead of mid-step.
- **Each run knows what changed.** The run prompt has a "since last run" block listing what
  merged to main since that role last ran. It counts an instance's own merges and shows a
  `+N older` marker when the list is cut short.
- **Slow local models are not mistaken for hangs.** The new per-model `unansweredStallSeconds`
  setting gives a slow model's long prefill its own warning threshold. A free post-merge
  reviewer gets at least 3600 s, and `quietTimeoutSeconds` now defaults to 3600 s, so slow
  local reviews can reach a verdict.

## Fixes

- Self-redeploy builds with the 7.x compiler (typescript-native). A self-divergent running
  build latches once with a clear reason instead of flapping.
- The quiet-host gate also waits on the 5-minute load average. The reached-cap e2e test waits
  if the host gets busy again after admission.
- `runScriptGroup` releases its pipe handles every time it settles, not only on timeout.
- Requeued prompt attachments are restored when the queue write fails.
- The role-lessons reader does not follow a symlink into the model's prompt.
- `init` reports only the files it actually committed.
- diff-check finds its baseline build directory through `$TMPDIR` instead of a fixed `/tmp`.
- The dashboard's self-redeploy Waiting pill is amber like the other holds.

## CLI

- `tumwater role <id> --clear-lessons [--json]` empties a role's lessons store and leaves its
  note as it was.
- `tumwater-notes lesson add | replace <id> | retire <id> | list` manage a role's lessons.
- New config key `unansweredStallSeconds` (per `<provider>/<model>`).

## Build and tests

- About 20 large functions are split into named helpers. Duplicated helpers such as the stall
  threshold, `watchAt` and the InFlightMerge stand-in now have one shared copy.
- New tests cover the checkpoint adapter, the review-floor branches and the model-check alerts.
  Stale counts and cross-directory references in doc comments are fixed.

235 files changed, +8537 / −2902 over 166 commits since v0.7.0
