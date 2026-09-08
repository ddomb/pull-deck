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
  chrome.webNavigation.getFrame = async () => ({ documentId: 'doc2' });
  assert.equal(await guard(), false);
});
