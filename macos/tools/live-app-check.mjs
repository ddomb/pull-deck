#!/usr/bin/env node
// Impersonates Chrome against the *running* menu bar app.
//
// Spawns the real relay exactly as Chrome would — same binary, same argv, same
// stdio framing — and talks to whatever app is currently listening on the
// default socket. This exercises the live app process, the real relay, the real
// socket and the real JSON decoding. The only thing still simulated is Chrome.
//
//   node macos/tools/live-app-check.mjs

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const relay = resolve(
  import.meta.dirname, '..', 'build', 'Pull Deck.app', 'Contents', 'MacOS', 'pulldeck-bridge'
);
const socket = join(homedir(), 'Library', 'Application Support', 'PullDeck', 'bridge.sock');

let checks = 0, failures = 0;
const check = (name, passed, detail = '') => {
  checks++;
  if (passed) console.log(`ok ${checks} - ${name}`);
  else { failures++; console.log(`not ok ${checks} - ${name}${detail ? `  # ${detail}` : ''}`); }
};

const finish = () => {
  console.log(`1..${checks}`);
  if (failures) { console.log(`# ${failures} of ${checks} failed`); process.exit(1); }
  console.log(`# all ${checks} passed`);
  process.exit(0);
};

if (!existsSync(relay)) { console.log(`not ok - relay missing (run ./build-app.sh)`); process.exit(1); }
if (!existsSync(socket)) { console.log(`not ok - app not running (open "build/Pull Deck.app")`); process.exit(1); }

const frame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

const child = spawn(relay, ['chrome-extension://livecheckextensionidaaaaaaaaaaaa/'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = Buffer.alloc(0);
const fromApp = [];
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length - 4 < length) break;
    fromApp.push(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')));
    buffer = buffer.subarray(4 + length);
  }
});

let stderr = '';
child.stderr.on('data', (c) => (stderr += c.toString()));

const timer = setTimeout(() => {
  check('the live app answered within 5s', false, stderr.trim());
  finish();
}, 5_000);

setTimeout(() => {
  clearTimeout(timer);

  check('the relay attached to the running app', stderr.includes('attached to'), stderr.trim());
  const getState = fromApp.find((m) => m.type === 'getState');
  check('the app initiates on attach', Boolean(getState), JSON.stringify(fromApp));
  check('and its command carries an id', typeof getState?.id === 'number');

  // Push a realistic state, as the extension would.
  child.stdin.write(frame({ type: 'hello', version: 1, extensionId: 'livecheck' }));
  child.stdin.write(frame({
    type: 'state',
    state: {
      stage: 'list',
      settings: { groupTitle: 'Pull Requests', groupColor: 'cyan', badgeEnabled: true, hasToken: true, tokenTail: '9f2c' },
      viewer: { login: 'ddomb', avatarUrl: null },
      scopes: {
        mine: [{
          id: 'pr1', number: 4120, title: 'Stop the session refresher thundering on cold start',
          url: 'https://github.com/abovesec/platform-api/pull/4120', repo: 'abovesec/platform-api',
          isDraft: false, updatedAt: new Date(Date.now() - 3.6e6).toISOString(),
          additions: 214, deletions: 61, reviewDecision: 'APPROVED', checks: 'SUCCESS',
        }],
        reviewing: [], assigned: [],
      },
      group: { groupId: 42, keys: [], otherWindow: false },
      fetchedAt: Date.now(), error: null,
    },
  }));

  setTimeout(() => {
    check('the app survived a full state payload', child.exitCode === null, `exited ${child.exitCode}`);

    // A message the app must tolerate without understanding it.
    child.stdin.write(frame({ type: 'somethingFromANewerExtension', payload: { a: 1 } }));

    setTimeout(() => {
      check('an unknown message does not kill it', child.exitCode === null);
      child.kill();
      finish();
    }, 400);
  }, 600);
}, 1_200);
