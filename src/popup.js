// Popup UI. Renders state and sends messages; it never touches the network or
// the tab APIs itself, because Chrome destroys this document the moment focus
// leaves it. See service-worker.js.

import { icons } from './icons.js';
import { GROUP_COLORS } from './store.js';

/* ------------------------------------------------------------- transport -- */

// The dev preview (dev/preview.html) installs a stub here so the interface can
// be inspected outside an extension context. In the real popup this is unset.
const transport =
  globalThis.__pullDeckTransport ??
  {
    send: (message) => chrome.runtime.sendMessage(message),
    onProgress: (handler) => chrome.runtime.onMessage.addListener(handler),
  };

async function send(message) {
  const reply = await transport.send(message);
  if (!reply) throw { kind: 'unknown', message: 'The extension worker did not respond.' };
  if (!reply.ok) throw reply.error;
  return reply.data;
}

/* ------------------------------------------------------------------ state -- */

const SCOPES = ['mine', 'reviewing', 'assigned'];

const state = {
  stage: 'loading',
  scope: 'mine',
  settings: { groupTitle: 'Pull Requests', groupColor: 'cyan', badgeEnabled: true, tokenTail: '' },
  viewer: null,
  scopes: { mine: [], reviewing: [], assigned: [] },
  groupKeys: new Set(),
  groupOtherWindow: false,
  error: null,
  focusIndex: 0,
  busy: false,
};

const $ = (id) => document.getElementById(id);

const dom = {
  app: $('app'),
  brandUser: $('brand-user'),
  refresh: $('refresh'),
  openSettings: $('open-settings'),
  segments: $('segments'),
  indicator: $('segments-indicator'),
  skeleton: $('skeleton'),
  list: $('pr-list'),
  emptyNotice: $('empty-notice'),
  errorNotice: $('error-notice'),
  openAll: $('open-all'),
  openAllText: $('open-all-text'),
  dockNote: $('dock-note'),
  settings: $('settings'),
  closeSettings: $('close-settings'),
  groupName: $('group-name'),
  swatches: $('swatches'),
  badgeSwitch: $('badge-switch'),
  tokenOwner: $('token-owner'),
  tokenFingerprint: $('token-fingerprint'),
  tokenIcon: $('token-icon'),
  forgetToken: $('forget-token'),
  tokenForm: $('token-form'),
  tokenInput: $('token-input'),
  tokenField: $('token-field'),
  tokenError: $('token-error'),
  tokenReveal: $('token-reveal'),
  tokenLink: $('token-link'),
  connect: $('connect'),
};

/* ----------------------------------------------------------------- helpers -- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Icon markup is authored in icons.js, never derived from remote data. */
function glyph(markup) {
  const holder = document.createElement('span');
  holder.innerHTML = markup;
  return holder.firstElementChild;
}

function setIcon(button, markup) {
  button.insertBefore(glyph(markup), button.firstChild);
}

/** Compact age: 4m, 3h, 6d, 2w. Terser than Intl and matches the copy. */
function age(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  const weeks = days / 7;
  if (weeks < 53) return `${Math.floor(weeks)}w`;
  return `${Math.floor(days / 365)}y`;
}

/** Same identity rule as pr-url.js, kept in sync for group membership checks. */
function pullRequestKey(url) {
  try {
    const parsed = new URL(url);
    const [owner, repo, kind, number] = parsed.pathname.split('/').filter(Boolean);
    if ((kind !== 'pull' && kind !== 'pulls') || !/^\d+$/.test(number)) return null;
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    return `${host}/${owner.toLowerCase()}/${repo.toLowerCase()}#${Number(number)}`;
  } catch {
    return null;
  }
}

const visible = () => state.scopes[state.scope] ?? [];

const inGroup = (pr) => {
  const key = pullRequestKey(pr.url);
  return key !== null && state.groupKeys.has(key);
};
const pending = () => visible().filter((pr) => !inGroup(pr));

/* ------------------------------------------------------------------ badges -- */

function badge(tone, iconMarkup, label) {
  const node = el('span', 'badge');
  node.dataset.tone = tone;
  node.append(glyph(iconMarkup), el('span', null, label));
  return node;
}

