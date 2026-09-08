export const pullRequest = (overrides = {}) => ({
  id: 'pr1',
  number: 1,
  title: 'A change',
  url: 'https://github.com/acme/api/pull/1',
  repo: 'acme/api',
  repository: { nameWithOwner: 'acme/api' },
  headRefName: 'feature/ABC-123',
  updatedAt: new Date().toISOString(),
  isDraft: false,
  additions: 1,
  deletions: 0,
  ...overrides,
});

export const cached = (overrides = {}) => ({
  viewer: { login: 'old-user' },
  scopes: { mine: [pullRequest()], reviewing: [], assigned: [] },
  fetchedAt: Date.now() - 5_000,
  rateLimit: {
    remaining: 4900,
    limit: 5000,
    resetAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
  ...overrides,
});

export function githubResponse(login = 'old-user', overrides = {}, headers = {}) {
  return new Response(
    JSON.stringify({
      data: {
        viewer: { login },
        mine: { nodes: [pullRequest()], pageInfo: { hasNextPage: false } },
        reviewing: { nodes: [], pageInfo: { hasNextPage: false } },
        assigned: { nodes: [], pageInfo: { hasNextPage: false } },
        rateLimit: cached().rateLimit,
        ...overrides,
      },
    }),
    { status: 200, headers }
  );
}

export const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
export const tick = () => new Promise((r) => setImmediate(r));

export function fakeChrome(overrides = {}) {
  const store = { token: 'old-token', cache: cached(), ...overrides };
  const tabs = [],
    groups = [],
    listeners = {};
  const calls = { fetches: 0, badges: [], created: [], removed: [], focused: [], posted: [] };
  const event = (name) => ({
    addListener: (fn) => {
      (listeners[name] ??= []).push(fn);
    },
  });
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => structuredClone(store),
        set: async (patch) => {
          Object.assign(store, structuredClone(patch));
        },
        remove: async (keys) => {
          for (const key of keys) delete store[key];
        },
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        calls.badges.push(text);
      },
      setBadgeBackgroundColor: async () => {},
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      getLastFocused: async () => ({ id: 1 }),
      update: async () => ({ id: 1 }),
    },
    tabGroups: {
      get: async (id) => {
        const g = groups.find((g) => g.id === id);
        if (!g) throw Error('Group closed');
        return { ...g };
      },
      query: async (q) => groups.filter((g) => g.title === q.title).map((g) => ({ ...g })),
      update: async (id, patch) => {
        const g = groups.find((g) => g.id === id);
        Object.assign(g, patch);
        return { ...g };
      },
      onRemoved: event('groupRemoved'),
    },
    tabs: {
      query: async (q = {}) =>
        tabs
          .filter(
            (t) =>
              (q.groupId === undefined || q.groupId === t.groupId) &&
              (q.windowId === undefined || q.windowId === t.windowId)
          )
          .map((t) => ({ ...t })),
      get: async (id) => {
        const t = tabs.find((t) => t.id === id);
        if (!t) throw Error('Tab closed');
        return { ...t };
      },
      create: async (props) => {
        const t = { ...props, id: tabs.length + 100, groupId: -1 };
        tabs.push(t);
        calls.created.push(t);
        return { ...t };
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        if (groupId === undefined) {
          groupId = groups.length + 500;
          groups.push({ id: groupId, windowId: createProperties.windowId, title: '' });
        }
        for (const t of tabs) if (tabIds.includes(t.id)) t.groupId = groupId;
        return groupId;
      },
      update: async (id, patch) => {
        const t = tabs.find((t) => t.id === id);
        if (!t) throw Error('Tab closed');
        Object.assign(t, patch);
        if (patch.active) calls.focused.push(id);
        return { ...t };
      },
      remove: async (id) => {
        calls.removed.push(id);
      },
      onRemoved: event('tabRemoved'),
    },
    runtime: {
      id: 'test',
      onMessage: event('message'),
      onInstalled: event('installed'),
      onStartup: event('startup'),
      sendMessage: async () => {},
      getURL: (p) => `chrome-extension://test/${p}`,
      connectNative: () => ({
        onMessage: event('nativeMessage'),
        onDisconnect: event('nativeDisconnect'),
        postMessage: (message) => calls.posted.push(message),
        disconnect: () => {},
      }),
    },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event('alarm') },
    webNavigation: {
      onBeforeNavigate: event('navigate'),
      getFrame: async () => ({ documentId: 'doc1' }),
    },
  };
  globalThis.fetch = async () => {
    calls.fetches++;
    return githubResponse();
  };
  return { store, tabs, groups, calls, listeners };
}
