import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { findMatches } from '../src/resolve.js';
import { cached, fakeChrome, pullRequest, tick } from './helpers/chrome.mjs';

let instance = 0;
async function mount(name, query = '') {
  const h = fakeChrome();
  const page = new JSDOM(readFileSync(new URL(`../src/${name}.html`, import.meta.url), 'utf8'), {
    url: `https://example.test/src/${name}.html${query}`,
  });
  globalThis.window = page.window;
  globalThis.document = page.window.document;
  globalThis.location = page.window.location;
  globalThis.CSS = { escape: (s) => String(s) };
  const state = {
    stage: 'list',
    ...cached(),
    authRevision: 1,
    settings: {
      groupTitle: 'Pull Requests',
      groupColor: 'cyan',
      badgeEnabled: true,
      hasToken: true,
    },
    group: { keys: [] },
  };
  const sent = [],
    all = [pullRequest({ reviewDecision: 'APPROVED', checks: 'FAILURE' })];
  const options = { focused: true, stale: false };
  chrome.tabs.getCurrent = async () => ({ id: 42, windowId: 1 });
  const send = async (message) => {
    sent.push(message);
    if (message.type === 'load') return { ok: true, data: structuredClone(state) };
    if (message.type === 'resolve')
      return {
        ok: true,
        data: { query: message.query, ...findMatches(message.query, all), stale: options.stale },
      };
    if (message.type === 'openShortcut' || message.type === 'openOne')
      return { ok: true, data: { focused: options.focused, failures: [], opened: [all[0].id] } };
    if (message.type === 'bridge') return { ok: true, data: { connected: false } };
    return { ok: true, data: { settings: state.settings } };
  };
  chrome.runtime.sendMessage = send;
  globalThis.__pullDeckTransport = { send, onProgress: () => {} };
  await import(`../src/${name === 'popup' ? 'popup' : 'resolve-page'}.js?ui=${instance++}`);
  await tick();
  return {
    ...h,
    state,
    all,
    options,
    sent,
    document,
    window,
    close: () => {
      page.window.dispatchEvent(new page.window.Event('pagehide'));
      page.window.close();
      delete globalThis.__pullDeckTransport;
    },
    key: (element, key, extra = {}) =>
      element.dispatchEvent(
        new page.window.KeyboardEvent('keydown', { key, bubbles: true, ...extra })
      ),
  };
}

test('chooser Enter does not open a sole fallback row for an unmatched ticket', async () => {
  const h = await mount('resolve', '?q=ABC-999');
  try {
    h.key(h.document.querySelector('#query'), 'Enter');
    await tick();
    assert.equal(h.sent.filter((m) => m.type === 'openShortcut').length, 0);
  } finally {
    h.close();
  }
});

test('chooser retains itself when the requested PR could not be focused', async () => {
  const h = await mount('resolve', '?q=ABC-123');
  try {
    h.options.focused = false;
    h.document.querySelector('.pr-row').click();
    await tick();
    assert.equal(h.calls.removed.length, 0);
    assert.match(h.document.querySelector('#foot').textContent, /could not be focused/);
  } finally {
    h.close();
  }
});

test('leaving the chooser prevents a delayed completion from removing the source tab', async () => {
  const h = await mount('resolve', '?q=ABC-123');
  try {
    h.document.querySelector('.pr-row').click();
    h.window.dispatchEvent(new h.window.Event('pagehide'));
    await tick();
    assert.equal(h.calls.removed.length, 0);
  } finally {
    h.close();
  }
});

test('settings makes the covered content inert and suppresses Open All shortcuts', async () => {
  const h = await mount('popup');
  try {
    h.document.querySelector('#open-settings').click();
    assert.equal(h.document.querySelector('#stage').hasAttribute('inert'), true);
    assert.equal(h.document.querySelector('#open-all').closest('[inert]').tagName, 'FOOTER');
    h.key(h.document.querySelector('#group-name'), 'Enter', { ctrlKey: true });
    await tick();
    assert.equal(h.sent.filter((m) => m.type === 'openAll').length, 0);
    h.document.querySelector('#close-settings').click();
    assert.equal(h.document.querySelector('#stage').hasAttribute('inert'), false);
  } finally {
    h.close();
  }
});

test('a changed row keeps keyboard focus on the same PR after refresh', async () => {
  const h = await mount('popup');
  try {
    h.document.querySelector('.pr-row').focus();
    h.state.scopes.mine[0].checks = 'FAILURE';
    h.key(h.document.activeElement, 'r', { ctrlKey: true });
    await tick();
    assert.equal(h.document.activeElement.dataset.id, 'pr1');
    assert.match(h.document.activeElement.getAttribute('aria-label'), /Checks failed/);
  } finally {
    h.close();
  }
});

test('changes in another scope do not rebuild the current rows', async () => {
  const h = await mount('popup');
  try {
    const row = h.document.querySelector('.pr-row');
    h.state.scopes.assigned.push(pullRequest({ id: 'other' }));
    h.key(h.document, 'r', { ctrlKey: true });
    await tick();
    assert.equal(h.document.querySelector('.pr-row'), row);
  } finally {
    h.close();
  }
});

test('chooser row names include both review and CI state', async () => {
  const h = await mount('resolve', '?q=ABC-123');
  try {
    const label = h.document.querySelector('.pr-row').getAttribute('aria-label');
    assert.match(label, /Approved/);
    assert.match(label, /Checks failed/);
  } finally {
    h.close();
  }
});
