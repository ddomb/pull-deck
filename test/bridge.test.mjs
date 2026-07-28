// The bridge's reconnect loop is load-bearing: Chrome spawns the relay, and if
// the port dies nothing will ever bring it back except us. A silent failure
// here means the menu bar app just stops working with no error anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
/** Fresh module instance per test — bridge.js holds module-level port state. */
const freshBridge = () => import(`../src/bridge.js?case=${instance++}`);

function fakeChrome({ store = {}, connectThrows = false } = {}) {
  const calls = { alarms: [], posted: [], connects: 0, hostName: null };
  const listeners = { message: [], disconnect: [] };
  let lastError;

  const port = {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage: (m) => calls.posted.push(m),
  };

  globalThis.chrome = {
    runtime: {
      id: 'pulldecktestextensionid',
      get lastError() {
        return lastError;
      },
      connectNative(name) {
        calls.connects++;
        calls.hostName = name;
        if (connectThrows) throw new Error('nativeMessaging permission missing');
        return port;
      },
      sendMessage: async () => {},
    },
    alarms: { create: (name, opts) => calls.alarms.push({ name, ...opts }) },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (patch) => void Object.assign(store, patch),
        remove: async (keys) => {
          for (const k of [].concat(keys)) delete store[k];
        },
      },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { query: async () => [], create: async () => ({ id: 1 }), group: async () => 7, update: async () => ({}) },
    tabGroups: {
      get: async () => {
        throw new Error('no group');
      },
      query: async () => [],
      update: async () => {},
    },
    windows: { getLastFocused: async () => ({ id: 1 }), WINDOW_ID_CURRENT: -2 },
  };

  return { calls, listeners, store, setLastError: (v) => (lastError = v) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('connects to the documented host name and introduces itself', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();

  assert.equal(h.calls.connects, 1);
  assert.equal(h.calls.hostName, 'com.pulldeck.bridge');
  const hello = h.calls.posted.find((m) => m.type === 'hello');
  assert.ok(hello, 'sends a hello so the app can check protocol compatibility');
  assert.equal(hello.version, 1);
  assert.equal(hello.extensionId, 'pulldecktestextensionid');
});

test('ensureBridge is idempotent', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  bridge.ensureBridge();
  bridge.ensureBridge();
  bridge.ensureBridge();
  assert.equal(h.calls.connects, 1, 'one live port, however many service worker wakeups');
});

test('a disconnect schedules a reconnect', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();

  h.setLastError({ message: 'Specified native messaging host not found.' });
  h.listeners.disconnect.forEach((fn) => fn());

  assert.equal(h.calls.alarms.length, 1);
  assert.equal(h.calls.alarms[0].name, 'pull-deck-bridge-reconnect');
  assert.equal(h.calls.alarms[0].delayInMinutes, 0.5, 'first retry is prompt');
  assert.ok(bridge.isReconnectAlarm('pull-deck-bridge-reconnect'));
  assert.ok(!bridge.isReconnectAlarm('pull-deck-refresh'));
});

test('repeated failures back off and then cap', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  for (let i = 0; i < 8; i++) {
    bridge.reconnect();
    await settle();
    h.listeners.disconnect.at(-1)();
  }
  const delays = h.calls.alarms.map((a) => a.delayInMinutes);
  assert.deepEqual(delays, [0.5, 1, 2, 5, 15, 30, 30, 30], 'a missing app must cost almost nothing');
});

test('a connection that proves itself resets the backoff', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();

  // Climb the ladder with two dead connections.
  for (let i = 0; i < 2; i++) {
    bridge.reconnect();
    await settle();
    h.listeners.disconnect.at(-1)();
  }
  assert.deepEqual(h.calls.alarms.map((a) => a.delayInMinutes), [0.5, 1]);
  h.calls.alarms.length = 0;

  // Now a connection that actually carries traffic, then drops.
  bridge.reconnect();
  await settle();
  await h.listeners.message.at(-1)({ id: 1, type: 'ping' });
  await settle();
  h.listeners.disconnect.at(-1)();

  assert.equal(
    h.calls.alarms.at(-1).delayInMinutes,
    0.5,
    'a channel that worked and then dropped deserves a prompt retry, not a 30 minute one'
  );
});

test('a throwing connectNative still schedules a retry', async () => {
  const h = fakeChrome({ connectThrows: true });
  const bridge = await freshBridge();
  bridge.ensureBridge();
  assert.equal(h.calls.alarms.length, 1, 'no permission is not a reason to give up silently');
});

test('a command gets a reply carrying its id', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();
  h.calls.posted.length = 0;

  await h.listeners.message[0]({ id: 42, type: 'ping' });
  await settle();

  const reply = h.calls.posted.find((m) => m.type === 'reply');
  assert.equal(reply.id, 42);
  assert.equal(reply.ok, true);
  assert.equal(reply.data.pong, true);
});

test('an unknown command replies with an error rather than dying', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();
  h.calls.posted.length = 0;

  await h.listeners.message[0]({ id: 7, type: 'launchTheMissiles' });
  await settle();

  const reply = h.calls.posted.find((m) => m.type === 'reply');
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /Unknown bridge command/);
});

test('every command is followed by a fresh state push', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();
  h.calls.posted.length = 0;

  await h.listeners.message[0]({ id: 1, type: 'ping' });
  await settle();

  const state = h.calls.posted.find((m) => m.type === 'state');
  assert.ok(state, 'the app never has to poll');
  // No token in the fake store, so the engine reports onboarding.
  assert.equal(state.state.stage, 'onboarding');
});

test('a command with no id is fire-and-forget, not a crash', async () => {
  const h = fakeChrome();
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();
  h.calls.posted.length = 0;

  await h.listeners.message[0]({ type: 'ping' });
  await settle();

  assert.equal(h.calls.posted.filter((m) => m.type === 'reply').length, 0);
});

test('openAll names a scope, so no client ever builds a GitHub URL', async () => {
  const h = fakeChrome({
    store: {
      token: 'ghp_x',
      groupTitle: 'Pull Requests',
      groupColor: 'cyan',
      cache: {
        fetchedAt: Date.now(),
        viewer: { login: 'ddomb' },
        rateLimit: null,
        scopes: {
          mine: [{ id: 'pr1', url: 'https://github.com/abovesec/api/pull/1', number: 1 }],
          reviewing: [],
          assigned: [],
        },
      },
    },
  });
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();
  h.calls.posted.length = 0;

  await h.listeners.message[0]({ id: 9, type: 'openAll', scope: 'mine' });
  await settle();

  const reply = h.calls.posted.find((m) => m.type === 'reply');
  assert.equal(reply.ok, true, reply.error?.message);
  assert.equal(reply.data.created, 1, 'resolved the scope from the extension-side cache');
});

test('an unknown scope fails loudly instead of opening nothing', async () => {
  const h = fakeChrome({ store: { token: 'ghp_x', cache: { fetchedAt: Date.now(), scopes: {} } } });
  const bridge = await freshBridge();
  bridge.ensureBridge();
  await settle();
  h.calls.posted.length = 0;

  await h.listeners.message[0]({ id: 3, type: 'openAll', scope: 'nonsense' });
  await settle();

  const reply = h.calls.posted.find((m) => m.type === 'reply');
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /No pull requests loaded/);
});
