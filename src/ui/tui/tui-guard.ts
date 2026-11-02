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

/** The rejection handler a pane's async load passes as the second `.then` argument when the
 * resolution may have been superseded in flight: while `isStale()` is false it flashes the
 * reason and requests a repaint; a superseded load settles silently. The one home of the
 * guard-then-flash-then-repaint tail the panes' generation-guarded loads inline per load —
 * the Health pane's doctor run, the Pending pane's refresh and overlap drill-down, the Trail
 * pane's trail parts, the Transcript pane's change load — so its order cannot drift; the
 * session is structural — any widget exposing `flashError` and `requestRender` (same contract
 * as flashReject). */
export function staleReject(
  session: { flashError(err: unknown): void; requestRender(): void },
  isStale: () => boolean,
): (err: unknown) => void {
  return (err: unknown) => {
    if (isStale()) return;
    session.flashError(err);
    session.requestRender();
  };
}
