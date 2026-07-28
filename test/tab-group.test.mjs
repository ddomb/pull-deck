// tab-group.js holds the actual product promise: click twice, get no
// duplicates. It talks only to the chrome.* APIs, so a fake is enough to prove
// the diffing, the group-identity fallback chain, and the create-then-group
// ordering. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIntoGroup, findGroup, readGroupState } from '../src/tab-group.js';

const PR = (n, extra = {}) => ({
  id: `pr${n}`,
  url: `https://github.com/abovesec/api/pull/${n}`,
  ...extra,
});

const FIVE = [PR(1), PR(2), PR(3), PR(4), PR(5)];

/** Minimal stand-in for the chrome APIs tab-group.js reaches for. */
function fakeChrome({ groups = [], tabs = [], failUrls = [], getThrows = false } = {}) {
  let nextTabId = 1000;
  let nextGroupId = 500;
  const calls = { created: [], grouped: [], updated: [], getAttempts: [] };
  const state = {
    groups: groups.map((g) => ({ windowId: 1, color: 'grey', ...g })),
    tabs: tabs.map((t) => ({ groupId: -1, windowId: 1, ...t })),
  };

  const api = {
    windows: {
      WINDOW_ID_CURRENT: -2,
      getLastFocused: async () => ({ id: 1 }),
      update: async () => {},
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async (id) => {
        calls.getAttempts.push(id);
        if (getThrows) throw new Error('No group with id ' + id);
        const found = state.groups.find((g) => g.id === id);
        if (!found) throw new Error('No group with id ' + id);
        return found;
      },
      query: async (q = {}) =>
        state.groups.filter((g) => (q.title === undefined ? true : g.title === q.title)),
      update: async (id, props) => {
        calls.updated.push({ id, ...props });
        const found = state.groups.find((g) => g.id === id);
        if (found) Object.assign(found, props);
        return found;
      },
    },
    tabs: {
      query: async (q = {}) =>
        state.tabs.filter((t) => {
          if (q.groupId !== undefined && t.groupId !== q.groupId) return false;
          if (q.windowId !== undefined && t.windowId !== q.windowId) return false;
          return true;
        }),
      create: async (props) => {
        if (failUrls.includes(props.url)) throw new Error('Cannot create tab');
        calls.created.push(props);
        const tab = { id: nextTabId++, url: props.url, windowId: props.windowId, groupId: -1 };
        state.tabs.push(tab);
        return tab;
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        calls.grouped.push({ tabIds: [...tabIds], groupId, createProperties });
        const id = groupId ?? nextGroupId++;
        if (groupId === undefined) {
          state.groups.push({ id, title: '', color: 'grey', windowId: createProperties.windowId });
        }
        for (const tabId of tabIds) {
          const tab = state.tabs.find((t) => t.id === tabId);
          if (tab) tab.groupId = id;
        }
        return id;
      },
      update: async (id, props) => {
        const tab = state.tabs.find((t) => t.id === id);
        return tab ? { ...tab, ...props } : undefined;
      },
    },
  };

  globalThis.chrome = api;
  return { calls, state, api };
}

const GROUP = { id: 42, title: 'Pull Requests', windowId: 1 };
const base = { title: 'Pull Requests', color: 'cyan', savedGroupId: 42 };

test('only the pull requests missing from the group are created', async () => {
  const { calls } = fakeChrome({
    groups: [GROUP],
    tabs: [
      { id: 1, url: 'https://github.com/abovesec/api/pull/1', groupId: 42 },
      { id: 2, url: 'https://github.com/abovesec/api/pull/2', groupId: 42 },
    ],
  });

  const result = await openIntoGroup({ ...base, pullRequests: FIVE });

  assert.equal(calls.created.length, 3, 'exactly the three absent PRs');
  assert.deepEqual(
    calls.created.map((c) => c.url),
    [
      'https://github.com/abovesec/api/pull/3',
      'https://github.com/abovesec/api/pull/4',
      'https://github.com/abovesec/api/pull/5',
    ]
  );
  assert.equal(result.skipped, 2);
  assert.equal(result.created, 3);
  assert.equal(result.groupId, 42, 'reused the existing group');
  assert.equal(calls.grouped.length, 1, 'one grouping call, not one per tab');
  assert.equal(calls.grouped[0].groupId, 42);
  assert.equal(calls.grouped[0].createProperties, undefined, 'no second group created');
});

test('every created tab is opened in the background', async () => {
  const { calls } = fakeChrome({ groups: [GROUP] });
  await openIntoGroup({ ...base, pullRequests: FIVE });
  assert.ok(
    calls.created.every((c) => c.active === false),
    'active:false, or creating a tab steals focus and kills the popup'
  );
});

test('a second run creates nothing', async () => {
  const harness = fakeChrome({ groups: [GROUP] });
  await openIntoGroup({ ...base, pullRequests: FIVE });
  const afterFirst = harness.calls.created.length;
  assert.equal(afterFirst, 5);

  const second = await openIntoGroup({ ...base, pullRequests: FIVE });
  assert.equal(harness.calls.created.length, afterFirst, 'no duplicate tabs on re-click');
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 5);
});

