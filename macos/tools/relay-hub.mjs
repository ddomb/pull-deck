#!/usr/bin/env node
// End-to-end check of the relay binary as the hub between one extension and
// its upstream clients, standing in for Chrome, the menu bar app and viewers.
//
// It spawns the actual compiled executable, speaks Chrome's framing at its
// stdin/stdout, stands up a Unix socket where the app would be, and talks HTTP
// to viewer.sock the way the Claude Code mod does.
//
//   node macos/tools/relay-hub.mjs [path-to-pulldeck-bridge]

import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary =
  process.argv[2] ?? resolve(import.meta.dirname, '..', '.build', 'debug', 'pulldeck-bridge');

if (!existsSync(binary)) {
  console.error(`not ok - relay binary missing at ${binary}\n# run: swift build`);
  process.exit(1);
}

const identity = readFileSync(
  resolve(import.meta.dirname, '..', 'Sources/PullDeckKit/BuildIdentity.swift'),
  'utf8'
);
const extensionId = identity.match(/extensionID = "([^"]+)"/)[1];
const version = Number(identity.match(/protocolVersion = (\d+)/)[1]);

let checks = 0;
let failures = 0;
const check = (name, passed, detail = '') => {
  checks++;
  if (passed) console.log(`ok ${checks} - ${name}`);
  else {
    failures++;
    console.log(`not ok ${checks} - ${name}${detail ? `  # ${detail}` : ''}`);
  }
};

const frame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); // native byte order on macOS
  return Buffer.concat([header, body]);
};

function drain(buffer) {
  const out = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (buffer.length - offset - 4 < length) break;
    out.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return { messages: out, rest: buffer.subarray(offset) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
};

const directory = () => mkdtempSync(join(tmpdir(), 'pulldeck-'));

function launch({ appSocket, viewerSocket }) {
  const relay = spawn(binary, [`chrome-extension://${extensionId}/`], {
    env: { ...process.env, PULLDECK_SOCKET: appSocket, PULLDECK_VIEWER_SOCKET: viewerSocket },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const run = { relay, toChrome: [], exit: null };
  let stdout = Buffer.alloc(0);
  relay.stdout.on('data', (chunk) => {
    const { messages, rest } = drain(Buffer.concat([stdout, chunk]));
    stdout = rest;
    run.toChrome.push(...messages);
  });
  relay.on('exit', (code) => (run.exit = code));
  run.send = (message) => relay.stdin.write(frame(message));
  run.last = (predicate) => run.toChrome.filter(predicate).at(-1);
  return run;
}

/** A fake menu bar app: answers the relay's hello and records every line. */
function fakeApp(path, { accept = true } = {}) {
  const app = { lines: [], socket: null };
  app.server = net.createServer((socket) => {
    app.socket = socket;
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        app.lines.push(line);
        if (line.type === 'hello') {
          const reply = accept
            ? { type: 'hello', version, accepted: true }
            : { type: 'hello', version, accepted: false, reason: 'Another browser profile.' };
          socket.write(JSON.stringify(reply) + '\n');
          if (!accept) socket.end();
        }
      }
    });
  });
  app.listening = new Promise((r) => app.server.listen(path, r));
  app.write = (message) => app.socket.write(JSON.stringify(message) + '\n');
  return app;
}

function viewer(socketPath, method, path, body) {
  return new Promise((resolvePromise) => {
    const request = http.request({ socketPath, method, path }, (response) => {
      let text = '';
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* checked by the caller */
        }
        resolvePromise({ status: response.statusCode, json });
      });
    });
    request.on('error', (error) => resolvePromise({ status: 0, error }));
    if (body !== undefined) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });
}

const timeout = setTimeout(() => {
  console.log('not ok - timed out');
  process.exit(1);
}, 60_000);

/* A hello from the wrong build is refused by the relay itself. */
{
  const dir = directory();
  const run = launch({ appSocket: join(dir, 'b.sock'), viewerSocket: join(dir, 'v.sock') });
  run.send({ type: 'hello', version: version - 1, extensionId });
  await until(() => run.toChrome.length > 0);
  check('a mismatched hello is refused', run.toChrome[0]?.accepted === false);
  check('and no viewer socket is served', !existsSync(join(dir, 'v.sock')));
  run.relay.stdin.end();
  await until(() => run.exit !== null);
}

