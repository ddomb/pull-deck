#!/usr/bin/env node
// End-to-end check of the relay binary, standing in for Chrome.
//
// This is the closest thing to a real test the relay can get without a browser:
// it spawns the actual compiled executable, speaks Chrome's framing at its
// stdin/stdout, and stands up a Unix socket where the menu bar app would be.
//
//   node macos/tools/relay-roundtrip.mjs [path-to-pulldeck-bridge]

import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary =
  process.argv[2] ??
  resolve(import.meta.dirname, '..', '.build', 'debug', 'pulldeck-bridge');

if (!existsSync(binary)) {
  console.error(`not ok - relay binary missing at ${binary}\n# run: swift build`);
  process.exit(1);
}

const socketPath = join(mkdtempSync(join(tmpdir(), 'pulldeck-')), 'bridge.sock');

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

/** Pull whole frames out of a growing buffer, exactly as Chrome would. */
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

const timeout = setTimeout(() => {
  console.log('not ok - timed out waiting for the relay');
  process.exit(1);
}, 10_000);

const fromApp = [];
let appSocket = null;

const server = net.createServer((socket) => {
  appSocket = socket;
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) fromApp.push(JSON.parse(line));
    }
  });
});

server.listen(socketPath, () => {
  const relay = spawn(binary, ['chrome-extension://testextensionid/'], {
    env: { ...process.env, PULLDECK_SOCKET: socketPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = Buffer.alloc(0);
  const toChrome = [];
  relay.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    const { messages, rest } = drain(stdout);
    stdout = rest;
    toChrome.push(...messages);
  });

  // Chrome → relay → app. Two messages, written as one chunk so the relay has
  // to split them, and a third split mid-frame so it has to wait.
  const first = frame({ id: 1, type: 'openAll', scope: 'mine' });
  const second = frame({ id: 2, type: 'ping' });
  relay.stdin.write(Buffer.concat([first, second]));

  const third = frame({ id: 3, type: 'getState', force: true });
  relay.stdin.write(third.subarray(0, 6)); // deliberately partial
  setTimeout(() => relay.stdin.write(third.subarray(6)), 120);

  setTimeout(() => {
    check('the app receives every command Chrome sent', fromApp.length === 3, `got ${fromApp.length}`);
    check('commands arrive intact and in order', fromApp[0]?.scope === 'mine' && fromApp[1]?.type === 'ping');
    check(
      'a frame split across writes is reassembled, not dropped',
      fromApp[2]?.type === 'getState' && fromApp[2]?.force === true,
      JSON.stringify(fromApp[2])
    );

    // App → relay → Chrome.
    appSocket.write(JSON.stringify({ type: 'hello', version: 1 }) + '\n');
    appSocket.write(JSON.stringify({ type: 'state', state: { stage: 'onboarding' } }) + '\n');

    setTimeout(() => {
      check('the app can push unsolicited messages to Chrome', toChrome.length === 2, `got ${toChrome.length}`);
      check('and they arrive correctly framed', toChrome[0]?.type === 'hello' && toChrome[1]?.type === 'state');

      // Closing the app socket must end the relay: Chrome then sees the port
      // drop and the extension's backoff takes over.
      appSocket.end();
      relay.on('exit', (code) => {
        check('the relay exits when the app goes away', code === 0, `exit ${code}`);
        clearTimeout(timeout);
        server.close();
        console.log(`1..${checks}`);
        if (failures) {
          console.log(`# ${failures} of ${checks} failed`);
          process.exit(1);
        }
        console.log(`# all ${checks} passed`);
        process.exit(0);
      });
    }, 300);
  }, 500);
});
