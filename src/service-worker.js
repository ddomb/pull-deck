// Wiring only. The work lives in app-state.js, which both the popup and the
// macOS menu bar app reach through — the popup over chrome.runtime messaging,
// the app over the native messaging bridge.
//
// Nothing here runs in the popup. Chrome destroys a popup document the instant
// focus leaves it, and there is "no way to keep the popup open after the user
// has clicked away", so a create-tabs-then-group sequence started there would
// strand itself half-finished.

import { fetchPullRequests, GitHubError } from './github.js';
import { readSettings, writeSettings } from './store.js';
import {
  loadState,
  connect,
  applySettings,
  openAll,
  openOne,
  refreshBadge,
  onProgress,
  serializeError,
} from './app-state.js';
import { ensureBridge, isReconnectAlarm, reconnect, pushState } from './bridge.js';

const REFRESH_ALARM = 'pull-deck-refresh';
const REFRESH_MINUTES = 15;

/* --------------------------------------------------------- popup messaging */

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

// Progress goes to the popup if one is still open. Not being open is the
// normal case, not an error — the work continues in here either way.
onProgress((event) => {
  chrome.runtime.sendMessage({ type: 'progress', ...event }).catch(() => {});
});

/* ------------------------------------------------------------------ alarms */

function scheduleRefresh() {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES });
}

chrome.runtime.onInstalled.addListener(scheduleRefresh);
chrome.runtime.onStartup.addListener(scheduleRefresh);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (isReconnectAlarm(alarm.name)) {
    reconnect();
    return;
  }
  if (alarm.name !== REFRESH_ALARM) return;

  const settings = await readSettings();
  if (!settings.token || !settings.badgeEnabled) return;
  try {
    const cache = await fetchPullRequests(settings.token);
    await writeSettings({ cache, lastError: null });
    await refreshBadge(cache, settings);
    await pushState();
  } catch (error) {
    // Surface it in the popup instead of retrying in a loop out of sight.
    await writeSettings({ lastError: serializeError(error) });
    if (error instanceof GitHubError && error.kind === 'badToken') {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    }
    await pushState();
  }
});

// Keep the saved group id honest: if the user closes the group, forget it.
chrome.tabGroups.onRemoved.addListener(async (group) => {
  const settings = await readSettings();
  if (settings.groupId === group.id) await writeSettings({ groupId: null });
});

/* ------------------------------------------------------------------ bridge */

// Top level, so the bridge is re-established every time the service worker
// spins up — whatever woke it. A missing menu bar app costs one failed spawn
// and then backs off.
ensureBridge();
