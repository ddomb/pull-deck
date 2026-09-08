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
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_HOST } from './bridge-protocol.js';

const HOST_NAME = BRIDGE_HOST;
const RECONNECT_ALARM = 'pull-deck-bridge-reconnect';
const PROTOCOL_VERSION = BRIDGE_PROTOCOL_VERSION;

// Two different failures deserve two different retry policies, and Chrome's
// error strings tell them apart:
//
//   "Specified native messaging host not found."  — no manifest, so Chrome
//   "Access to the ... host is forbidden."           spawned nothing at all.
//
// Those cost a file lookup. Since the menu bar app installs the manifest as
// soon as it sees the extension, retrying promptly is what closes the setup
// loop without the user reloading anything.
//
// Anything else means the relay actually ran and then went away (usually: the
// app is not running). That is a real process spawn per attempt, so it earns a
// climbing backoff.
const CHEAP_RETRY_MINUTES = 1;
const BACKOFF_MINUTES = [0.5, 1, 2, 5, 15, 30];
const NOTHING_SPAWNED = /not found|forbidden/i;

let port = null;
let attempt = 0;
let lastReason = null;
let detachProgress = null;
let accepted = false;
let handshakeTimer = null;

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
  accepted = false;
  const connectionId = crypto.randomUUID();
  // Note: the backoff counter is NOT reset here. connectNative() hands back a
  // Port synchronously even when no host exists — the failure only surfaces
  // later via onDisconnect. Resetting on connect would therefore make a missing
  // menu bar app respawn a process every 30 seconds forever. The counter is
  // cleared in handleMessage instead, on the first byte that proves the relay
  // is genuinely alive.
  port.onMessage.addListener((message) => {
    if (port === opened) void handleMessage(message, opened, connectionId);
  });
  port.onDisconnect.addListener(() => {
    if (port !== opened) return;
    // lastError is the only signal distinguishing "host not installed" from a
    // clean shutdown, and it is only readable inside this handler.
    const reason = chrome.runtime.lastError?.message;
    if (reason) console.info('Pull Deck bridge: disconnected —', reason);
    failConnection(opened, reason ?? lastReason);
  });

  detachProgress = onProgress((event) => {
    if (port === opened && accepted && event.operationId?.startsWith(`${connectionId}:`)) {
      post({
        type: 'progress',
        ...event,
        operationId: event.operationId.slice(connectionId.length + 1),
      });
    }
  });

  post({ type: 'hello', version: PROTOCOL_VERSION, extensionId: chrome.runtime.id });
  if (port !== opened) return;
  handshakeTimer = setTimeout(() => {
    if (port !== opened || accepted) return;
    failConnection(
      opened,
      'The menu bar app did not complete the handshake. Rebuild and reopen the matching app.'
    );
  }, 10_000);
  handshakeTimer.unref?.();
}

function teardown() {
  clearTimeout(handshakeTimer);
  handshakeTimer = null;
  accepted = false;
  port = null;
  if (detachProgress) {
    detachProgress();
    detachProgress = null;
  }
}

function failConnection(target, reason) {
  if (port !== target) return;
  lastReason = reason ?? null;
  teardown();
  try {
    target.disconnect();
  } catch {
    /* already disconnected */
  }
  scheduleReconnect(reason);
}

function scheduleReconnect(reason) {
  if (NOTHING_SPAWNED.test(reason ?? '')) {
    // Do not advance the ladder: once the manifest appears and the relay really
    // runs, the escalating backoff should start from the beginning.
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: CHEAP_RETRY_MINUTES });
    return;
  }
  const delayInMinutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)];
  attempt += 1;
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes });
}

/** What the popup shows, and why it is not connected. */
export function bridgeStatus() {
  return { connected: accepted, connecting: Boolean(port) && !accepted, reason: lastReason };
}

/** Skip whatever backoff is pending and try right now. */
export function connectNow() {
  chrome.alarms.clear(RECONNECT_ALARM);
  attempt = 0;
  if (!port) openPort();
  return bridgeStatus();
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
  const target = port;
  try {
    port.postMessage(message);
  } catch (error) {
    failConnection(target, error?.message ?? 'The native connection closed during a send.');
  }
}

/** Push current state to the app unprompted; it has no way to poll cheaply. */
export async function pushState() {
  if (!port || !accepted) return;
  const target = port;
  try {
    const state = await loadState();
    if (port === target && accepted) post({ type: 'state', state });
  } catch (error) {
    if (port === target && accepted) post({ type: 'state', error: serializeError(error) });
  }
}

async function handleMessage(message, target, connectionId) {
  if (message?.type === 'hello') {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    if (message.version !== PROTOCOL_VERSION || message.accepted !== true) {
      failConnection(
        target,
        message.reason ??
          'The app and extension use different bridge versions. Rebuild and reopen the app.'
      );
      return;
    }
    accepted = true;
    attempt = 0;
    lastReason = null;
    await pushState();
    return;
  }
  if (!accepted) return;
  attempt = 0; // proof of life: something is actually on the other end
  const id = message?.id ?? null;
  try {
    const data = await dispatch(message, target, connectionId);
    if (port !== target || !accepted) return;
    if (id !== null) post({ type: 'reply', id, ok: true, data });
    // Any command can change what the list looks like.
    await pushState();
  } catch (error) {
    if (port === target && accepted && id !== null)
      post({ type: 'reply', id, ok: false, error: serializeError(error) });
  }
}

function dispatch(message, target, connectionId) {
  const operation = {
    operationId: `${connectionId}:native:${message.id}`,
    canContinue: async () => port === target && accepted,
  };
  switch (message?.type) {
    case 'getState':
      return loadState({ force: Boolean(message.force) });
    // The app names a scope; it never sends URLs. Resolving the list in
    // app-state.js is what keeps the pull-request identity rule in exactly one
    // place instead of being reimplemented in Swift.
    case 'openAll':
      return openScope(message.scope, operation);
    case 'openOne':
      return openOneById(message.prId, operation);
    case 'settings':
      return applySettings(message.patch ?? {});
    case 'ping':
      return Promise.resolve({ pong: true, version: PROTOCOL_VERSION });
    default:
      return Promise.reject(new Error(`Unknown bridge command: ${message?.type}`));
  }
}
