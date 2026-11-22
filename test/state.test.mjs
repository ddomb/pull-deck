import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadState,
  connect,
  applySettings,
  openAll,
  openOne,
  resolveShortcut,
  openShortcut,
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
import { lookupFetch } from './helpers/outside.mjs';
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

/* ------------------------------------------- lookups outside my scopes -- */

const fresh = () => fakeChrome({ cache: cached({ fetchedAt: Date.now() }) });

test('a ticket outside my scopes resolves from GitHub and stores nothing', async () => {
  const h = fresh(),
    asked = [];
  const before = JSON.stringify(h.store);
  const stateBefore = JSON.stringify(await loadState());
  globalThis.fetch = lookupFetch(asked);
  const result = await resolveShortcut('ABV-13945');
  assert.equal(asked.length, 1, 'the cache missed, so GitHub was asked once');
  assert.equal(asked[0].variables.q, 'repo:Above-Security/above is:pr "ABV-13945"');
  assert.equal(result.status, 'one');
  assert.deepEqual(
    result.matches.map((pr) => pr.number),
    [14561]
  );
  assert.equal(result.outside.complete, true);
  assert.equal(JSON.stringify(h.store), before);
  assert.equal(JSON.stringify(await loadState()), stateBefore);
});

test('a bare number outside my scopes is one exact lookup', async () => {
  fresh();
  const asked = [];
  globalThis.fetch = lookupFetch(asked);
  const result = await resolveShortcut('14561');
  assert.equal(asked.length, 1);
  assert.match(asked[0].query, /repository\(owner: \$owner, name: \$name\)/);
  assert.deepEqual(asked[0].variables, { owner: 'Above-Security', name: 'above', number: 14561 });
  assert.equal(result.status, 'one');
  assert.equal(result.matches[0].url, 'https://github.com/Above-Security/above/pull/14561');
});

test('a number GitHub does not know is a miss, not an error', async () => {
  fresh();
  globalThis.fetch = lookupFetch();
  const result = await resolveShortcut('99999999');
  assert.equal(result.status, 'none');
  assert.equal(result.lookup, undefined);
});

test('two pull requests for one ticket go to the chooser', async () => {
  fresh();
  globalThis.fetch = lookupFetch();
  const result = await resolveShortcut('ABV-13001');
  assert.equal(result.status, 'many');
  assert.deepEqual(result.matches.map((pr) => pr.number).sort(), [14144, 14231]);
});

test('a hit in my own scopes never asks GitHub', async () => {
  const h = fresh();
  const result = await resolveShortcut('ABC-123');
  assert.equal(result.status, 'one');
  assert.equal(h.calls.fetches, 0);
});

test('under 100 points the lookup refuses, says why, and leaves the cooldown alone', async () => {
  const cache = cached({ fetchedAt: Date.now() });
  cache.rateLimit.remaining = 99;
  const h = fakeChrome({ cache, nextFetchAt: 7 });
  const before = JSON.stringify(h.store);
  const result = await resolveShortcut('ABV-13945');
  assert.equal(h.calls.fetches, 0);
  assert.equal(result.status, 'none');
  assert.match(result.lookup.message, /99 .*points/);
  assert.equal(JSON.stringify(h.store), before);
});

test('the budget check does not wait out the refresh cooldown', async () => {
  // mayFetchNow says no for 4 seconds after any refresh; only its budget rule applies here.
  const cache = cached({ fetchedAt: Date.now() });
  cache.rateLimit.remaining = 400;
  fakeChrome({ cache });
  globalThis.fetch = lookupFetch();
  assert.equal((await resolveShortcut('ABV-13945')).status, 'one');
});

test('a failed lookup says why and writes nothing', async () => {
  for (const reply of [
    async () => {
      throw TypeError('offline');
    },
    async () =>
      new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }), {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
      }),
  ]) {
    const h = fresh();
    const before = JSON.stringify(h.store);
    globalThis.fetch = reply;
    const result = await resolveShortcut('ABV-13945');
    assert.equal(result.status, 'none');
    assert.ok(result.lookup.message);
    assert.equal(JSON.stringify(h.store), before);
  }
});

test('an outside pull request opens by identity and is never stored', async () => {
  const h = fresh();
  const before = JSON.stringify(h.store.cache);
  const result = await openShortcut({
    prId: 'PR_14561',
    outside: { repo: 'Above-Security/above', number: 14561 },
  });
  assert.equal(result.opened.length, 1);
  assert.equal(h.calls.created[0].url, 'https://github.com/Above-Security/above/pull/14561');
  assert.equal(JSON.stringify(h.store.cache), before);
});

test('an outside open only builds github.com pull request URLs', async () => {
  fresh();
  for (const outside of [
    { repo: 'evil.test/../x', number: 1 },
    { repo: 'a/b', number: -1 },
    { repo: 'a/b', number: '1' },
    { repo: 'a', number: 1 },
  ])
    await assert.rejects(openShortcut({ prId: 'x', outside }), /No valid pull request/);
});

/* ------------------------------------------------ shortcut speed, 3B -- */

const oldList = () => fakeChrome({ cache: cached({ fetchedAt: Date.now() - 120_000 }) });

test('a PR number in my scopes opens from an old list without waiting for a refresh', async () => {
  const h = oldList();
  const result = await resolveShortcut('1');
  assert.equal(result.status, 'one');
  assert.equal(result.stale, false, 'a number names one PR however old the list is');
  assert.equal(h.calls.fetches, 0);
});

test('an outside lookup runs alongside the refresh of an old list', async () => {
  const h = oldList(),
    gate = deferred(),
    order = [];
  const lookup = lookupFetch();
  globalThis.fetch = async (url, options) => {
    if (options.body.includes('query PullDeck(')) {
      order.push('refresh started');
      await gate.promise;
      order.push('refresh done');
      h.calls.fetches++;
      return githubResponse();
    }
    order.push('lookup');
    return lookup(url, options);
  };
  const pending = resolveShortcut('ABV-13945');
  await tick();
  await tick();
  assert.deepEqual(order.slice().sort(), ['lookup', 'refresh started']);
  gate.resolve();
  const result = await pending;
  assert.equal(result.matches[0].number, 14561);
  assert.equal(h.calls.fetches, 1);
});

test('a refreshed list that now holds the ticket wins over the lookup', async () => {
  oldList();
  const mine = pullRequest({ id: 'mine-1', number: 77, headRefName: 'me/abv-13945-fix' });
  const lookup = lookupFetch();
  globalThis.fetch = async (url, options) =>
    options.body.includes('query PullDeck(')
      ? githubResponse('old-user', {
          mine: { nodes: [mine], pageInfo: { hasNextPage: false } },
        })
      : lookup(url, options);
  const result = await resolveShortcut('ABV-13945');
  assert.deepEqual(
    result.matches.map((pr) => pr.id),
    ['mine-1']
  );
  assert.equal(result.outside, undefined);
});
