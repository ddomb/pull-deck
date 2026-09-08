import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPullRequests } from '../src/github.js';
import { githubResponse } from './helpers/chrome.mjs';
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

test('partial GraphQL results cannot replace a complete cache', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: { viewer: { login: 'user' }, mine: null },
        errors: [{ type: 'INTERNAL', path: ['mine'], message: 'Unavailable' }],
      })
    );
  await assert.rejects(fetchPullRequests('mock'), { kind: 'partial' });
});
test('a missing scope is not interpreted as an empty successful list', async () => {
  globalThis.fetch = async () => githubResponse('user', { mine: null });
  await assert.rejects(fetchPullRequests('mock'), { kind: 'partial' });
});
test('403 with a healthy remaining budget is forbidden even with reset headers', async () => {
  globalThis.fetch = async () =>
    new Response('{"message":"Access denied"}', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '4500', 'x-ratelimit-reset': '9999999999' },
    });
  await assert.rejects(fetchPullRequests('mock'), { kind: 'forbidden' });
});
test('secondary rate limiting honors retry-after before primary reset', async () => {
  globalThis.fetch = async () =>
    new Response('{"message":"secondary rate limit"}', {
      status: 403,
      headers: {
        'retry-after': '120',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '9999999999',
      },
    });
  await assert.rejects(
    fetchPullRequests('mock'),
    (error) =>
      error.kind === 'rateLimited' &&
      error.retryAt - Date.now() <= 120_000 &&
      error.retryAt > Date.now()
  );
});
test('requests time out and abort the actual fetch', async () => {
  globalThis.fetch = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  await assert.rejects(fetchPullRequests('mock', { timeoutMs: 5 }), { kind: 'timeout' });
});
test('scope truncation is retained for users and shortcut confidence', async () => {
  globalThis.fetch = async () =>
    githubResponse('user', { mine: { nodes: [], pageInfo: { hasNextPage: true } } });
  const result = await fetchPullRequests('mock');
  assert.equal(result.truncated.mine, true);
});