function badgesFor(pr) {
  const out = [];
  if (pr.isDraft) out.push(badge('neutral', icons.draft, 'Draft'));

  if (pr.reviewDecision === 'APPROVED') out.push(badge('success', icons.approved, 'Approved'));
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') out.push(badge('danger', icons.changes, 'Changes'));
  else if (pr.reviewDecision === 'REVIEW_REQUIRED' && !pr.isDraft) {
    out.push(badge('neutral', icons.review, 'In review'));
  }

  // Only non-passing checks earn a badge. A green tick on every row is noise,
  // and the thing worth spotting in a glance is the failure.
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') {
    out.push(badge('danger', icons.ciFail, 'Checks failed'));
  } else if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') {
    out.push(badge('pending', icons.ciPending, 'Checks running'));
  }
  return out;
}

/* -------------------------------------------------------------------- rows -- */

function rowFor(pr, index) {
  const row = el('button', 'pr-row');
  row.type = 'button';
  row.dataset.id = pr.id;
  row.dataset.inGroup = String(inGroup(pr));
  row.style.setProperty('--i', String(Math.min(index, 10)));
  row.tabIndex = index === state.focusIndex ? 0 : -1;

  row.append(el('div', 'pr-title', pr.title));

  const meta = el('div', 'pr-meta');
  meta.append(el('span', 'pr-repo', pr.repo));
  meta.append(el('span', 'pr-dot', `#${pr.number}`));
  meta.append(el('span', 'pr-dot', age(pr.updatedAt)));
  if (pr.additions || pr.deletions) {
    const stat = el('span', 'pr-dot');
    stat.append(el('span', 'diff-add', `+${pr.additions}`));
    stat.append(document.createTextNode(' '));
    // U+2212, not a hyphen: it lines up with the plus.
    stat.append(el('span', 'diff-del', `−${pr.deletions}`));
    meta.append(stat);
  }
  row.append(meta);

  const badges = el('div', 'pr-badges');
  for (const b of badgesFor(pr)) badges.append(b);
  row.append(badges);

  const stateCell = el('span', 'pr-state');
  if (inGroup(pr)) {
    stateCell.append(glyph(icons.inGroup));
    stateCell.title = `Already in ${state.settings.groupTitle}`;
  }
  row.append(stateCell);

  row.setAttribute(
    'aria-label',
    `${pr.title}. ${pr.repo} number ${pr.number}. ${
      inGroup(pr) ? `Already in ${state.settings.groupTitle}.` : 'Not yet in the group.'
    }`
  );

  row.addEventListener('click', () => openOne(pr));
  row.addEventListener('focus', () => {
    state.focusIndex = index;
    syncRowTabIndex();
  });
  return row;
}

function syncRowTabIndex() {
  [...dom.list.children].forEach((li, i) => {
    const row = li.firstElementChild;
    if (row) row.tabIndex = i === state.focusIndex ? 0 : -1;
  });
}

/** Flip one row to its in-group state without re-rendering the list. */
function markRowInGroup(id) {
  const row = dom.list.querySelector(`.pr-row[data-id="${CSS.escape(String(id))}"]`);
  if (!row || row.dataset.inGroup === 'true') return;
  row.dataset.inGroup = 'true';
  const cell = row.querySelector('.pr-state');
  cell.replaceChildren(glyph(icons.inGroup));
  cell.dataset.justAdded = 'true';
  cell.title = `Already in ${state.settings.groupTitle}`;
}

/* ------------------------------------------------------------------ render -- */

function render() {
  renderStage();
  if (state.stage !== 'list') return;

  renderSegments();
  renderList();
  renderDock();
  renderSettings();
}

function renderStage() {
  const stage = state.stage;
  dom.app.dataset.view = stage === 'list' && visible().length === 0 ? 'empty' : stage;

  const active = dom.app.dataset.view;
  for (const view of document.querySelectorAll('.view')) {
    if (view.dataset.name === active) view.setAttribute('data-active', '');
    else view.removeAttribute('data-active');
  }

  if (active === 'empty') renderEmpty();
  if (active === 'error') renderError();
  if (active === 'loading') renderSkeleton();
  if (active === 'onboarding') dom.tokenInput.focus();

  dom.brandUser.textContent = state.viewer ? `@${state.viewer.login}` : '';
  dom.refresh.disabled = stage === 'onboarding';
  dom.openSettings.hidden = false;
}