test('a tab already open at a sub-path is adopted, not duplicated', async () => {
  const { calls } = fakeChrome({
    groups: [GROUP],
    tabs: [
      // Ungrouped, and sitting on /files with a query string, which is where a
      // real open PR tab usually is.
      { id: 7, url: 'https://github.com/abovesec/api/pull/3/files?w=1', groupId: -1 },
    ],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(3)] });

  assert.equal(calls.created.length, 0, 'must not open a second copy');
  assert.equal(result.adopted, 1);
  assert.equal(result.created, 0);
  assert.deepEqual(calls.grouped[0].tabIds, [7], 'the existing tab was moved in');
});

test('with no group at all, one is created and then titled and coloured', async () => {
  const { calls } = fakeChrome({ groups: [] });

  const result = await openIntoGroup({
    ...base,
    savedGroupId: null,
    pullRequests: [PR(1), PR(2)],
  });

  assert.equal(calls.grouped.length, 1);
  assert.equal(calls.grouped[0].groupId, undefined);
  assert.deepEqual(calls.grouped[0].createProperties, { windowId: 1 });
  assert.deepEqual(calls.updated, [{ id: result.groupId, title: 'Pull Requests', color: 'cyan' }]);
});

test('a stale saved id falls through to the title lookup', async () => {
  const { calls } = fakeChrome({ groups: [{ id: 99, title: 'Pull Requests', windowId: 1 }] });

  const result = await openIntoGroup({ ...base, savedGroupId: 7, pullRequests: [PR(1)] });

  assert.deepEqual(calls.getAttempts, [7], 'tried the saved id first');
  assert.equal(result.groupId, 99, 'then found the group by title');
  assert.equal(calls.grouped[0].groupId, 99);
});

test('a renamed group is still found by saved id, and its title is restored', async () => {
  const { calls } = fakeChrome({
    groups: [{ id: 42, title: 'renamed by hand', windowId: 1 }],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(1)] });

  assert.equal(result.groupId, 42, 'title-only lookup would have created a second group');
  assert.equal(calls.grouped.length, 1);
  assert.equal(calls.grouped[0].createProperties, undefined);
  assert.deepEqual(calls.updated, [{ id: 42, title: 'Pull Requests', color: 'cyan' }]);
});

test('a tab still loading counts as present, via pendingUrl', async () => {
  // Chrome reports url:"" (not undefined) until navigation commits. `??` would
  // hand back "" and never look at pendingUrl, so reopening the popup while the
  // tabs were still loading used to duplicate every single one of them.
  const { calls } = fakeChrome({
    groups: [GROUP],
    tabs: [
      { id: 1, url: '', pendingUrl: 'https://github.com/abovesec/api/pull/1', groupId: 42 },
      { id: 2, url: '', pendingUrl: 'https://github.com/abovesec/api/pull/2', groupId: 42 },
    ],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(1), PR(2), PR(3)] });

  assert.equal(result.skipped, 2, 'both in-flight tabs are recognised');
  assert.deepEqual(calls.created.map((c) => c.url), [
    'https://github.com/abovesec/api/pull/3',
  ]);
});

test('readGroupState sees pull requests whose tabs have not committed yet', async () => {
  fakeChrome({
    groups: [GROUP],
    tabs: [{ id: 1, url: '', pendingUrl: 'https://github.com/abovesec/api/pull/9', groupId: 42 }],
  });
  const state = await readGroupState({ savedGroupId: 42, title: 'Pull Requests' });
  assert.deepEqual(state.keys, ['github.com/abovesec/api#9']);
});

test('a pinned tab is never dragged into the group', async () => {
  const { calls } = fakeChrome({
    groups: [GROUP],
    tabs: [
      { id: 5, url: 'https://github.com/abovesec/api/pull/1', groupId: -1, pinned: true },
    ],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(1)] });

  assert.equal(result.adopted, 0);
  assert.ok(!calls.grouped[0].tabIds.includes(5), 'pinned tabs stay pinned where they are');
});

test('unreadable tab urls are reported rather than silently duplicating', async () => {
  const { calls } = fakeChrome({
    groups: [GROUP],
    // What Chrome returns when the "tabs" permission is missing.
    tabs: [{ id: 1, url: undefined, groupId: 42 }],
  });

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await openIntoGroup({ ...base, pullRequests: [PR(1)] });
  } finally {
    console.error = original;
  }

  assert.equal(errors.length, 1, 'the failure is announced');
  assert.match(errors[0], /tabs" permission/);
  assert.equal(calls.created.length, 1, 'and it still opens rather than doing nothing');
});

