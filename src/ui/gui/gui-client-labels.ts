// vocabulary: plain
/** The dashboard's browser-side twins of roleLabel and eventTypeLabel. The script is
 * String.raw text and cannot import server modules, so the data is interpolated at module build
 * and the few lines of logic are hand-kept copies, pinned against their TypeScript originals by
 * test/gui-client-labels.test.ts. Spliced into gui-client.ts's script right after the format
 * helpers, so every later client module can call the two functions. */
import { EVENT_TYPE_LABELS, RUN_RESULT_LABELS } from "../../events/event-labels.js";
import { INSTANCE_ID_SOURCE } from "../../roles/loop-ids.js";

export const GUI_CLIENT_LABELS_JS = String.raw`  // labels:start
  const INSTANCE_ID = new RegExp(${JSON.stringify(INSTANCE_ID_SOURCE)});
  const EVENT_TYPE_LABELS = ${JSON.stringify(EVENT_TYPE_LABELS)};
  const RUN_RESULT_LABELS = ${JSON.stringify(RUN_RESULT_LABELS)};
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function roleLabel(id) {
    const m = INSTANCE_ID.exec(id);
    return m ? m[1] + " #" + Number(m[2]) : id;
  }
  function eventTypeLabel(code) {
    if (hasOwn(EVENT_TYPE_LABELS, code)) return EVENT_TYPE_LABELS[code];
    if (hasOwn(RUN_RESULT_LABELS, code)) return RUN_RESULT_LABELS[code];
    return String(code).replace(/_/g, " ");
  }
  // labels:end
`;
