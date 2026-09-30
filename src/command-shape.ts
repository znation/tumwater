/** True when the command's stdout cannot reach pi live while the command runs, so a stretch of
 * silence carries no hang signal and the stall warning would be a false alarm. Two shapes do
 * this: a pipe (`npm test 2>&1 | tail -8`) holds every byte in the pipeline until the upstream
 * command exits, and a stdout redirect (`npm test > /tmp/out`) sends the bytes to a file
 * instead of pi's pipe. Both are shapes the tick prompt itself prescribes for verification
 * runs, so the stall detector must not read their silence as a stall. A bare `2>&1` is NOT
 * such a shape: it points stderr at stdout's destination — pi's live pipe — so output still
 * streams and a hang stays detectable. `2>` and `2>>` likewise leave or append only stderr.
 * The classifier scans the command text and errs toward "buffered" on shapes it cannot
 * parse — a skipped warning for `echo "a > b"` costs far less than the cry-wolf the false
 * alarms cause. Its two consumers must classify identically or one surface cries wolf while
 * the other stays silent (BUGS.md 2026-09-28): src/pi.ts's runPi stall warning and
 * src/progress-data.ts's in-flight stall flag. Extracted from src/pi.ts on 2026-09-30 — a pure
 * string classifier the UI should not need the process spawner for. */
export function commandBuffersOutput(command: string): boolean {
  if (command.includes("|")) return true; // a pipeline stage buffers until its upstream exits
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== ">") continue;
    const prev = i > 0 ? command[i - 1] : "";
    if (command[i + 1] === ">") {
      // `>>` appends to a file: stdout leaves the pipe unless an fd names stderr (`2>>`).
      // The pair is one operator — when `2>>` leaves stdout live, skip past its second `>`
      // so the scan does not re-read it as a fresh stdout redirect.
      if (prev !== "2") return true;
      i += 1;
      continue;
    }
    if (prev === "2") continue; // `2>` / `2>&1`: stderr leaves or dups, stdout still streams
    if (prev === "&") return true; // `&>`: both streams leave the pipe
    if (command.slice(i + 1, i + 3) === "&1") continue; // `>&1` dups stdout onto itself
    return true; // `>` / `>&` / `<>`: stdout's destination is no longer pi's pipe
  }
  return false;
}
