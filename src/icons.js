// One icon set, hand-drawn on a 16-unit grid with a 1.6px round-capped stroke,
// matching SF Symbols geometry. Mixing in a second library is a ban, so
// everything the UI needs lives here.
//
// Strings, not DOM nodes: they are interpolated into template literals and the
// only dynamic part of any surrounding markup is escaped separately.

const wrap = (body, { fill = false } = {}) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" ` +
  `fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  refresh: wrap(
    '<path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.6 2.4v2.9h-2.9"/>'
  ),

  // Sliders rather than a gear: a 16px gear turns to mush, and at this size a
  // spoked circle reads as a brightness control instead of settings.
  settings: wrap(
    '<path d="M2.4 4.6h11.2M2.4 11.4h11.2"/>' +
      '<circle cx="6" cy="4.6" r="1.9"/><circle cx="10.4" cy="11.4" r="1.9"/>'
  ),

  back: wrap('<path d="M10 3.2 5.2 8l4.8 4.8"/>'),

  check: wrap('<path d="M3.4 8.6l3 3 6.2-7.2"/>'),

  approved: wrap('<circle cx="8" cy="8" r="6"/><path d="M5.3 8.2l2 2 3.5-4.1"/>'),

  changes: wrap('<circle cx="8" cy="8" r="6"/><path d="M5.6 8h4.8"/>'),

  review: wrap('<circle cx="8" cy="8" r="6"/><path d="M8 5v3.3l2.2 1.3"/>'),

  draft: wrap(
    '<circle cx="8" cy="8" r="6" stroke-dasharray="2 2.3"/><circle cx="8" cy="8" r="1.6"/>'
  ),

  ciPass: wrap('<path d="M2.6 8.4l2.6 2.6L13.4 3"/>'),

  ciFail: wrap('<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>'),

  ciPending: wrap('<circle cx="8" cy="8" r="5.4" stroke-dasharray="1.6 2.4"/>'),

  external: wrap('<path d="M9.3 3.2h3.5v3.5M12.4 3.6L7.6 8.4M11.4 9.6v2.6a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.6"/>'),

  // Solid, because it is a state marker rather than a control.
  inGroup: wrap('<path d="M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9Zm3.2 4.6-4 4.6a.8.8 0 0 1-1.2.03L4.2 9.2a.8.8 0 1 1 1.2-1.05l1.2 1.4 3.4-3.9a.8.8 0 0 1 1.2 1.05Z"/>', { fill: true }),

  empty: wrap(
    '<rect x="2.2" y="3.4" width="11.6" height="9.2" rx="2"/>' +
      '<path d="M2.2 6.6h11.6M5.6 3.4v3.2" stroke-dasharray="2 2"/>'
  ),

  alert: wrap('<path d="M8 2.6 1.9 13.2h12.2L8 2.6Z"/><path d="M8 6.5v3M8 11.3v.1"/>'),

  key: wrap(
    '<circle cx="5.6" cy="10.4" r="2.6"/><path d="M7.5 8.5 13 3M10.6 5.9l1.6 1.6M12.2 4.3l1.6 1.6"/>'
  ),

  eye: wrap(
    '<path d="M1.6 8S4 4 8 4s6.4 4 6.4 4-2.4 4-6.4 4S1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="1.8"/>'
  ),

  eyeOff: wrap(
    '<path d="M6.3 4.3A6.4 6.4 0 0 1 8 4c4 0 6.4 4 6.4 4a12 12 0 0 1-1.9 2.3M4 5.4A12.4 12.4 0 0 0 1.6 8S4 12 8 12a6.5 6.5 0 0 0 2-.3"/><path d="M2.6 2.6l10.8 10.8"/>'
  ),
};
