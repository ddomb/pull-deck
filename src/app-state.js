// The engine. Every caller goes through here: the popup over
// chrome.runtime messaging, and the macOS menu bar app over the native
// messaging bridge.
//
// Kept deliberately free of transport concerns so the two callers cannot drift
// apart. In particular the group's title and colour are read from storage here
// and never accepted from a caller — otherwise the popup and the menu bar app
// would each have their own idea of which group is "the" group.

import { fetchPullRequests, mergeScopes, GitHubError } from './github.js';
import { openIntoGroup, readGroupState } from './tab-group.js';
import { readSettings, writeSettings } from './store.js';
import { pullRequestKey } from './pr-url.js';
import { findMatches } from './resolve.js';

const CACHE_TTL_MS = 60_000;
const BADGE_BG = '#1d7f8c';

// Live polling, and the guards that keep it from being expensive.
//
// One GraphQL round trip costs about 3 points against a 5,000/hour budget, so
// a 5-second cadence spends roughly 2,160 points an hour — viable, but only
// worth paying while somebody is actually looking. Callers ask for `force` as
// often as they like; these two constants decide what actually reaches GitHub.
export const LIVE_INTERVAL_MS = 5_000;

/** No forced refresh may hit the network more often than this, ever. */
const MIN_FETCH_INTERVAL_MS = 4_000;

/** Below this many points remaining, stretch to one request a minute. */
const LOW_BUDGET_POINTS = 500;
const LOW_BUDGET_INTERVAL_MS = 60_000;

/** Below this, stop entirely and coast on cache until the budget resets. */
const EXHAUSTED_POINTS = 100;

/* --------------------------------------------------------------- progress -- */

const progressListeners = new Set();

/** Subscribe to tab-opening progress. Returns an unsubscribe function. */
export function onProgress(listener) {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function emit(event) {
  for (const listener of progressListeners) {
    try {
      listener(event);
    } catch {
      // One dead listener must not stop the tabs from opening.
    }
  }
}

/* ------------------------------------------------------- budget throttle -- */

/**
 * May a forced refresh actually reach GitHub right now?
 *
 * This is the single choke point for every caller — the popup's live loop, the
 * menu bar app's live loop, the background alarm and the refresh button all
 * pass through it. Rate limiting is enforced here rather than in each caller
 * so that two surfaces polling at once cannot double the spend.
 */
export function mayFetchNow(cache, now = Date.now()) {
  if (!cache?.fetchedAt) return true;
  const remaining = cache.rateLimit?.remaining;
  if (typeof remaining === 'number' && remaining < EXHAUSTED_POINTS) {
    // Coast on cache until the window resets rather than spending the last of
    // the budget on a list that has not changed.
    const resetAt = Date.parse(cache.rateLimit?.resetAt ?? '');
    return Number.isFinite(resetAt) ? now >= resetAt : false;
  }
  const floor =
    typeof remaining === 'number' && remaining < LOW_BUDGET_POINTS
      ? LOW_BUDGET_INTERVAL_MS
      : MIN_FETCH_INTERVAL_MS;
  return now - cache.fetchedAt >= floor;
}

/* ------------------------------------------------------------------ state -- */

/** Everything a client needs for a full render, in one round trip. */
export async function loadState({ force = false } = {}) {
  const settings = await readSettings();
  if (!settings.token) {
    return { stage: 'onboarding', settings: publicSettings(settings) };
  }

  let cache = settings.cache;
  const stale = !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  // Surface whatever the background refresh last hit, so a token revoked
  // hours ago is explained rather than just showing a stale list.
  let error = settings.lastError ?? null;

  if (force && cache && !mayFetchNow(cache)) {
    // Asked for fresh data sooner than the budget allows. Serving the cache is
    // the honest answer: the alternative is spending the hour's allowance in
    // twenty minutes and then showing nothing at all.
    return {
      stage: 'list',
      settings: publicSettings(settings),
      viewer: cache.viewer,
      scopes: cache.scopes,
      rateLimit: cache.rateLimit,
      fetchedAt: cache.fetchedAt,
      group: await safeGroupState(settings),
      error,
    };
  }

  if (force || stale) {
    try {
      cache = await fetchPullRequests(settings.token);
      await writeSettings({ cache, lastError: null });
      await refreshBadge(cache, settings);
      error = null; // a good fetch clears whatever the last background one hit
    } catch (caught) {
      error = serializeError(caught);
      await writeSettings({ lastError: error });
      // A cached list is still worth showing next to a transient failure.
      if (!cache) return { stage: 'error', error, settings: publicSettings(settings) };
    }
  }

  return {
    stage: 'list',
    settings: publicSettings(settings),
    viewer: cache.viewer,
    scopes: cache.scopes,
    rateLimit: cache.rateLimit,
    fetchedAt: cache.fetchedAt,
    group: await safeGroupState(settings),
    error,
  };
}

export async function connect(token) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) throw new GitHubError('badToken', 'Paste a token first.');

  // Validating and loading are the same request: no separate /user round trip.
  const cache = await fetchPullRequests(trimmed);
  await writeSettings({ token: trimmed, cache, lastError: null });
  const settings = await readSettings();
  await refreshBadge(cache, settings);

  return {
    stage: 'list',
    settings: publicSettings(settings),
    viewer: cache.viewer,
    scopes: cache.scopes,
    rateLimit: cache.rateLimit,
    fetchedAt: cache.fetchedAt,
    group: await safeGroupState(settings),
    error: null,
  };
}