/* The main path: extension first, app later, a viewer throughout. */
const dir = directory();
const appSocket = join(dir, 'bridge.sock');
const viewerSocket = join(dir, 'viewer.sock');
const run = launch({ appSocket, viewerSocket });
run.send({ type: 'hello', version, extensionId });
await until(() => run.toChrome.length >= 2);
check(
  'the relay accepts the extension with no app open',
  run.toChrome[0]?.type === 'hello' &&
    run.toChrome[0]?.accepted === true &&
    run.toChrome[0]?.peer === 'relay'
);
check('and reports the app as absent', run.toChrome[1]?.type === 'peers' && !run.toChrome[1].app);

await until(() => existsSync(viewerSocket));
const ping = await viewer(viewerSocket, 'GET', '/ping');
check('viewers can reach the relay', ping.status === 200 && ping.json?.pong === true);

// GET /state with nothing cached asks the extension.
const statePending = viewer(viewerSocket, 'GET', '/state');
await until(() => run.toChrome.some((m) => m.type === 'getState'));
const getState = run.last((m) => m.type === 'getState');
check('a cold /state asks the extension for state', typeof getState?.id === 'number');
run.send({ type: 'reply', id: getState.id, ok: true, data: { stage: 'list', scopes: {} } });
const state = await statePending;
check(
  'and returns its answer',
  state.status === 200 && state.json?.state?.stage === 'list' && state.json?.app === false,
  JSON.stringify(state.json)
);
const asked = run.toChrome.filter((m) => m.type === 'getState').length;
await viewer(viewerSocket, 'GET', '/state');
check(
  'a warm /state is served from the cache',
  run.toChrome.filter((m) => m.type === 'getState').length === asked
);

// POST /open.
const openPending = viewer(viewerSocket, 'POST', '/open', { prId: 'PR_1' });
await until(() => run.toChrome.some((m) => m.type === 'openOne'));
const openOne = run.last((m) => m.type === 'openOne');
check('/open sends openOne with the prId', openOne?.prId === 'PR_1');
const busy = await viewer(viewerSocket, 'POST', '/open', { prId: 'PR_2' });
check('a second open while one runs is refused', busy.status === 409);

// POST /search while that open still runs: search never takes the open lock.
const searchPending = viewer(viewerSocket, 'POST', '/search', { query: 'abv10637' });
await until(() => run.toChrome.some((m) => m.type === 'search'));
const search = run.last((m) => m.type === 'search');
check('/search sends search with the query', search?.query === 'abv10637');
const searchData = { status: 'one', prIds: ['PR_1'], stale: false };
run.send({ type: 'reply', id: search.id, ok: true, data: searchData });
const searched = await searchPending;
check(
  'and answers during an open, with the extension reply',
  searched.status === 200 &&
    searched.json?.ok === true &&
    JSON.stringify(searched.json?.data) === JSON.stringify(searchData),
  JSON.stringify(searched.json)
);
const badSearch = await viewer(viewerSocket, 'POST', '/search', { query: 7 });
check('a malformed /search body is rejected', badSearch.status === 400);
run.send({ type: 'reply', id: openOne.id, ok: true, data: { focused: true, failures: [] } });
const opened = await openPending;
check(
  'and returns the extension reply',
  opened.status === 200 && opened.json?.ok === true && opened.json?.data?.focused === true
);

const bad = await viewer(viewerSocket, 'POST', '/open', '{"prId": 7}');
check('a malformed /open body is rejected', bad.status === 400);
const settings = await viewer(viewerSocket, 'POST', '/settings', { patch: {} });
check('viewers cannot change settings', settings.status === 404);
const huge = await viewer(viewerSocket, 'POST', '/open', 'x'.repeat(70 * 1024));
check('an oversized request is rejected', huge.status === 400 || huge.status === 0);
check(
  'and none of them reached the extension',
  !run.toChrome.some((m) => m.type === 'settings' || m.prId === 7 || m.query === 7)
);

// The app opens after the relay.
const app = fakeApp(appSocket);
await app.listening;
const openedAt = Date.now();
await until(() => run.toChrome.some((m) => m.type === 'peers' && m.app));
check('it attaches within a second of the app opening', Date.now() - openedAt < 1000);
check(
  'introducing the extension to the app',
  app.lines[0]?.type === 'hello' && app.lines[0]?.extensionId === extensionId
);

// App and viewer commands interleave without colliding ids.
app.write({ id: 1, type: 'openAll', scope: 'mine' });
const viewerOpen = viewer(viewerSocket, 'POST', '/open', { prId: 'PR_9' });
await until(
  () =>
    run.toChrome.some((m) => m.type === 'openAll') && run.toChrome.some((m) => m.prId === 'PR_9')
);
const fromApp = run.last((m) => m.type === 'openAll');
const fromViewer = run.last((m) => m.prId === 'PR_9');
check('app and viewer commands get distinct ids', fromApp.id !== fromViewer.id);

