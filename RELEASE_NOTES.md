# tumwater 0.7.0

## Highlights

- **Salvage is now recoverable, not just inspectable.** `tumwater salvage --apply <n>` applies
  a kept patch as unstaged edits (`--dry-run` previews the change); the Health view and the
  dashboard Settings card list every kept patch with per-patch Apply/Drop, and `salvage --show
  <n>` prints the patch's git diffstat under its saved line.
- **One-shot model-check re-probe.** The dashboard gains a "Re-check now" button (POSTs
  `/api/model-check`) the orchestrator consumes to re-probe the failed pairs immediately
  instead of waiting for the next poll.
- **Every write is scriptable.** All write commands now print one machine-readable `--json`
  acknowledgement object, and the JSON list rows carry their positional number (`backlog`,
  `reviews`, `wake --list`, `status` salvage patches), so a pipeline reads the result as data
  instead of parsing prose.
- **`config edit` writes the whole file** (opening it in `$VISUAL`/`$EDITOR` or taking
  `--file`), validating it the way a load does and writing it atomically.
- **Live transcript JSON.** `logs --transcript <id> --json` is the live twin of the
  completed-run transcript JSON, so a running role's stream is consumable as it ends.

## Fixes

- The merge drain is now single-flight and resolves pins only, and a kept change no longer
  re-queues — overlapping polls can no longer start two drains for one head.
- A torn pi-log tail is repaired on the next run's open, and writes are guarded against dead
  streams.
- The Codex quota wall is classified as transient, so drained runs are excluded from the drop
  limit instead of counting against it.
- `runTui` resolves on EIO, so a dead terminal quits instead of crashing.
- A stale or dangling merge pin that leftover recovery drops now clears its in-flight marker
  record, so a crash's residue no longer leaves a phantom `merging` row the status surfaces read
  forever — the true root cause of the stale-pin e2e test previously blamed on host load.
- The model-check reviewer-pair hold parks only the post-merge review drain, and the
  `lastApprovedHead` bypass is guarded against a consumed abort.
- Out-of-range salvage/quarantine/reviews messages name the valid position range, and
  exponent-shape refusals append the offending value.

## CLI

- `salvage --apply <n> [--dry-run]` applies the Nth kept patch as unstaged edits; the dashboard
  Settings card lists salvage patches with per-patch Apply/Drop, and the Health view lists them
  below the doctor report.
- `--json` acknowledgements on `role` overrides and holds, `config set/unset/edit`, `wake`,
  `notify --test`, `prompt` enqueue/cancel/top/edit, `reset-counters`, `reclaim`, and
  `init`/`--list-templates`.
- `backlog --json`, `reviews --json`/`--show --json`, `wake --list --json`, and
  `status --json` salvagePatches rows carry the whole-queue position.
- `config edit [--file <path>] [--json]` rewrites the whole `tumwater.json`, atomically and
  validated.
- `logs --transcript <id> --json` prints the live transcript as JSON.

## Build and tests

- The merge driver resolves pins only, with pin-based fixture helpers; the merge-pipeline tests
  were rewritten to pin seeding and cover the resolve-author path.
- More than 20 large functions split into named module-private stage helpers; the rev-list
  tokenizer, the plain-decimal position parsers, and the GUI role-field readers folded into
  shared helpers; direct unit tests added for merge-questions, history-queued, agent-stream and
  inbox edge branches.