export async function applySettings(patch) {
  const allowed = {};
  if (typeof patch.groupTitle === 'string') allowed.groupTitle = patch.groupTitle.trim().slice(0, 40);
  if (typeof patch.groupColor === 'string') allowed.groupColor = patch.groupColor;
  if (typeof patch.badgeEnabled === 'boolean') allowed.badgeEnabled = patch.badgeEnabled;
  if (patch.token === null) {
    await chrome.storage.local.remove(['token', 'cache', 'lastError']);
    await chrome.action.setBadgeText({ text: '' });
    return { stage: 'onboarding', settings: publicSettings(await readSettings()) };
  }

  await writeSettings(allowed);
  const settings = await readSettings();
  if ('badgeEnabled' in allowed) await refreshBadge(settings.cache, settings);

  // Push a rename or recolour straight to the live group. Otherwise it only
  // lands the next time a tab is actually created, and in the steady state
  // (everything already grouped) that never happens: Chrome would keep showing
  // the old title and colour indefinitely while clients reported the new one.
  if (('groupTitle' in allowed || 'groupColor' in allowed) && settings.groupId !== null) {
    try {
      await chrome.tabGroups.update(settings.groupId, {
        title: settings.groupTitle,
        color: settings.groupColor,
      });
    } catch {
      // Group was closed since we saved its id; forget it so the next open
      // creates a fresh one instead of failing again.
      await writeSettings({ groupId: null });
    }
  }

  return { settings: publicSettings(settings), group: await safeGroupState(settings) };
}

/* ---------------------------------------------------------------- opening -- */

export async function openAll(pullRequests) {
  const settings = await readSettings();
  const result = await openIntoGroup({
    pullRequests,
    title: settings.groupTitle,
    color: settings.groupColor,
    savedGroupId: settings.groupId,
    onProgress: emit,
  });

  if (result.groupId !== null && result.groupId !== settings.groupId) {
    await writeSettings({ groupId: result.groupId });
  }
  return result;
}

