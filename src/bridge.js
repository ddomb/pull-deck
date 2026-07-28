// Bridge to the macOS menu bar app, over Chrome native messaging.
//
// Direction matters here and it is the opposite of what you would want. Chrome
// native messaging is extension-initiated only: a native process cannot open a
// connection into an extension. Chrome spawns the host executable itself, one
// process per connectNative() call, and kills it on disconnect.
//
// So the extension reaches out and holds the channel open. The host executable
// is a thin relay that forwards between this port and a Unix socket owned by
// the long-running menu bar app. When the port dies, the relay dies with it and
// the app loses its channel with no way to get it back — nothing will relaunch
// it but us. Hence the reconnect loop below; it is not optional polish.

import {
  loadState,
  openScope,
  openOneById,
  applySettings,
  onProgress,
  serializeError,
} from './app-state.js';

const HOST_NAME = 'com.pulldeck.bridge';
const RECONNECT_ALARM = 'pull-deck-bridge-reconnect';
const PROTOCOL_VERSION = 1;

// Backoff in minutes. Chrome's alarm floor is 30 seconds, and the tail is long
// because the overwhelmingly common reason for failure is "the menu bar app was
// never installed" — that should cost almost nothing, forever.
const BACKOFF_MINUTES = [0.5, 1, 2, 5, 15, 30];

let port = null;
let attempt = 0;
let detachProgress = null;

/** Idempotent: safe to call on every service worker start. */
export function ensureBridge() {
  if (port) return;
  openPort();
}

function openPort() {
  let opened;
  try {
    opened = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    // Thrown when the nativeMessaging permission is missing entirely.
    console.warn('Pull Deck bridge: could not connect —', error?.message ?? error);
    scheduleReconnect();
    return;
  }

  port = opened;
  // Note: the backoff counter is NOT reset here. connectNative() hands back a
  // Port synchronously even when no host exists — the failure only surfaces
  // later via onDisconnect. Resetting on connect would therefore make a missing
  // menu bar app respawn a process every 30 seconds forever. The counter is
  // cleared in handleMessage instead, on the first byte that proves the relay
  // is genuinely alive.
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    // lastError is the only signal distinguishing "host not installed" from a
    // clean shutdown, and it is only readable inside this handler.
    const reason = chrome.runtime.lastError?.message;
    if (reason) console.info('Pull Deck bridge: disconnected —', reason);
    teardown();
    scheduleReconnect();
  });

  detachProgress = onProgress((event) => post({ type: 'progress', ...event }));

  post({ type: 'hello', version: PROTOCOL_VERSION, extensionId: chrome.runtime.id });
  void pushState();
}

function teardown() {
  port = null;
  if (detachProgress) {
    detachProgress();
    detachProgress = null;
  }
}

function scheduleReconnect() {
  const delayInMinutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)];
  attempt += 1;
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes });
}

/** Wired from the service worker's single alarm listener. */
export function isReconnectAlarm(name) {
  return name === RECONNECT_ALARM;
}

export function reconnect() {
  if (port) return;
  openPort();
}

function post(message) {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // Racing a disconnect. onDisconnect will schedule the retry.
    teardown();
  }
}

/** Push current state to the app unprompted; it has no way to poll cheaply. */
export async function pushState() {
  if (!port) return;
  try {
    post({ type: 'state', state: await loadState() });
  } catch (error) {
    post({ type: 'state', error: serializeError(error) });
  }
}

async function handleMessage(message) {
  attempt = 0; // proof of life: something is actually on the other end
  const id = message?.id ?? null;
  try {
    const data = await dispatch(message);
    if (id !== null) post({ type: 'reply', id, ok: true, data });
    // Any command can change what the list looks like.
    await pushState();
  } catch (error) {
    if (id !== null) post({ type: 'reply', id, ok: false, error: serializeError(error) });
  }
}

function dispatch(message) {
  switch (message?.type) {
    case 'getState':
      return loadState({ force: Boolean(message.force) });
    // The app names a scope; it never sends URLs. Resolving the list in
    // app-state.js is what keeps the pull-request identity rule in exactly one
    // place instead of being reimplemented in Swift.
    case 'openAll':
      return openScope(message.scope);
    case 'openOne':
      return openOneById(message.prId);
    case 'settings':
      return applySettings(message.patch ?? {});
    case 'ping':
      return Promise.resolve({ pong: true, version: PROTOCOL_VERSION });
    default:
      return Promise.reject(new Error(`Unknown bridge command: ${message?.type}`));
  }
}
