import { mergeScopes } from './github.js';
import { openIntoGroup, readGroupState, tabUrl } from './tab-group.js';
import { readSettings, writeSettings, withSettingsLock, GROUP_COLORS } from './store.js';
import { pullRequestKey } from './pr-url.js';
import { findMatches } from './resolve.js';
import { refreshSnapshot, connectAccount, forgetAccount, authEpoch, isStale } from './refresh.js';
import { refreshBadge } from './badge.js';
export { LIVE_INTERVAL_MS, mayFetchNow } from './refresh.js';
export { refreshBadge } from './badge.js';
export { serializeError } from './errors.js';

const progressListeners = new Set();
export function onProgress(listener) {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}
function emit(event) {
  for (const listener of progressListeners) {
    try {
      listener(event);
    } catch {
      /* detached client */
    }
  }
}

/** Produce a current account snapshot after any asynchronous group lookup. */
async function stateFrom() {
  const settings = await withSettingsLock(readSettings);
  const revision = authEpoch();
  const base = { settings: publicSettings(settings), authRevision: settings.authRevision };
  if (!settings.token) return { ...base, stage: 'onboarding' };
  if (!settings.cache)
    return {
      ...base,
      stage: 'error',
      error: settings.lastError ?? {
        kind: 'offline',
        message: 'Pull requests are not available yet.',
      },
    };
  const group = await safeGroupState(settings);
  const current = await withSettingsLock(readSettings);
  if (
    revision !== authEpoch() ||
    current.authRevision !== settings.authRevision ||
    current.token !== settings.token ||
    current.cache?.fetchedAt !== settings.cache?.fetchedAt
  )
    return stateFrom();
  const { cache } = settings;
  const scopes = Object.fromEntries(
    Object.entries(cache.scopes).map(([scope, list]) => [
      scope,
      list.map((pr) => ({ ...pr, key: pullRequestKey(pr.url) })),
    ])
  );
  return {
    ...base,
    stage: 'list',
    viewer: cache.viewer,
    scopes,
    group,
    fetchedAt: cache.fetchedAt,
    rateLimit: cache.rateLimit,
    truncated: cache.truncated ?? {},
    stale: isStale(cache),
    error: settings.lastError,
  };
}

export async function loadState(options = {}) {
  await refreshSnapshot(options);
  return stateFrom();
}
export async function connect(token) {
  await connectAccount(token);
  return stateFrom();
}

export async function applySettings(patch) {
  if (patch.token === null) {
    await forgetAccount();
    return stateFrom();
  }
  return withSettingsLock(async () => {
    const allowed = {};
    if (typeof patch.groupTitle === 'string')
      allowed.groupTitle = patch.groupTitle.trim().slice(0, 40) || 'Pull Requests';
    if (GROUP_COLORS.includes(patch.groupColor)) allowed.groupColor = patch.groupColor;
    if (typeof patch.badgeEnabled === 'boolean') allowed.badgeEnabled = patch.badgeEnabled;
    await writeSettings(allowed);
    const settings = await readSettings();
    if ('badgeEnabled' in allowed) await refreshBadge(settings.cache, settings);
    if (('groupTitle' in allowed || 'groupColor' in allowed) && settings.groupId !== null) {
      try {
        await chrome.tabGroups.update(settings.groupId, {
          title: settings.groupTitle,
          color: settings.groupColor,
        });
      } catch {
        await writeSettings({ groupId: null });
        settings.groupId = null;
      }
    }
    return {
      settings: publicSettings(settings),
      group: await safeGroupState(settings),
      authRevision: settings.authRevision,
    };
  });
}

let operations = Promise.resolve();
function enqueue(work) {
  const result = operations.then(work);
  operations = result.catch(() => {});
  return result;
}
const emptyResult = () => ({
  created: 0,
  adopted: 0,
  skipped: 0,
  groupId: null,
  groupWindowId: null,
  movedWindow: false,
  opened: [],
  failures: [],
  warnings: [],
  tabIdByPr: {},
  focused: false,
});

