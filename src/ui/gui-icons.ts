/** The dashboard's icon set: small 24×24 line icons drawn for this page (stroke by default,
 * filled where a solid glyph reads better at 16px), plus the tumwater mark — two waves on a
 * teal tile. The page shell (gui-page.ts) draws the static ones server-side through iconSvg;
 * the browser script receives ICON_PATHS as data and builds the same markup for everything it
 * renders. */

const FILLED = 'fill="currentColor" stroke="none"';

export const ICON_PATHS: Record<string, string> = {
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  list: `<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" ${FILLED}/><circle cx="4.5" cy="12" r="1.2" ${FILLED}/><circle cx="4.5" cy="18" r="1.2" ${FILLED}/>`,
  bars: '<path d="M4 20h16M6.5 16.5V11M12 16.5V5.5M17.5 16.5V8.5"/>',
  alert: '<path d="M10.3 4.3 2.8 17.4A2 2 0 0 0 4.5 20.4h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  pause: `<rect x="6.5" y="5" width="3.8" height="14" rx="1" ${FILLED}/><rect x="13.7" y="5" width="3.8" height="14" rx="1" ${FILLED}/>`,
  play: `<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 8 5.8z" ${FILLED}/>`,
  stop: `<rect x="6" y="6" width="12" height="12" rx="2" ${FILLED}/>`,
  bolt: `<path d="M13.2 2.5 4.8 13.4h6.4l-1 8.1 8.4-10.9h-6.4l1-8.1z" ${FILLED}/>`,
  chat: '<path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-7.5l-4.5 4v-4a1.5 1.5 0 0 1-1.5-1.5z"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.2A8 8 0 1 1 9.8 4a6.5 6.5 0 0 0 10.2 10.2z"/>',
  send: '<path d="M12 19V5.5M5.5 12 12 5.5l6.5 6.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.6M12 16.8h.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  merge: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="14" r="2.2"/><path d="M7 8.2v7.6M7 8.5c0 3.5 3 5.5 7.8 5.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  dollar: '<path d="M12 3v18M16.5 7.5C16.5 5.8 14.5 5 12 5S7.5 6 7.5 8s2 2.8 4.5 3.3 4.5 1.3 4.5 3.4-2 3.3-4.5 3.3-4.5-1-4.5-3"/>',
  plan: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5"/>',
  bug: '<rect x="7" y="7.5" width="10" height="12.5" rx="5"/><path d="M12 11v9M9.2 7.8a2.8 2.8 0 0 1 5.6 0M4 11.5h3M17 11.5h3M4 16h3M17 16h3M5.5 5.5 8 8M18.5 5.5 16 8"/>',
  inbox: '<path d="M4 13.5l2.4-8h11.2l2.4 8V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>',
  dot: `<circle cx="12" cy="12" r="3" ${FILLED}/>`,
  fail: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  offline: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 4.2-2.3M14.8 10.3A10 10 0 0 1 19 12.6M12 20h.01"/>',
};

/** One icon's markup — the same shape the browser script's icon() builds. */
export function iconSvg(name: string, extraClass = ""): string {
  return `<svg class="i${extraClass ? ` ${extraClass}` : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] ?? ""}</svg>`;
}

/** The tumwater mark: two waves on a teal tile (the name is Chinook Jargon for "thumping water").
 * Also the page's favicon (as a data URI). */
export const LOGO_SVG =
  '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="32" height="32" rx="8" fill="#0d9488"/>' +
  '<path d="M6.1 13c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>' +
  '<path d="M6.1 19.8c2.2-2.4 4.4-2.4 6.6 0s4.4 2.4 6.6 0 4.4-2.4 6.6 0" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2.4" stroke-linecap="round"/>' +
  "</svg>";
