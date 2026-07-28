/* Dev-only chrome stub for the generated preview. Classic script on purpose:
   it must run before popup.js (a deferred module) reads the transport. */

(() => {
  const scenario = new URLSearchParams(location.search).get('scenario') ?? 'mixed';
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

  const mine = [
    {
      id: 'pr1',
      number: 4120,
      title: 'Stop the session refresher from thundering on cold start',
      url: 'https://github.com/abovesec/platform-api/pull/4120',
      repo: 'abovesec/platform-api',
      isDraft: false,
      updatedAt: hoursAgo(0.4),
      additions: 214,
      deletions: 61,
      reviewDecision: 'APPROVED',
      checks: 'SUCCESS',
    },
    {
      id: 'pr2',
      number: 887,
      title: 'Extension: batch identity lookups behind a single debounced call',
      url: 'https://github.com/abovesec/browser-extension/pull/887',
      repo: 'abovesec/browser-extension',
      isDraft: false,
      updatedAt: hoursAgo(3),
      additions: 48,
      deletions: 12,
      reviewDecision: 'CHANGES_REQUESTED',
      checks: 'FAILURE',
    },
    {
      id: 'pr3',
      number: 231,
      title: 'Route every read through the primary replica while the rollout settles',
      url: 'https://github.com/abovesec/infra/pull/231',
      repo: 'abovesec/infra',
      isDraft: true,
      updatedAt: hoursAgo(27),
      additions: 1904,
      deletions: 233,
      reviewDecision: null,
      checks: 'PENDING',
    },
    {
      id: 'pr4',
      number: 76,
      title: 'Bump terraform provider to 5.62 and re-pin the state lock table',
      url: 'https://github.com/abovesec/terraform-live/pull/76',
      repo: 'abovesec/terraform-live',
      isDraft: false,
      updatedAt: hoursAgo(52),
      additions: 9,
      deletions: 9,
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'SUCCESS',
    },
    {
      id: 'pr5',
      number: 5501,
      title: 'Drop the legacy device-fingerprint column now that nothing reads it',
      url: 'https://github.com/abovesec/platform-api/pull/5501',
      repo: 'abovesec/platform-api',
      isDraft: false,
      updatedAt: hoursAgo(190),
      additions: 12,
      deletions: 486,
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'ERROR',
    },
  ];

  const reviewing = [
    {
      id: 'pr6',
      number: 4131,
      title: 'Add per-tenant rate limiting to the ingest gateway',
      url: 'https://github.com/abovesec/platform-api/pull/4131',
      repo: 'abovesec/platform-api',
      isDraft: false,
      updatedAt: hoursAgo(1.2),
      additions: 331,
      deletions: 27,
      reviewDecision: 'REVIEW_REQUIRED',
      checks: 'SUCCESS',
    },
    {
      id: 'pr7',
      number: 44,
      title: 'Docs: correct the local stack bootstrap order',
      url: 'https://github.com/abovesec/handbook/pull/44',
      repo: 'abovesec/handbook',
      isDraft: false,
      updatedAt: hoursAgo(8),
      additions: 22,
      deletions: 4,
      reviewDecision: 'REVIEW_REQUIRED',
      checks: null,
    },
  ];

  const assigned = [mine[1]];

  const byScenario = {
    mixed: { keys: ['github.com/abovesec/platform-api#4120', 'github.com/abovesec/infra#231'] },
    list: { keys: [] },
    empty: { empty: true },
    onboarding: { onboarding: true },
    error: { error: { kind: 'badToken', message: 'GitHub rejected this token.' } },
    ratelimit: {
      error: {
        kind: 'rateLimited',
        message: 'GitHub rate limit reached.',
        retryAt: new Date(Date.now() + 22 * 60_000).toISOString(),
      },
    },
    loading: { hang: true },
  };

  const config = byScenario[scenario] ?? byScenario.mixed;
  const groupKeys = new Set(config.keys ?? []);
  let progressHandler = () => {};

  const settings = {
    groupTitle: 'Pull Requests',
    groupColor: 'cyan',
    badgeEnabled: true,
    hasToken: true,
    tokenTail: '9f2c',
  };

  const listPayload = () => ({
    stage: 'list',
    settings,
    viewer: { login: 'ddomb', avatarUrl: '' },
    scopes: config.empty ? { mine: [], reviewing: [], assigned: [] } : { mine, reviewing, assigned },
    rateLimit: { remaining: 4987, limit: 5000, resetAt: hoursAgo(-1), cost: 3 },
    fetchedAt: Date.now(),
    group: { groupId: 12, keys: [...groupKeys], otherWindow: false },
    error: config.error ?? null,
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  globalThis.__pullDeckTransport = {
    onProgress(handler) {
      progressHandler = handler;
    },
    async send(message) {
      await sleep(160);

      if (message.type === 'load' || message.type === 'connect') {
        if (config.hang) return new Promise(() => {});
        if (config.onboarding && message.type === 'load') {
          return { ok: true, data: { stage: 'onboarding', settings: { ...settings, hasToken: false } } };
        }
        if (config.error && !config.keys) {
          return { ok: true, data: { stage: 'error', settings, error: config.error } };
        }
        return { ok: true, data: listPayload() };
      }

      if (message.type === 'settings') {
        Object.assign(settings, message.patch ?? {});
        if (message.patch?.token === null) {
          return { ok: true, data: { stage: 'onboarding', settings: { ...settings, hasToken: false } } };
        }
        return { ok: true, data: { settings, group: { groupId: 12, keys: [...groupKeys], otherWindow: false } } };
      }

      if (message.type === 'openAll' || message.type === 'openOne') {
        const list = message.pullRequests ?? [message.pullRequest];
        const total = list.length;
        // Mirrors exactly what app-state.js forwards, envelope and all.
        progressHandler({ type: 'progress', kind: 'start', total, done: 0 });
        const opened = [];
        for (let i = 0; i < total; i++) {
          await sleep(260);
          opened.push(list[i].id);
          groupKeys.add(`stub-${list[i].id}`);
          progressHandler({
            type: 'progress',
            kind: 'tab',
            done: i + 1,
            total,
            id: list[i].id,
            ok: true,
          });
        }
        await sleep(180);
        return {
          ok: true,
          data: {
            created: total,
            adopted: 0,
            skipped: 0,
            groupId: 12,
            groupWindowId: 1,
            movedWindow: false,
            opened,
            failures: [],
          },
        };
      }

      return { ok: false, error: { kind: 'unknown', message: `unhandled ${message.type}` } };
    },
  };
})();
