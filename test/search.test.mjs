// One query table, run through every path a search takes: the matcher itself
// (popup, via the worker's resolve message) and the bridge `search` command
// (menu bar app and Claude mod, via the relay).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { findMatches } from '../src/resolve.js';
import { fakeChrome, cached, pullRequest, tick } from './helpers/chrome.mjs';
import { BRIDGE_PROTOCOL_VERSION } from '../src/bridge-protocol.js';

const table = JSON.parse(readFileSync(new URL('./fixtures/search-cases.json', import.meta.url)));
const rows = table.pullRequests.map(({ scope, ...pr }) => ({ ...pullRequest(pr), scope }));

test('the matcher returns the table', () => {
  for (const { query, expect, why } of table.cases) {
    const got = findMatches(query, rows).matches.map((pr) => pr.id);
    assert.deepEqual(got, expect, `${query} (${why})`);
  }
});

test('the bridge search command returns the table, without pushing state', async () => {
  const scopes = { mine: [], reviewing: [], assigned: [] };
  for (const { scope, ...pr } of rows) scopes[scope].push(pr);
  const h = fakeChrome({ cache: cached({ fetchedAt: Date.now(), scopes }) });
  const { ensureBridge } = await import('../src/bridge.js');
  ensureBridge();
  h.listeners.nativeMessage[0]({ type: 'hello', version: BRIDGE_PROTOCOL_VERSION, accepted: true });
  await tick();

  let id = 100;
  const replies = [];
  for (const { query, expect, why } of table.cases) {
    h.calls.posted.length = 0;
    h.listeners.nativeMessage[0]({ id: ++id, type: 'search', query });
    await tick();
    const reply = h.calls.posted.find((m) => m.type === 'reply' && m.id === id);
    assert.equal(reply?.ok, true, `${query} replied`);
    assert.deepEqual(reply.data.prIds, expect, `${query} (${why})`);
    assert.equal(reply.data.status, expect.length === 0 ? 'none' : 'one', query);
    assert.ok(!h.calls.posted.some((m) => m.type === 'state'), `${query} pushed no state`);
    replies.push({ query, data: reply.data });
  }

  // The Swift and mod tests replay these instead of reimplementing the matcher.
  const file = new URL('./fixtures/search-replies.json', import.meta.url);
  const fresh = { pullRequests: table.pullRequests, replies };
  if (process.env.UPDATE_FIXTURES) writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')),
    fresh,
    'search-replies.json is stale: UPDATE_FIXTURES=1 npm test'
  );
});