export async function openOne(pullRequest) {
  if (!pullRequest?.url) throw new Error('No pull request given.');
  const result = await openAll([pullRequest]);

  // Focus by tab id, not by re-querying the URL: a tab created a moment ago
  // often still reports an empty `url` (the destination sits in `pendingUrl`
  // until navigation commits), so a URL query would find nothing and the click
  // would appear to do nothing at all.
  const tabId = result.tabIdByPr?.[pullRequest.id];
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch {
      // Tab vanished between creating and focusing it. The grouping still held.
    }
  }
  return result;
}

/**
 * Open everything in one scope that is not already grouped.
 *
 * This exists for the menu bar app, which names a scope rather than sending
 * URLs. Resolving the list here means no client ever constructs a GitHub URL
 * or reimplements the pull-request identity rule — the single most dangerous
 * thing to have two copies of.
 */
export async function openScope(scope) {
  const settings = await readSettings();
  const list = settings.cache?.scopes?.[scope];
  if (!Array.isArray(list)) throw new Error(`No pull requests loaded for "${scope}".`);

  const { keys } = await safeGroupState(settings);
  const present = new Set(keys);
  const todo = list
    .filter((pr) => {
      const key = pullRequestKey(pr.url);
      return key !== null && !present.has(key);
    })
    .map((pr) => ({ id: pr.id, url: pr.url }));

  return openAll(todo);
}

/** Open a single pull request the client identified by id, not by URL. */
export async function openOneById(id) {
  const settings = await readSettings();
  const scopes = settings.cache?.scopes ?? {};
  for (const list of Object.values(scopes)) {
    const found = (list ?? []).find((pr) => pr.id === id);
    if (found) return openOne({ id: found.id, url: found.url });
  }
  throw new Error(`No pull request with id ${id}.`);
}

/* -------------------------------------------------------------- shortcuts -- */

/**
 * A cache from before branch names were fetched, which cannot answer a ticket
 * query at all. `headRefName` is always a string once fetched, so `undefined`
 * across the board is the signal — and it is checked on every entry rather than
 * some, because a single old row would otherwise mask a whole stale cache.
 */
function lacksBranches(list) {
  return list.length > 0 && list.every((pr) => pr.headRefName === undefined);
}

/**
 * Resolve a shortcut like "abv-4242" against the pull requests already loaded.
 *
 * Deliberately bypasses `mayFetchNow` in the one case below. The live poll
 * keeps the cache a few seconds old at all times, so the ordinary throttle
 * would refuse the very refresh that makes branch matching possible — and the
 * feature would look broken on exactly the reload that ships it. This costs one
 * request, once, and then never again.
 */
export async function resolveShortcut(query) {
  const settings = await readSettings();
  if (!settings.token) return { query, status: 'noToken', matches: [], all: [] };

  let cache = settings.cache;
  let list = cache ? mergeScopes(cache.scopes ?? {}) : [];

  if (!cache || lacksBranches(list)) {
    try {
      cache = await fetchPullRequests(settings.token);
      await writeSettings({ cache, lastError: null });
      await refreshBadge(cache, settings);
      list = mergeScopes(cache.scopes ?? {});
    } catch (caught) {
      // A stale list still answers a plain "#6081", so only a cold cache is
      // fatal here.
      if (!cache) {
        return { query, status: 'error', error: serializeError(caught), matches: [], all: [] };
      }
    }
  }

  return { query, ...findMatches(query, list) };
}

/* ------------------------------------------------------------------ badge -- */

export async function refreshBadge(cache, settings) {
  if (!settings.badgeEnabled || !cache) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const count = mergeScopes(cache.scopes).length;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}

/* ---------------------------------------------------------------- helpers -- */

export async function safeGroupState(settings) {
  try {
    return await readGroupState({
      savedGroupId: settings.groupId,
      title: settings.groupTitle,
    });
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

export function serializeError(error) {
  if (error instanceof GitHubError) {
    return {
      kind: error.kind,
      message: error.message,
      retryAt: error.retryAt ? error.retryAt.toISOString() : null,
    };
  }
  return { kind: 'unknown', message: String(error?.message ?? error), retryAt: null };
}
