import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadState,
  connect,
  applySettings,
  openAll,
  openOne,
  resolveShortcut,
  onProgress,
} from '../src/app-state.js';
import {
  cached,
  deferred,
  fakeChrome,
  githubResponse,
  pullRequest,
  tick,
} from './helpers/chrome.mjs';
import { withSettingsLock } from '../src/store.js';
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

test('overlapping caller operations create one tab and one group', async () => {
  const h = fakeChrome();
  await Promise.all([openAll([pullRequest()]), openAll([pullRequest()])]);
  assert.equal(h.calls.created.length, 1);
  assert.equal(h.groups.length, 1);
});

test('overlapping refresh callers share the same request', async () => {
  const h = fakeChrome(),
    gate = deferred();
  globalThis.fetch = async () => {
    h.calls.fetches++;
    await gate.promise;
    return githubResponse();
  };
  const pending = Promise.all([loadState({ force: true }), loadState({ force: true })]);
  await tick();
  gate.resolve();
  await pending;
  assert.equal(h.calls.fetches, 1);
});

test('ordinary stale loads respect an exhausted budget', async () => {
  const cache = cached({ fetchedAt: Date.now() - 120_000 });
  cache.rateLimit.remaining = 0;
  const h = fakeChrome({ cache });
  const result = await loadState();
  assert.equal(h.calls.fetches, 0);
  assert.equal(result.stage, 'list');
});

test('forgetting an account rejects delayed cache and badge writes', async () => {
  const h = fakeChrome(),
    gate = deferred();
  globalThis.fetch = async () => {
    await gate.promise;
    return githubResponse();
  };
  const pending = loadState({ force: true });
  await tick();
  await applySettings({ token: null });
  gate.resolve();
  const result = await pending;
  assert.ok(!h.store.token);
  assert.ok(!h.store.cache);
  assert.equal(h.calls.badges.at(-1), '');
  assert.equal(result.stage, 'onboarding');
});

test('a read begun during an auth transition cannot deliver old data after forgetting', async () => {
  fakeChrome({ cache: cached({ fetchedAt: Date.now() }) });
  const commit = deferred(),
    group = deferred();
  const held = withSettingsLock(() => commit.promise);
  await tick();
  const forgotten = applySettings({ token: null });
  chrome.windows.getLastFocused = async () => {
    await group.promise;
    return { id: 1 };
  };
  const reading = loadState();
  await tick();
  commit.resolve();
  await held;
  await forgotten;
  group.resolve();
  assert.equal((await reading).stage, 'onboarding');
});

test('replacing an account cannot receive an older account snapshot', async () => {
  const h = fakeChrome(),
    gate = deferred();
  globalThis.fetch = async (_url, options) => {
    if (options.headers.Authorization === 'Bearer old-token') {
      await gate.promise;
      return githubResponse('old-user');
    }
    return githubResponse('new-user');
  };
  const pending = loadState({ force: true });
  await tick();
  await connect('new-token');
  gate.resolve();
  const result = await pending;
  assert.equal(h.store.token, 'new-token');
  assert.equal(h.store.cache.viewer.login, 'new-user');
  assert.equal(result.viewer.login, 'new-user');
});

test('rate-limit errors persist a deadline and prevent immediate retries', async () => {
  const h = fakeChrome();
  globalThis.fetch = async () => {
    h.calls.fetches++;
    return new Response(
      JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'Rate limit' }] }),
      {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      }
    );
  };
  const first = await loadState({ force: true });
  await loadState({ force: true });
  assert.equal(h.calls.fetches, 1);
  assert.ok(Date.parse(first.error.retryAt) > Date.now());
});

test('shortcut resolution refreshes stale data', async () => {
  const h = fakeChrome({ cache: cached({ fetchedAt: Date.now() - 86_400_000 }) });
  await resolveShortcut('ABC-123');
  assert.equal(h.calls.fetches, 1);
});

test('a focus failure is an explicit failed placement outcome', async () => {
  fakeChrome();
  chrome.tabs.update = async () => {
    throw Error('Tab closed');
  };
  const result = await openOne(pullRequest());
  assert.equal(result.focused, false);
  assert.ok(result.failures.length > 0);
});

test('a grouping failure settles progress and retains retryable failures', async () => {
  const h = fakeChrome(),
    events = [];
  const detach = onProgress((e) => events.push(e));
  chrome.tabs.group = async () => {
    throw Error('Group disappeared');
  };
  const result = await openAll([pullRequest()]);
  detach();
  assert.equal(result.opened.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(h.tabs[0].groupId, -1);
  assert.equal(events.at(-1).kind, 'done');
  assert.ok(events.every((e) => e.operationId === events[0].operationId));
});

test('no-op operations still emit a terminal event', async () => {
  fakeChrome();
  const events = [],
    detach = onProgress((e) => events.push(e));
  await openAll([]);
  detach();
  assert.equal(events.at(-1).kind, 'done');
});

test('cancelled shortcut ownership cannot open or focus tabs', async () => {
  const h = fakeChrome();
  const result = await openOne(pullRequest(), { canContinue: async () => false });
  assert.equal(result.focused, false);
  assert.equal(h.calls.created.length, 0);
});

test('an unavailable fresh snapshot cannot authorize automatic shortcut navigation', async () => {
  const cache = cached({ fetchedAt: Date.now() - 120_000 });
  cache.rateLimit.remaining = 0;
  fakeChrome({ cache });
  const result = await resolveShortcut('ABC-123');
  assert.equal(result.stale, true);
});
