// All network and tab work happens here, never in the popup.
//
// The popup is a document that Chrome destroys the instant focus leaves it, and
// there is "no way to keep the popup open after the user has clicked away". A
// create-tabs-then-group sequence started in the popup would strand itself
// half-finished. So the popup only ever sends one message and renders whatever
// comes back.

import { fetchPullRequests, mergeScopes, GitHubError } from './github.js';
import { openIntoGroup, readGroupState } from './tab-group.js';
import { readSettings, writeSettings } from './store.js';

const ALARM = 'pull-deck-refresh';
const REFRESH_MINUTES = 15;
const CACHE_TTL_MS = 60_000;
const BADGE_BG = '#1d7f8c';

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: serializeError(error) })
  );
  return true; // keeps the response channel open for the async handler
});

async function handle(message) {
  switch (message?.type) {
    case 'load':
      return loadState({ force: Boolean(message.force) });
    case 'connect':
      return connect(message.token);
    case 'openAll':
      return openAll(message.pullRequests ?? []);
    case 'openOne':
      return openOne(message.pullRequest);
    case 'settings':
      return applySettings(message.patch ?? {});
    default:
      throw new Error(`Unknown message: ${message?.type}`);
  }
}

// -------------------------------------------------------------------- state

/** Everything the popup needs for a full render, in one round trip. */
async function loadState({ force }) {
  const settings = await readSettings();
  if (!settings.token) {
    return { stage: 'onboarding', settings: publicSettings(settings) };
  }

  let cache = settings.cache;
  const stale = !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  let error = null;

  if (force || stale) {
    try {
      cache = await fetchPullRequests(settings.token);
      await writeSettings({ cache, lastError: null });
      await refreshBadge(cache, settings);
    } catch (caught) {
      error = serializeError(caught);
      await writeSettings({ lastError: error });
      // A cached list is still worth showing next to a transient failure.
      if (!cache) return { stage: 'error', error, settings: publicSettings(settings) };
    }
  }

  const group = await safeGroupState(settings);

  return {
    stage: 'list',
    settings: publicSettings(settings),
    viewer: cache.viewer,
    scopes: cache.scopes,
    rateLimit: cache.rateLimit,
    fetchedAt: cache.fetchedAt,
    group,
    error,
  };
}

async function connect(token) {
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

async function applySettings(patch) {
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

  return { settings: publicSettings(settings), group: await safeGroupState(settings) };
}

// ------------------------------------------------------------------ opening

async function openAll(pullRequests) {
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

async function openOne(pullRequest) {
  if (!pullRequest?.url) throw new Error('No pull request given.');
  const result = await openAll([pullRequest]);

  // A single row click means "take me there", so this one does steal focus.
  const [tab] = await chrome.tabs.query({ url: canonicalPattern(pullRequest.url) });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return result;
}

/** Match pattern covering /pull/123 and every sub-path under it. */
function canonicalPattern(url) {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}*`;
}

/** Progress for a popup that may or may not still be alive. */
function emit(event) {
  chrome.runtime.sendMessage({ type: 'progress', ...event }).catch(() => {
    // No popup listening. Expected, and not a problem: the work continues here.
  });
}

// -------------------------------------------------------------------- badge

async function refreshBadge(cache, settings) {
  if (!settings.badgeEnabled || !cache) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const count = mergeScopes(cache.scopes).length;
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: REFRESH_MINUTES });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: REFRESH_MINUTES });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const settings = await readSettings();
  if (!settings.token || !settings.badgeEnabled) return;
  try {
    const cache = await fetchPullRequests(settings.token);
    await writeSettings({ cache, lastError: null });
    await refreshBadge(cache, settings);
  } catch (error) {
    // Surface it in the popup instead of retrying in a loop out of sight.
    await writeSettings({ lastError: serializeError(error) });
    if (error instanceof GitHubError && error.kind === 'badToken') {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    }
  }
});

// Keep the saved group id honest: if the user closes the group, forget it.
chrome.tabGroups.onRemoved.addListener(async (group) => {
  const settings = await readSettings();
  if (settings.groupId === group.id) await writeSettings({ groupId: null });
});

// ------------------------------------------------------------------ helpers

async function safeGroupState(settings) {
  try {
    return await readGroupState({
      savedGroupId: settings.groupId,
      title: settings.groupTitle,
    });
  } catch {
    return { groupId: null, keys: [], otherWindow: false };
  }
}

function publicSettings(settings) {
  return {
    groupTitle: settings.groupTitle,
    groupColor: settings.groupColor,
    badgeEnabled: settings.badgeEnabled,
    hasToken: Boolean(settings.token),
    tokenTail: settings.token ? settings.token.slice(-4) : '',
  };
}

function serializeError(error) {
  if (error instanceof GitHubError) {
    return {
      kind: error.kind,
      message: error.message,
      retryAt: error.retryAt ? error.retryAt.toISOString() : null,
    };
  }
  return { kind: 'unknown', message: String(error?.message ?? error), retryAt: null };
}
