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
import { pullRequestKey } from './pr-url.js';
import { tabUrl } from './tab-group.js';
import { parseShortcut, SHORTCUT_HOSTS } from './resolve.js';
import {
  loadState,
  connect,
  applySettings,
  openAll,
  openOne,
  refreshBadge,
  onProgress,
  resolveShortcut,
  serializeError,
} from './app-state.js';
import {
  ensureBridge,
  isReconnectAlarm,
  reconnect,
  pushState,
  bridgeStatus,
  connectNow,
} from './bridge.js';

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
    case 'bridge':
      return bridgeStatus();
    case 'bridgeRetry':
      return connectNow();
    case 'resolve':
      return resolveShortcut(message.query ?? '');
    default:
      throw new Error(`Unknown message: ${message?.type}`);
  }
}

// Progress goes to the popup if one is still open. Not being open is the
// normal case, not an error — the work continues in here either way.
onProgress((event) => {
  chrome.runtime.sendMessage({ type: 'progress', ...event }).catch(() => {});
});

/* --------------------------------------------------------------- shortcuts */

// `http://pull-dock/pr/abv-4242` is not a real address, and it is not supposed
// to be: the navigation is caught here, before the request leaves the browser,
// and replaced with the pull request the shorthand names.
//
// Caught at onBeforeNavigate rather than after the fact because the host does
// not resolve — wait for the navigation to fail and the user watches a DNS
// error page appear and then disappear.
//
// The event filter is load-bearing for more than speed: without it Chrome would
// wake this worker for every navigation in the browser, and the extension would
// be reading the address of every page you visit to answer "no" each time.
const SHORTCUT_FILTER = { url: SHORTCUT_HOSTS.map((hostEquals) => ({ hostEquals })) };

/**
 * Shortcut URLs already redirected, per tab.
 *
 * This most likely never fires. A session history entry is written when a
 * navigation *commits*, and this one is superseded before it ever does, so the
 * shortcut URL should leave no trace to go Back to.
 *
 * If it does leave one, though, the failure is nasty out of proportion to its
 * cause: Back lands on the shortcut URL, which fires this listener, which
 * bounces straight forward again — Back is dead for the rest of that tab's
 * life and nothing on screen explains why. So a repeat gets the chooser page
 * instead of another redirect. That is a real page, one Back away from wherever
 * the user actually started, and it says what the shorthand resolved to.
 *
 * The window is generous because the symptom it guards against is "pressed Back
 * a moment later", not "typed the same thing twice in a row".
 */
const redirected = new Map();
const LOOP_WINDOW_MS = 60_000;

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // top-level navigations only

  const shortcut = parseShortcut(details.url);
  if (!shortcut) return;

  const previous = redirected.get(details.tabId);
  const repeat = previous?.url === details.url && Date.now() - previous.at < LOOP_WINDOW_MS;
  redirected.set(details.tabId, { url: details.url, at: Date.now() });

  try {
    if (repeat) await showChooser(details.tabId, shortcut.query);
    else await routeShortcut(details.tabId, shortcut.query);
  } catch (error) {
    // Whatever went wrong, the one unacceptable outcome is leaving the tab
    // pointed at a host that cannot resolve. Say why, loudly: this listener has
    // no UI of its own, so an unexplained DNS error page is all the user sees.
    console.error('Pull Deck: could not resolve', details.url, error);
    await showChooser(details.tabId, shortcut.query).catch(() => {});
  }
}, SHORTCUT_FILTER);

chrome.tabs.onRemoved.addListener((tabId) => redirected.delete(tabId));

async function routeShortcut(tabId, query) {
  const result = await resolveShortcut(query);

  // One unambiguous answer is the only case worth redirecting on. Everything
  // else — nothing found, several candidates, no token yet — is a question the
  // user has to answer, so it gets a page rather than a guess.
  if (result.status !== 'one') return showChooser(tabId, query);

  const target = result.matches[0].url;
  const open = await findOpenTab(target, tabId);
  if (!open) {
    await chrome.tabs.update(tabId, { url: target });
    return;
  }

  // Already open somewhere: go to that tab instead of making a second one.
  // Duplicating is the single thing this extension exists to not do.
  //
  // Closing the tab the user typed into is only safe once they are demonstrably
  // somewhere else. If focusing the existing tab failed — it was closed in the
  // last few milliseconds, its window went away — closing this one too would
  // leave them nowhere, having asked to be taken somewhere.
  if (await focusTab(open)) await dismissTab(tabId, target);
  else await chrome.tabs.update(tabId, { url: target });
}

/** The tab already showing this pull request, by identity rather than URL. */
async function findOpenTab(url, exceptTabId) {
  const key = pullRequestKey(url);
  if (!key) return null;
  const tabs = await chrome.tabs.query({});
  return (
    tabs.find((tab) => tab.id !== exceptTabId && pullRequestKey(tabUrl(tab)) === key) ?? null
  );
}

/** @returns {Promise<boolean>} whether the user is now actually looking at it. */
async function focusTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    return false; // closed between finding it and focusing it
  }
}

/**
 * Close the tab the shortcut was typed into, having sent the user elsewhere.
 *
 * Except when it is the last one in its window: closing that closes the window,
 * and no shortcut should ever cost somebody a window. In that case it goes to
 * the pull request instead — a second tab on the same PR is untidy, but the
 * next "Open in group" adopts it rather than opening a third.
 */
async function dismissTab(tabId, fallbackUrl) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    if (siblings.length <= 1) {
      await chrome.tabs.update(tabId, { url: fallbackUrl });
      return;
    }
    await chrome.tabs.remove(tabId);
  } catch {
    // Already gone.
  }
}

/**
 * The query goes in the URL and the page resolves it a second time, rather than
 * the matches being handed over directly. That is deliberate: the page then
 * survives a reload, and a service worker torn down between the two calls
 * changes nothing. The second call is cheap — `resolveShortcut` reads the same
 * cache, and its one throttle-bypassing refetch cannot fire twice because the
 * first call is what put `headRefName` in the cache.
 *
 * No web_accessible_resources entry: the extension navigating its own tab to
 * its own page is not a web-originated load, and declaring it would let any
 * site probe for this extension by fetching the page. If a miss ever lands on a
 * blank tab rather than here, that reasoning was wrong — add resolve.html to
 * web_accessible_resources with `matches` limited to SHORTCUT_HOSTS, which are
 * hosts no real page can ever be served from.
 */
function showChooser(tabId, query) {
  const url = `${chrome.runtime.getURL('src/resolve.html')}?q=${encodeURIComponent(query)}`;
  return chrome.tabs.update(tabId, { url });
}

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