async function focusResult(result, pr, canContinue) {
  const tabId = result.tabIdByPr[pr.id];
  if (typeof tabId !== 'number' || !(await canContinue())) return result;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (!tab || !(await canContinue())) return result;
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    result.focused = true;
  } catch (error) {
    result.failures.push({
      id: pr.id,
      message: `Could not focus the pull request: ${error.message}`,
    });
  }
  return result;
}

async function runOpen(
  pullRequests,
  {
    focus = false,
    reuseAcrossWindows = false,
    sourceTabId,
    canContinue = async () => true,
    operationId = crypto.randomUUID(),
  } = {}
) {
  const progress = (event) => emit({ ...event, operationId });
  let result = emptyResult();
  try {
    if (!Array.isArray(pullRequests)) throw Error('Expected a list of pull requests.');
    const unique = [
      ...new Map(
        pullRequests
          .filter((pr) => pr?.id && pullRequestKey(pr.url))
          .map((pr) => [pullRequestKey(pr.url), pr])
      ).values(),
    ];
    if (!(await canContinue())) return { ...result, cancelled: true };
    const settings = await readSettings();
    if (focus && reuseAcrossWindows && unique.length === 1) {
      const key = pullRequestKey(unique[0].url);
      const tab = (await chrome.tabs.query({})).find(
        (t) => t.id !== sourceTabId && pullRequestKey(tabUrl(t)) === key
      );
      if (tab) {
        result.skipped = 1;
        result.tabIdByPr[unique[0].id] = tab.id;
        return await focusResult(result, unique[0], canContinue);
      }
    }
    result = {
      ...result,
      ...(await openIntoGroup({
        pullRequests: unique,
        title: settings.groupTitle,
        color: settings.groupColor,
        savedGroupId: settings.groupId,
        canContinue,
        onProgress: (event) => {
          if (event.kind !== 'done') progress(event);
        },
      })),
    };
    if (result.groupId !== null && result.groupId !== settings.groupId)
      await writeSettings({ groupId: result.groupId });
    if (focus && unique.length === 1 && result.failures.length === 0)
      await focusResult(result, unique[0], canContinue);
    return result;
  } finally {
    progress({
      kind: 'done',
      created: result.created,
      adopted: result.adopted,
      groupId: result.groupId,
    });
  }
}

export function openAll(pullRequests, options = {}) {
  return enqueue(() => runOpen(pullRequests, options));
}
export function openOne(pr, options = {}) {
  if (!pr?.url || !pullRequestKey(pr.url))
    return Promise.reject(Error('No valid pull request given.'));
  return enqueue(() => runOpen([pr], { ...options, focus: true }));
}
export async function openScope(scope, options = {}) {
  const settings = await readSettings();
  const list = settings.cache?.scopes?.[scope];
  if (!Array.isArray(list)) throw Error(`No pull requests loaded for "${scope}".`);
  return openAll(list, options);
}
export async function openOneById(id, options = {}) {
  const settings = await readSettings();
  const found = mergeScopes(settings.cache?.scopes ?? {}).find((pr) => pr.id === id);
  if (!found) throw Error(`No pull request with id ${id}.`);
  return openOne(found, options);
}

export async function resolveShortcut(query) {
  const state = await loadState({ branches: true });
  if (state.stage === 'onboarding') return { query, status: 'noToken', matches: [], all: [] };
  if (state.stage === 'error')
    return { query, status: 'error', error: state.error, matches: [], all: [] };
  const all = mergeScopes(state.scopes);
  const incomplete = all.some((pr) => typeof pr.headRefName !== 'string');
  return {
    query,
    ...findMatches(query, all),
    stale: state.stale || incomplete || Boolean(state.error),
    error: state.error,
    truncated: state.truncated,
  };
}

export async function safeGroupState(settings) {
  try {
    return await readGroupState({ savedGroupId: settings.groupId, title: settings.groupTitle });
  } catch {
    return { groupId: null, keys: [], otherWindow: false };
  }
}
export function publicSettings(settings) {
  return {
    groupTitle: settings.groupTitle,
    groupColor: settings.groupColor,
    badgeEnabled: settings.badgeEnabled,
    hasToken: Boolean(settings.token),
    tokenTail: settings.token ? settings.token.slice(-4) : '',
  };
}