run.send({ type: 'progress', operationId: `native:${fromApp.id}`, kind: 'start' });
run.send({ type: 'progress', operationId: `native:${fromViewer.id}`, kind: 'start' });
run.send({ type: 'reply', id: fromViewer.id, ok: true, data: { focused: true } });
run.send({ type: 'reply', id: fromApp.id, ok: true, data: { opened: 2 } });
run.send({ type: 'state', state: { stage: 'list', marker: 'push' } });
const viewerReply = await viewerOpen;
await until(
  () => app.lines.some((m) => m.type === 'reply') && app.lines.some((m) => m.type === 'state')
);
const appReply = app.lines.find((m) => m.type === 'reply');
const appProgress = app.lines.filter((m) => m.type === 'progress');
check('the app gets its reply under its own id', appReply?.id === 1 && appReply.data?.opened === 2);
check(
  'and only its own progress, under its own id',
  appProgress.length === 1 && appProgress[0].operationId === 'native:1',
  JSON.stringify(appProgress)
);
check('the viewer gets its own reply', viewerReply.json?.data?.focused === true);
check(
  'state pushes reach the app',
  app.lines.some((m) => m.state?.marker === 'push')
);
const warm = await viewer(viewerSocket, 'GET', '/state');
check(
  'and refresh the viewer cache',
  warm.json?.state?.marker === 'push' && warm.json?.app === true
);

// The app quits: the relay stays, and says so.
app.socket.destroy();
app.server.close();
await until(() => run.last((m) => m.type === 'peers')?.app === false);
check('the app quitting is reported as peers', run.last((m) => m.type === 'peers')?.app === false);
await sleep(300);
check('and the relay stays alive', run.exit === null, `exit ${run.exit}`);

/* A second profile's relay does not take viewer.sock from the first. */
const second = launch({ appSocket: join(dir, 'other.sock'), viewerSocket });
second.send({ type: 'hello', version, extensionId });
await until(() => second.toChrome.length >= 2);
await sleep(500);
const stillFirst = viewer(viewerSocket, 'POST', '/open', { prId: 'PR_FIRST' });
await until(() => run.toChrome.some((m) => m.prId === 'PR_FIRST'), 2000);
check(
  'a second relay leaves the live viewer socket alone',
  run.toChrome.some((m) => m.prId === 'PR_FIRST') &&
    !second.toChrome.some((m) => m.prId === 'PR_FIRST')
);
run.send({ type: 'reply', id: run.last((m) => m.prId === 'PR_FIRST').id, ok: true, data: {} });
await stillFirst;

// The first relay's port closes: it exits, and the second takes over.
run.relay.stdin.end();
await until(() => run.exit !== null);
check('the relay exits when Chrome closes the port', run.exit === 0, `exit ${run.exit}`);
await until(() => existsSync(viewerSocket), 7000);
const takeover = viewer(viewerSocket, 'POST', '/open', { prId: 'PR_SECOND' });
await until(() => second.toChrome.some((m) => m.prId === 'PR_SECOND'), 7000);
check(
  'and the next relay takes the viewer socket over',
  second.toChrome.some((m) => m.prId === 'PR_SECOND')
);
second.send({
  type: 'reply',
  id: second.last((m) => m.prId === 'PR_SECOND').id,
  ok: true,
  data: {},
});
await takeover;

/* A refusing app (another profile owns it) is reported with its reason. */
const refusingSocket = join(directory(), 'bridge.sock');
const refusing = fakeApp(refusingSocket, { accept: false });
await refusing.listening;
const third = launch({ appSocket: refusingSocket, viewerSocket: join(directory(), 'v.sock') });
third.send({ type: 'hello', version, extensionId });
await until(() => third.toChrome.some((m) => m.type === 'peers' && m.reason));
check(
  'an app refusal reaches the extension with its reason',
  /Another browser profile/.test(third.last((m) => m.type === 'peers' && m.reason)?.reason ?? '')
);

for (const r of [second, third]) r.relay.stdin.end();
await until(() => second.exit !== null && third.exit !== null);
refusing.server.close();
clearTimeout(timeout);
console.log(`1..${checks}`);
if (failures) {
  console.log(`# ${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`# all ${checks} passed`);
process.exit(0);