test('a failed create is excluded from opened and reported as not ok', async () => {
  const failing = 'https://github.com/abovesec/api/pull/2';
  fakeChrome({ groups: [GROUP], failUrls: [failing] });

  const events = [];
  const result = await openIntoGroup({
    ...base,
    pullRequests: [PR(1), PR(2), PR(3)],
    onProgress: (event) => events.push(event),
  });

  assert.deepEqual(result.opened, ['pr1', 'pr3']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].id, 'pr2');

  const tabEvents = events.filter((e) => e.kind === 'tab');
  assert.deepEqual(
    tabEvents.map((e) => [e.id, e.ok]),
    [
      ['pr1', true],
      ['pr2', false],
      ['pr3', true],
    ],
    'the failing row must not be told it succeeded'
  );
});

test('progress reports a start event and counts up to the total', async () => {
  fakeChrome({ groups: [GROUP] });
  const events = [];
  await openIntoGroup({ ...base, pullRequests: FIVE, onProgress: (e) => events.push(e) });

  assert.equal(events[0].kind, 'start');
  assert.equal(events[0].total, 5);
  assert.deepEqual(
    events.filter((e) => e.kind === 'tab').map((e) => e.done),
    [1, 2, 3, 4, 5]
  );
  assert.equal(events.at(-1).kind, 'done');
});

test('progress events survive being wrapped in a {type:"progress"} envelope', async () => {
  // Both consumers forward these as {type:'progress', ...event}. When the event
  // carried its own `type`, the spread overwrote the discriminator and every
  // listener that filtered on type==='progress' silently dropped the lot — the
  // popup showed "Opening 0 of 5…" until the whole run finished.
  fakeChrome({ groups: [GROUP] });
  const events = [];
  await openIntoGroup({ ...base, pullRequests: FIVE, onProgress: (e) => events.push(e) });

  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.type, undefined, 'events must not carry a `type` key');
    const wrapped = { type: 'progress', ...event };
    assert.equal(wrapped.type, 'progress', 'the envelope must survive the spread');
    assert.ok(wrapped.kind, 'and the event kind must still be readable');
  }
});

test('tabIdByPr lets a caller focus a pull request without re-querying by url', async () => {
  fakeChrome({
    groups: [GROUP],
    tabs: [{ id: 11, url: 'https://github.com/abovesec/api/pull/1', groupId: 42 }],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(1), PR(2)] });

  assert.equal(result.tabIdByPr.pr1, 11, 'already-present PRs map to their existing tab');
  assert.equal(typeof result.tabIdByPr.pr2, 'number', 'newly created ones map too');
});

test('nothing to open touches no chrome mutation at all', async () => {
  const { calls } = fakeChrome({
    groups: [GROUP],
    tabs: [{ id: 1, url: 'https://github.com/abovesec/api/pull/1', groupId: 42 }],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(1)] });

  assert.equal(calls.created.length, 0);
  assert.equal(calls.grouped.length, 0);
  assert.equal(calls.updated.length, 0, 'no pointless title rewrite when idle');
  assert.equal(result.skipped, 1);
  assert.equal(result.tabIdByPr.pr1, 1);
});

test('tabs are created in the group window, not the focused one', async () => {
  const { calls } = fakeChrome({
    groups: [{ id: 42, title: 'Pull Requests', windowId: 9 }],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(1)] });

  assert.equal(calls.created[0].windowId, 9, 'follow the group, do not drag it across windows');
  assert.equal(result.movedWindow, true, 'and say so, since the group is elsewhere');
});

test('a stray in another window is left alone', async () => {
  const { calls } = fakeChrome({
    groups: [{ id: 42, title: 'Pull Requests', windowId: 1 }],
    tabs: [{ id: 8, url: 'https://github.com/abovesec/api/pull/1', groupId: -1, windowId: 5 }],
  });

  const result = await openIntoGroup({ ...base, pullRequests: [PR(1)] });

  assert.equal(result.adopted, 0, 'never yank a tab out of a different window');
  assert.equal(calls.created.length, 1);
  assert.ok(!calls.grouped[0].tabIds.includes(8));
});

test('findGroup returns null when there is nothing to find', async () => {
  fakeChrome({ groups: [] });
  assert.equal(await findGroup({ savedGroupId: null, title: 'Pull Requests', windowId: 1 }), null);
});

test('readGroupState reports the keys currently in the group', async () => {
  fakeChrome({
    groups: [GROUP],
    tabs: [
      { id: 1, url: 'https://github.com/abovesec/api/pull/1/files', groupId: 42 },
      { id: 2, url: 'https://github.com/abovesec/api/pull/2', groupId: 42 },
      { id: 3, url: 'https://news.ycombinator.com', groupId: 42 },
    ],
  });

  const state = await readGroupState({ savedGroupId: 42, title: 'Pull Requests' });

  assert.equal(state.groupId, 42);
  assert.deepEqual(state.keys.sort(), [
    'github.com/abovesec/api#1',
    'github.com/abovesec/api#2',
  ]);
  assert.equal(state.otherWindow, false);
});
