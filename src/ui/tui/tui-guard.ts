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