function renderSkeleton() {
  if (dom.skeleton.children.length) return;
  for (let i = 0; i < 5; i++) {
    const row = el('div', 'skeleton-row');
    const title = el('div', 'shimmer');
    title.style.width = `${58 + ((i * 13) % 34)}%`;
    const meta = el('div', 'shimmer');
    meta.style.width = `${32 + ((i * 7) % 20)}%`;
    row.append(title, meta);
    dom.skeleton.append(row);
  }
}

function renderSegments() {
  dom.segments.style.setProperty('--seg-index', String(SCOPES.indexOf(state.scope)));
  for (const button of dom.segments.querySelectorAll('.segment')) {
    const scope = button.dataset.scope;
    const selected = scope === state.scope;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    const count = state.scopes[scope]?.length ?? 0;
    button.querySelector('.segment-count').textContent = count > 0 ? String(count) : '';
  }
}

function renderList() {
  const items = visible();
  state.focusIndex = Math.min(state.focusIndex, Math.max(0, items.length - 1));
  dom.list.replaceChildren(
    ...items.map((pr, i) => {
      const li = el('li');
      li.append(rowFor(pr, i));
      return li;
    })
  );
  syncScrollFade();
}

/** Fade the bottom edge only while there is genuinely more list below it. */
function syncScrollFade() {
  const view = dom.list.closest('.view');
  if (!view) return;
  const more = view.scrollHeight - view.scrollTop - view.clientHeight > 2;
  if (more) view.setAttribute('data-more-below', '');
  else view.removeAttribute('data-more-below');
}

function renderDock() {
  if (state.busy) return; // the working state owns the button until it settles

  const items = visible();
  const todo = pending();
  const already = items.length - todo.length;
  const title = state.settings.groupTitle;

  dom.openAll.dataset.state = 'idle';
  dom.openAll.style.setProperty('--progress', '0');
  dom.openAll.disabled = todo.length === 0;
  dom.openAllText.textContent =
    todo.length === 0
      ? items.length === 0
        ? 'Nothing to open'
        : `All ${items.length} in “${title}”`
      : `Open ${todo.length} in “${title}”`;

  dom.dockNote.removeAttribute('data-tone');
  if (state.error) {
    dom.dockNote.dataset.tone = 'danger';
    dom.dockNote.textContent = errorCopy(state.error).short;
  } else if (state.groupOtherWindow) {
    dom.dockNote.textContent = `The group lives in another window.`;
  } else if (already > 0 && todo.length > 0) {
    dom.dockNote.textContent = `${already} already there, so ${
      already === 1 ? 'it stays' : 'they stay'
    } put.`;
  } else {
    dom.dockNote.textContent = '';
  }
}

function renderEmpty() {
  const copy = {
    mine: ['No open pull requests', 'Nothing you have authored is open right now.'],
    reviewing: ['No reviews waiting', 'Nobody has asked you to review anything.'],
    assigned: ['Nothing assigned', 'No open pull request is assigned to you.'],
  }[state.scope];

  dom.emptyNotice.replaceChildren(
    noticeGlyph(icons.empty, 'neutral'),
    el('h2', 'notice-title', copy[0]),
    el('p', 'notice-body', copy[1])
  );
}

function noticeGlyph(markup, tone) {
  const wrap = el('div', 'notice-glyph');
  wrap.dataset.tone = tone;
  wrap.append(glyph(markup));
  return wrap;
}

