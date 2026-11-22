import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceGuard, shortcutFromLocation } from '../src/shortcut.js';
import { fakeChrome } from './helpers/chrome.mjs';

test('declarative redirects target only the exact shortcut hosts', () => {
  const rules = JSON.parse(readFileSync(new URL('../rules/shortcuts.json', import.meta.url)));
  for (const rule of rules) {
    assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
    assert.equal(rule.action.type, 'redirect');
    assert.equal(
      new RegExp(rule.condition.regexFilter).test('https://pull-dock.evil.test/pr/ABC-123'),
      false
    );
  }
  for (const input of [
    'http://pull-dock/pr/ABC-123',
    'https://pulldeck.test:1234/pr/acme%2Fapi/1',
    'http://pull-deck/?q=ABC-123&unrelated=true',
  ]) {
    const rule = rules.find((r) => new RegExp(r.condition.regexFilter, 'i').test(input));
    assert.ok(rule, input);
    const destination = input.replace(new RegExp(rule.condition.regexFilter, 'i'), () =>
      rule.action.redirect.regexSubstitution.replace('\\0', () => input)
    );
    assert.ok(shortcutFromLocation(new URL(destination))?.query);
  }
});
test('an older document or pending new navigation cannot own a shortcut action', async () => {
  const h = fakeChrome();
  const url = chrome.runtime.getURL('src/resolve.html') + '?q=ABC-123';
  h.tabs.push({ id: 1, url });
  const guard = sourceGuard({ tab: { id: 1 }, url, documentId: 'doc1' });
  assert.equal(await guard(), true);
  h.tabs[0].pendingUrl = 'https://example.test/';
  assert.equal(await guard(), false);
  delete h.tabs[0].pendingUrl;
  chrome.runtime.getContexts = async () => [];
  assert.equal(await guard(), false, 'the document that asked is gone');
});

test('the resolver page that asked can own its shortcut action', async () => {
  // Chrome's webNavigation API never reports chrome-extension:// frames, so the
  // check has to come from the extension's own contexts instead.
  const h = fakeChrome();
  const url = chrome.runtime.getURL('src/resolve.html') + '?shortcut=http://pull-dock/14561';
  h.tabs.push({ id: 1, url });
  const asked = [];
  chrome.runtime.getContexts = async (filter) => {
    asked.push(filter);
    return [{ contextType: 'TAB', documentId: 'doc1', tabId: 1, frameId: 0, documentUrl: url }];
  };
  assert.equal(await sourceGuard({ tab: { id: 1 }, url, documentId: 'doc1' })(), true);
  assert.deepEqual(asked, [{ documentIds: ['doc1'] }]);
  for (const other of [{ tabId: 2 }, { frameId: 3 }, { documentUrl: `${url}x` }]) {
    chrome.runtime.getContexts = async () => [
      { contextType: 'TAB', documentId: 'doc1', tabId: 1, frameId: 0, documentUrl: url, ...other },
    ];
    assert.equal(
      await sourceGuard({ tab: { id: 1 }, url, documentId: 'doc1' })(),
      false,
      JSON.stringify(other)
    );
  }
});
