// vocabulary: plain
/** The dashboard's browser-side twins of roleLabel, roleTitle and eventTypeLabel. The script is
 * String.raw text and cannot import server modules, so the data is interpolated at module build
 * and the few lines of logic are hand-kept copies, pinned against their TypeScript originals by
 * test/gui-client-labels.test.ts. Spliced into gui-client.ts's script right after the format
 * helpers, so every later client module can call the three functions. */
import { EVENT_TYPE_LABELS, RUN_RESULT_LABELS } from "../../events/event-labels.js";
import { INSTANCE_ID_SOURCE } from "../../roles/loop-ids.js";
import { CUSTOM_ROLE_TITLE, ROLE_TITLES } from "../../roles/role-labels.js";

export const GUI_CLIENT_LABELS_JS = String.raw`  // labels:start
  const ROLE_TITLES = ${JSON.stringify(ROLE_TITLES)};
  const CUSTOM_ROLE_TITLE = ${JSON.stringify(CUSTOM_ROLE_TITLE)};
  const INSTANCE_ID = new RegExp(${JSON.stringify(INSTANCE_ID_SOURCE)});
  const EVENT_TYPE_LABELS = ${JSON.stringify(EVENT_TYPE_LABELS)};
  const RUN_RESULT_LABELS = ${JSON.stringify(RUN_RESULT_LABELS)};
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function roleLabel(id) {
    const m = INSTANCE_ID.exec(id);
    return m ? m[1] + " #" + Number(m[2]) : id;
  }
  function roleTitle(id) {
    const m = INSTANCE_ID.exec(id);
    const base = m ? m[1] : id;
    return hasOwn(ROLE_TITLES, base) ? ROLE_TITLES[base] : CUSTOM_ROLE_TITLE;
  }
  function eventTypeLabel(code) {
    if (hasOwn(EVENT_TYPE_LABELS, code)) return EVENT_TYPE_LABELS[code];
    if (hasOwn(RUN_RESULT_LABELS, code)) return RUN_RESULT_LABELS[code];
    return String(code).replace(/_/g, " ");
  }
  // labels:end
`;