function errorCopy(error) {
  switch (error?.kind) {
    case 'badToken':
      return {
        title: 'Token rejected',
        body: 'GitHub would not accept this token. It may have been revoked or expired.',
        short: 'Token rejected. Open settings to replace it.',
        action: 'Replace token',
      };
    case 'forbidden':
      return {
        title: 'Not enough access',
        body: 'The token is valid but cannot read those repositories. A classic token needs the repo scope.',
        short: 'Token cannot read those repositories.',
        action: 'Replace token',
      };
    case 'rateLimited': {
      const at = error.retryAt ? new Date(error.retryAt) : null;
      const when = at
        ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : 'shortly';
      return {
        title: 'Rate limit reached',
        body: `GitHub is throttling this token. It resets at ${when}.`,
        short: `Rate limited until ${when}.`,
        action: null,
      };
    }
    case 'offline':
      return {
        title: 'No connection',
        body: 'Pull Deck could not reach github.com. Check the network and try again.',
        short: 'Offline. Showing the last known list.',
        action: null,
      };
    default:
      return {
        title: 'Something GitHub said',
        body: error?.message ?? 'An unexpected error occurred.',
        short: error?.message ?? 'Unexpected error.',
        action: null,
      };
  }
}

function renderError() {
  const copy = errorCopy(state.error);
  const parts = [
    noticeGlyph(icons.alert, 'danger'),
    el('h2', 'notice-title', copy.title),
    el('p', 'notice-body', copy.body),
  ];

  const retry = el('button', 'secondary', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => load({ force: true }));
  parts.push(retry);

  if (copy.action) {
    const fix = el('button', 'danger-link', copy.action);
    fix.type = 'button';
    fix.style.justifySelf = 'center';
    fix.addEventListener('click', () => openSettings());
    parts.push(fix);
  }

  dom.errorNotice.replaceChildren(...parts);
}

function renderSettings() {
  dom.groupName.value = state.settings.groupTitle;
  dom.badgeSwitch.setAttribute('aria-checked', String(state.settings.badgeEnabled));
  dom.tokenOwner.textContent = state.viewer ? `@${state.viewer.login}` : 'Connected';
  dom.tokenFingerprint.textContent = state.settings.tokenTail
    ? `••••${state.settings.tokenTail}`
    : '';

  if (!dom.swatches.children.length) {
    for (const color of GROUP_COLORS) {
      const swatch = el('button', 'swatch');
      swatch.type = 'button';
      swatch.dataset.color = color;
      swatch.style.setProperty('--swatch', chromeGroupColor(color));
      swatch.setAttribute('aria-label', color);
      swatch.addEventListener('click', () => {
        state.settings.groupColor = color;
        paintSwatches();
        send({ type: 'settings', patch: { groupColor: color } }).catch(showFatal);
      });
      dom.swatches.append(swatch);
    }
  }
  paintSwatches();
}

function paintSwatches() {
  for (const swatch of dom.swatches.children) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === state.settings.groupColor));
  }
}

/** Approximate Chrome's own tab-group swatches so the picker tells the truth. */
function chromeGroupColor(name) {
  return {
    grey: '#5f6368',
    blue: '#1a73e8',
    red: '#d93025',
    yellow: '#f9ab00',
    green: '#1e8e3e',
    pink: '#d01884',
    purple: '#9334e6',
    cyan: '#007b83',
    orange: '#fa903e',
  }[name];
}

/* ------------------------------------------------------------------ actions -- */

async function load({ force = false } = {}) {
  if (force) {
    dom.refresh.dataset.spinning = 'true';
    dom.refresh.disabled = true;
  }
  try {
    apply(await send({ type: 'load', force }));
  } catch (error) {
    showFatal(error);
  } finally {
    delete dom.refresh.dataset.spinning;
    dom.refresh.disabled = state.stage === 'onboarding';
  }
}

function apply(data) {
  state.stage = data.stage;
  if (data.settings) state.settings = { ...state.settings, ...data.settings };
  if (data.viewer) state.viewer = data.viewer;
  if (data.scopes) state.scopes = data.scopes;
  if (data.group) {
    state.groupKeys = new Set(data.group.keys);
    state.groupOtherWindow = Boolean(data.group.otherWindow);
  }
  state.error = data.error ?? null;

  // Land on a scope that actually has something in it.
  if (data.stage === 'list' && (state.scopes[state.scope] ?? []).length === 0) {
    const populated = SCOPES.find((scope) => (state.scopes[scope] ?? []).length > 0);
    if (populated) state.scope = populated;
  }
  render();
}

function showFatal(error) {
  state.stage = 'error';
  state.error = error?.kind ? error : { kind: 'unknown', message: String(error?.message ?? error) };
  render();
}

