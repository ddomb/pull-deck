// The page a shortcut lands on when the answer was not one specific pull
// request. Reached only by the service worker navigating a tab here, never
// linked from the web: it is not in web_accessible_resources, so no page can
// probe for it or read it.
//
// This is a real tab rather than the popup, so unlike popup.js it may call the
// tab APIs directly — nothing tears the document down mid-await. It still asks
// the worker to do the opening, because openIntoGroup is the one place that
// knows how not to duplicate a tab.

import { icons } from './icons.js';
import { el, glyph, age, badgesFor } from './pr-row.js';
import { findMatches } from './resolve.js';

const $ = (id) => document.getElementById(id);

const dom = {
  sheet: $('sheet'),
  headline: $('headline'),
  subhead: $('subhead'),
  finder: $('finder'),
  finderIcon: $('finder-icon'),
  input: $('query'),
  results: $('results'),
  notice: $('notice'),
  foot: $('foot'),
};

const state = {
  /** Every open pull request, so re-typing filters without another round trip. */
  all: [],
  rows: [],
  focusIndex: 0,
  opening: false,
};

/* ------------------------------------------------------------------ rows -- */

function rowFor(pr, index) {
  const row = el('button', 'pr-row');
  row.type = 'button';
  row.dataset.id = pr.id;
  row.style.setProperty('--i', String(Math.min(index, 10)));
  row.tabIndex = index === state.focusIndex ? 0 : -1;

  row.append(el('div', 'pr-title', pr.title));

  const meta = el('div', 'pr-meta');
  meta.append(el('span', 'pr-repo', pr.repo));
  meta.append(el('span', 'pr-dot', `#${pr.number}`));
  if (pr.headRefName) meta.append(el('span', 'pr-dot pr-branch', pr.headRefName));
  meta.append(el('span', 'pr-dot', age(pr.updatedAt)));
  row.append(meta);

  const badges = el('div', 'pr-badges');
  for (const b of badgesFor(pr)) badges.append(b);
  row.append(badges);

  const go = el('span', 'pr-go');
  go.append(glyph(icons.arrowRight));
  row.append(go);

  row.setAttribute(
    'aria-label',
    `${pr.title}. ${pr.repo} number ${pr.number}${pr.headRefName ? `, branch ${pr.headRefName}` : ''}.`
  );

  row.addEventListener('click', () => open(pr));
  row.addEventListener('focus', () => {
    state.focusIndex = index;
    syncTabIndex();
  });
  return row;
}

function syncTabIndex() {
  state.rows.forEach((row, i) => {
    row.tabIndex = i === state.focusIndex ? 0 : -1;
  });
}

function renderRows(list) {
  state.focusIndex = 0;
  state.rows = list.map(rowFor);
  dom.results.replaceChildren(
    ...state.rows.map((row) => {
      const li = el('li');
      li.append(row);
      return li;
    })
  );
}

/* ---------------------------------------------------------------- notices -- */

function showNotice(tone, title, body) {
  const wrap = el('div', 'notice-glyph');
  wrap.dataset.tone = tone;
  wrap.append(glyph(tone === 'danger' ? icons.alert : icons.empty));
  dom.notice.replaceChildren(wrap, el('h2', 'notice-title', title), el('p', 'notice-body', body));
  dom.notice.hidden = false;
}

function clearNotice() {
  dom.notice.hidden = true;
  dom.notice.replaceChildren();
}

/* ----------------------------------------------------------------- render -- */

/** The shorthand, quoted back, so a typo is obvious rather than mysterious. */
function quoted(query) {
  const node = el('code', null, query);
  return node;
}

function say(title, ...subParts) {
  dom.headline.textContent = title;
  dom.subhead.replaceChildren(...subParts);
}

