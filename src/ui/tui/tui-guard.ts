/** Run `fn` and, on a throw, flash the reason on the session instead of letting it escape a
 * keypress or sync handler and kill the TUI. The one home of the try/catch every TUI editor
 * or pane with a disk or marker write used to declare locally, so their guards cannot drift;
 * the session is structural — any widget exposing `flashError(err: unknown)`. */
export function guardError(
  session: { flashError(err: unknown): void },
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    session.flashError(err);
  }
}

/** The rejection handler every TUI async write passes as the second argument of `.then(onOk, …)`:
 * flash the thrown reason on the session instead of dropping it. The one home of the
 * `(err: unknown) => session.flashError(err)` arrows the editors and panes used to inline per
 * call site, so their guards cannot drift; the session is structural — any widget exposing
 * `flashError(err: unknown)` (same contract as guardError). */
export function flashReject(
  session: { flashError(err: unknown): void },
): (err: unknown) => void {
  return (err: unknown) => session.flashError(err);
}