async function openOne(pr) {
  if (state.busy) return;
  try {
    const result = await send({ type: 'openOne', pullRequest: { id: pr.id, url: pr.url } });
    if (result.groupId) markRowInGroup(pr.id);
  } catch (error) {
    dom.dockNote.dataset.tone = 'danger';
    dom.dockNote.textContent = errorCopy(error).short;
  }
}

async function openAll() {
  const todo = pending();
  if (todo.length === 0 || state.busy) return;

  state.busy = true;
  const button = dom.openAll;
  button.dataset.state = 'working';
  button.disabled = true;
  button.style.setProperty('--progress', '0');
  dom.openAllText.textContent = `Opening 0 of ${todo.length}…`;
  dom.dockNote.removeAttribute('data-tone');
  dom.dockNote.textContent = '';

  try {
    const result = await send({
      type: 'openAll',
      pullRequests: todo.map((pr) => ({ id: pr.id, url: pr.url })),
    });

    for (const id of result.opened) {
      // Never let a null key into the set: inGroup() would then treat any
      // unparseable PR url as already grouped.
      const key = pullRequestKey(todo.find((pr) => pr.id === id)?.url);
      if (key) state.groupKeys.add(key);
      markRowInGroup(id);
    }

    const added = result.created + result.adopted;
    button.style.setProperty('--progress', '1');
    button.dataset.state = 'done';
    dom.openAllText.replaceChildren(glyphCheck(), document.createTextNode(`Added ${added}`));

    if (result.failures.length > 0) {
      dom.dockNote.dataset.tone = 'danger';
      dom.dockNote.textContent = `${result.failures.length} could not be opened.`;
    } else if (result.adopted > 0) {
      dom.dockNote.textContent = `${result.adopted} already open ${
        result.adopted === 1 ? 'tab was' : 'tabs were'
      } moved in.`;
    }

    setTimeout(() => {
      state.busy = false;
      renderDock();
    }, 1400);
  } catch (error) {
    state.busy = false;
    button.dataset.state = 'idle';
    button.style.setProperty('--progress', '0');
    renderDock();
    dom.dockNote.dataset.tone = 'danger';
    dom.dockNote.textContent = errorCopy(error).short;
  }
}

function glyphCheck() {
  const node = glyph(icons.check);
  node.classList.add('primary-check');
  return node;
}

/* ---------------------------------------------------------------- settings -- */

function openSettings() {
  dom.settings.setAttribute('data-open', '');
  dom.settings.setAttribute('aria-hidden', 'false');
  dom.closeSettings.focus();
}

function closeSettings() {
  dom.settings.removeAttribute('data-open');
  dom.settings.setAttribute('aria-hidden', 'true');
  dom.openSettings.focus();
}

/* -------------------------------------------------------------- onboarding -- */

function tokenUrl() {
  const params = new URLSearchParams({
    scopes: 'repo,read:org',
    description: 'Pull Deck',
  });
  return `https://github.com/settings/tokens/new?${params}`;
}

async function connect(event) {
  event.preventDefault();
  const token = dom.tokenInput.value.trim();
  dom.tokenField.removeAttribute('data-invalid');
  dom.tokenError.replaceChildren();

  if (!token) {
    invalidToken('Paste a token to continue.');
    return;
  }

  dom.connect.dataset.state = 'working';
  dom.connect.disabled = true;
  dom.connect.style.setProperty('--progress', '0.9');
  dom.connect.querySelector('.primary-label').replaceChildren(el('span', null, 'Checking…'));

  try {
    apply(await send({ type: 'connect', token }));
    dom.tokenInput.value = '';
  } catch (error) {
    invalidToken(errorCopy(error).body);
  } finally {
    dom.connect.dataset.state = 'idle';
    dom.connect.disabled = false;
    dom.connect.style.setProperty('--progress', '0');
    dom.connect.querySelector('.primary-label').replaceChildren(el('span', null, 'Connect'));
  }
}

function invalidToken(message) {
  dom.tokenField.setAttribute('data-invalid', '');
  dom.tokenError.replaceChildren(glyph(icons.alert), el('span', null, message));
  dom.tokenInput.focus();
  dom.tokenInput.select();
}

/* ----------------------------------------------------------------- wiring -- */