function render(result) {
  dom.sheet.dataset.state = result.status;
  clearNotice();

  const query = result.query ?? '';
  const count = result.matches?.length ?? 0;

  switch (result.status) {
    case 'noToken':
      say('Connect GitHub first');
      dom.results.replaceChildren();
      showNotice(
        'danger',
        'No token yet',
        'Pull Deck needs a personal access token before it can look anything up. Click the Pull Deck icon in the toolbar to add one.'
      );
      return;

    case 'error':
      say('Could not reach GitHub');
      dom.results.replaceChildren();
      showNotice('danger', 'Nothing to search', result.error?.message ?? 'Try again in a moment.');
      return;

    case 'many':
      say(`${count} pull requests match `, quoted(query));
      renderRows(result.matches);
      dom.foot.textContent = 'Pick one. Nothing is opened until you do.';
      return;

    case 'one':
      say('One match for ', quoted(query));
      renderRows(result.matches);
      dom.foot.textContent = 'Press ↵ to open it.';
      return;

    case 'empty':
      say('Your open pull requests');
      renderRows(state.all);
      dom.foot.textContent = footHint();
      return;

    default:
      say('Nothing open matches ', quoted(query));
      renderRows(state.all);
      if (state.all.length === 0) {
        showNotice('neutral', 'No open pull requests', 'There is nothing to match against yet.');
      }
      dom.foot.textContent = footHint();
  }
}

function footHint() {
  return state.all.length > 0
    ? 'Type a ticket id, a branch name, or #number.'
    : 'Open the popup to check the connection.';
}

/* ---------------------------------------------------------------- actions -- */

async function open(pr) {
  if (state.opening) return;
  state.opening = true;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'openOne',
      pullRequest: { id: pr.id, url: pr.url },
    });
    if (!reply?.ok) throw reply?.error ?? new Error('The extension worker did not respond.');
    await dismissSelf();
  } catch (error) {
    state.opening = false;
    dom.foot.textContent = error?.message ?? 'Could not open that pull request.';
  }
}

/**
 * Close this tab, having sent the user to the pull request.
 *
 * Not when it is the only tab in its window: closing that closes the window,
 * which is far more than anyone asked a shortcut to do.
 */
async function dismissSelf() {
  try {
    const self = await chrome.tabs.getCurrent();
    if (!self) return;
    const siblings = await chrome.tabs.query({ windowId: self.windowId });
    if (siblings.length > 1) await chrome.tabs.remove(self.id);
  } catch {
    // Leaving the page up is a fine outcome; the pull request is already open.
  }
}

/** Re-filter locally. The full list is already here, so this costs nothing. */
function filter(query) {
  const trimmed = query.trim();
  const result = trimmed
    ? { query: trimmed, ...findMatches(trimmed, state.all) }
    : { query: '', status: 'empty', matches: [], all: state.all };
  render(result);
}

/* ----------------------------------------------------------------- wiring -- */

function moveFocus(delta) {
  if (state.rows.length === 0) return;
  state.focusIndex = Math.max(0, Math.min(state.rows.length - 1, state.focusIndex + delta));
  state.rows[state.focusIndex].focus();
}

function wire() {
  dom.finderIcon.append(glyph(icons.search));

  let typing;
  dom.input.addEventListener('input', () => {
    clearTimeout(typing);
    // Long enough that the list is not thrashing under the cursor, short enough
    // that it still feels like it is keeping up.
    typing = setTimeout(() => filter(dom.input.value), 90);
  });

  dom.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(typing);
      filter(dom.input.value);
      // Enter only commits when there is exactly one answer. With several on
      // screen it would be a coin toss dressed up as a shortcut.
      if (state.rows.length === 1) state.rows[0].click();
      else if (state.rows.length > 1) state.rows[0].focus();
      return;
    }
    if (event.key === 'ArrowDown' && state.rows.length > 0) {
      event.preventDefault();
      state.focusIndex = 0;
      state.rows[0].focus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.target === dom.input) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (state.focusIndex === 0) dom.input.focus();
      else moveFocus(-1);
    } else if (event.key === 'Escape') {
      dom.input.focus();
      dom.input.select();
    }
  });
}

async function start() {
  const query = new URLSearchParams(location.search).get('q') ?? '';
  dom.input.value = query;

  let result;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'resolve', query });
    if (!reply?.ok) throw reply?.error ?? new Error('No answer from the extension.');
    result = reply.data;
  } catch (error) {
    result = { query, status: 'error', error, matches: [], all: [] };
  }

  state.all = result.all ?? [];
  render(result);

  // Focus the field, caret at the end: the common case after a miss is fixing
  // a typo, not retyping the whole thing.
  dom.input.focus();
  dom.input.setSelectionRange(query.length, query.length);
}

wire();
start();
