// Generate wire fixtures from the actual JS command handlers for Swift to decode.
import { writeFileSync } from 'node:fs';
import { fakeChrome, cached, tick } from './helpers/chrome.mjs';
import { ensureBridge } from '../src/bridge.js';
import { BRIDGE_PROTOCOL_VERSION } from '../src/bridge-protocol.js';
const h = fakeChrome({ cache: cached({ fetchedAt: Date.now() }) });
ensureBridge();
h.listeners.nativeMessage[0]({ type: 'hello', version: BRIDGE_PROTOCOL_VERSION, accepted: true });
await tick();
for (const command of [
  { id: 1, type: 'getState' },
  { id: 2, type: 'settings', patch: { badgeEnabled: false } },
  { id: 3, type: 'ping' },
  { id: 4, type: 'openAll', scope: 'mine' },
]) {
  h.listeners.nativeMessage[0](command);
  await tick();
}
const replies = h.calls.posted.filter((message) => message.type === 'reply');
if (replies.length !== 4 || replies.some((reply) => !reply.ok))
  throw Error('Bridge fixture generation failed.');
writeFileSync(process.argv[2], JSON.stringify(replies, null, 2));