function moveFocus(delta) {
  const rows = [...dom.list.querySelectorAll('.pr-row')];
  if (rows.length === 0) return;
  state.focusIndex = Math.max(0, Math.min(rows.length - 1, state.focusIndex + delta));
  rows[state.focusIndex].focus();
}

function switchScope(scope) {
  if (scope === state.scope) return;
  state.scope = scope;
  state.focusIndex = 0;
  render();
}

function wire() {
  setIcon(dom.refresh, icons.refresh);
  setIcon(dom.openSettings, icons.settings);
  setIcon(dom.closeSettings, icons.back);
  setIcon(dom.tokenReveal, icons.eye);
  dom.tokenIcon.append(glyph(icons.key));
  dom.tokenLink.href = tokenUrl();

  dom.refresh.addEventListener('click', () => load({ force: true }));
  dom.openSettings.addEventListener('click', openSettings);
  dom.closeSettings.addEventListener('click', closeSettings);
  dom.openAll.addEventListener('click', openAll);
  dom.tokenForm.addEventListener('submit', connect);

  dom.tokenReveal.addEventListener('click', () => {
    const shown = dom.tokenInput.type === 'text';
    dom.tokenInput.type = shown ? 'password' : 'text';
    dom.tokenReveal.setAttribute('aria-pressed', String(!shown));
    dom.tokenReveal.replaceChildren(
      glyph(shown ? icons.eye : icons.eyeOff),
      el('span', 'visually-hidden', shown ? 'Show token' : 'Hide token')
    );
  });

  dom.segments.addEventListener('click', (event) => {
    const button = event.target.closest('.segment');
    if (button) switchScope(button.dataset.scope);
  });

  dom.segments.addEventListener('keydown', (event) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = SCOPES[(SCOPES.indexOf(state.scope) + delta + SCOPES.length) % SCOPES.length];
    switchScope(next);
    dom.segments.querySelector(`[data-scope="${next}"]`).focus();
  });

  dom.groupName.addEventListener('change', () => {
    const groupTitle = dom.groupName.value.trim() || 'Pull Requests';
    dom.groupName.value = groupTitle;
    state.settings.groupTitle = groupTitle;
    send({ type: 'settings', patch: { groupTitle } })
      .then((data) => {
        if (data.group) {
          state.groupKeys = new Set(data.group.keys);
          state.groupOtherWindow = Boolean(data.group.otherWindow);
        }
        render();
      })
      .catch(showFatal);
  });

  dom.badgeSwitch.addEventListener('click', () => {
    const badgeEnabled = dom.badgeSwitch.getAttribute('aria-checked') !== 'true';
    state.settings.badgeEnabled = badgeEnabled;
    dom.badgeSwitch.setAttribute('aria-checked', String(badgeEnabled));
    send({ type: 'settings', patch: { badgeEnabled } }).catch(showFatal);
  });

  dom.forgetToken.addEventListener('click', async () => {
    try {
      closeSettings();
      state.viewer = null;
      state.scopes = { mine: [], reviewing: [], assigned: [] };
      apply(await send({ type: 'settings', patch: { token: null } }));
    } catch (error) {
      showFatal(error);
    }
  });

  document.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;

    if (event.key === 'Escape' && dom.settings.hasAttribute('data-open')) {
      closeSettings();
      return;
    }
    if (meta && event.key === 'Enter') {
      event.preventDefault();
      openAll();
      return;
    }
    if (meta && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      load({ force: true });
      return;
    }
    if (state.stage !== 'list' || dom.settings.hasAttribute('data-open')) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    }
  });

  for (const view of document.querySelectorAll('.view')) {
    view.addEventListener('scroll', syncScrollFade, { passive: true });
  }

  transport.onProgress((message) => {
    if (message?.type !== 'progress') return;
    if (message.total > 0 && typeof message.done === 'number') {
      dom.openAll.style.setProperty('--progress', String(message.done / message.total));
      dom.openAllText.textContent = `Opening ${message.done} of ${message.total}…`;
    }
    // Rows flip as their tab is genuinely created, not on a timer, and only
    // when that create actually succeeded.
    if (message.id && message.ok !== false) markRowInGroup(message.id);
  });
}

wire();
render();
load();
