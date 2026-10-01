#!/usr/bin/env node
// The relay started while the menu bar app is closed.
//
// The app cannot open a connection into Chrome, so a relay that exits here
// leaves the extension's retry alarm as the only way back. It has to stay,
// say so, and attach when the socket appears.
//
//   node macos/tools/relay-waits.mjs [path-to-pulldeck-bridge]

import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary =
  process.argv[2] ?? resolve(import.meta.dirname, '..', '.build', 'debug', 'pulldeck-bridge');

if (!existsSync(binary)) {
  console.error(`not ok - relay binary missing at ${binary}\n# run: swift build`);
  process.exit(1);
}

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
  header.writeUInt32LE(body.length);
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
    await sleep(25);
  }
  return predicate();
};

function launch(socketPath) {
  const relay = spawn(binary, ['chrome-extension://testextensionid/'], {
    env: { ...process.env, PULLDECK_SOCKET: socketPath },
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
  return run;
}

const freshSocket = () => join(mkdtempSync(join(tmpdir(), 'pulldeck-')), 'bridge.sock');

/* The app opens after the relay. */
{
  const socketPath = freshSocket();
  const run = launch(socketPath);
  run.relay.stdin.write(frame({ type: 'hello', version: 2, extensionId: 'testextensionid' }));

  await until(() => run.toChrome.length > 0 || run.exit !== null, 2000);
  check('the relay tells Chrome it is waiting', run.toChrome[0]?.type === 'waiting');
  await sleep(1200);
  check('and stays alive with no app to attach to', run.exit === null, `exit ${run.exit}`);

  const fromRelay = [];
  const opened = Date.now();
  let attachedAfter = null;
  const server = net.createServer((socket) => {
    attachedAfter = Date.now() - opened;
    socket.on('data', (chunk) => fromRelay.push(chunk.toString('utf8')));
    socket.write(JSON.stringify({ type: 'hello', version: 2, accepted: true }) + '\n');
  });
  await new Promise((r) => server.listen(socketPath, r));

  await until(() => fromRelay.length > 0 && run.toChrome.length > 1);
  check(
    'it attaches within a second of the app opening',
    attachedAfter !== null && attachedAfter < 1000,
    `after ${attachedAfter}ms`
  );
  check(
    'the hello sent before the app existed is delivered',
    fromRelay.join('').includes('"type":"hello"'),
    fromRelay.join('')
  );
  check('and the app reply reaches Chrome', run.toChrome[1]?.accepted === true);

  run.relay.stdin.end();
  await until(() => run.exit !== null);
  server.close();
}

/* Chrome drops the port while the relay is still waiting. */
{
  const run = launch(freshSocket());
  run.relay.stdin.write(frame({ type: 'hello', version: 2, extensionId: 'testextensionid' }));
  await until(() => run.toChrome.length > 0 || run.exit !== null, 2000);
  run.relay.stdin.end();
  await until(() => run.exit !== null, 3000);
  check('a waiting relay exits when Chrome closes the port', run.exit === 0, `exit ${run.exit}`);
  run.relay.kill();
}

console.log(`1..${checks}`);
if (failures) {
  console.log(`# ${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`# all ${checks} passed`);
process.exit(0);
