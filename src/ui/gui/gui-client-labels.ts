/** The dashboard's browser-side twins of roleLabel and eventTypeLabel. The script is
 * String.raw text and cannot import server modules, so the data is interpolated at module build
 * and the few lines of logic are hand-kept copies, pinned against their TypeScript originals by
 * test/gui-client-labels.test.ts. Spliced into gui-client.ts's script right after the format
 * helpers, so every later client module can call the two functions. */
import { EVENT_TYPE_LABELS, RUN_RESULT_LABELS } from "../../events/event-labels.js";
import { DEFAULT_INSTANCES, INSTANCE_ID_SOURCE } from "../../roles/runner-ids.js";
import { ROLE_LABELS } from "../../roles/role-labels.js";

export const GUI_CLIENT_LABELS_JS = String.raw`  // labels:start
  const INSTANCE_ID = new RegExp(${JSON.stringify(INSTANCE_ID_SOURCE)});
  // The instance count an unset roles.<base>.instances means (DEFAULT_INSTANCES on the server).
  // The drawer's Instances row and the editor's save-guard messages name it, so the browser
  // cannot drift from what the scheduler and the Settings card read for an absent count.
  const DEFAULT_INSTANCES = ${JSON.stringify(DEFAULT_INSTANCES)};
  // roleLabel/eventTypeLabel follow:
  const EVENT_TYPE_LABELS = ${JSON.stringify(EVENT_TYPE_LABELS)};
  const RUN_RESULT_LABELS = ${JSON.stringify(RUN_RESULT_LABELS)};
  const ROLE_LABELS = ${JSON.stringify(ROLE_LABELS)};
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function roleLabel(id) {
    const m = INSTANCE_ID.exec(id);
    const base = m ? m[1] : id;
    const label = hasOwn(ROLE_LABELS, base) ? ROLE_LABELS[base] : base;
    return m ? label + " #" + Number(m[2]) : label;
  }
  function eventTypeLabel(code) {
    if (hasOwn(EVENT_TYPE_LABELS, code)) return EVENT_TYPE_LABELS[code];
    if (hasOwn(RUN_RESULT_LABELS, code)) return RUN_RESULT_LABELS[code];
    return String(code).replace(/_/g, " ");
  }
  // labels:end
`;
