# Native bridge protocol

The extension initiates `chrome.runtime.connectNative`. Chrome starts `pulldeck-bridge`, which forwards framed stdio messages to the companion's Unix socket. The companion keeps the connection until that browser profile disconnects.

```text
extension worker → Chrome native messaging → relay → companion Unix socket
```

The relay holds no account state. The GitHub token remains in the extension. The companion receives display data, including PR URLs and canonical identity keys, but commands refer only to scopes or PR IDs. Group settings are applied by the extension's settings API.

## Identity and handshake

`src/bridge-protocol.js` defines protocol version 2 and the host name. `manifest.json` supplies the public key and release version. `npm run generate` derives the extension ID and emits `BuildIdentity.swift` and the packaged shortcut rules. `npm run check` rejects stale generated files.

The extension sends `{type:"hello", version:2, extensionId}`. The app replies `{type:"hello", version:2, accepted:true}` only when both identity and protocol match. State/commands are processed only after acceptance. A second client receives `accepted:false` with a reason and is disconnected; it never waits silently in an unserviced socket backlog. The extension reports “connecting” until acceptance and retries failed/expired handshakes.

When the companion is not running, the relay stays alive. It sends Chrome `{type:"waiting"}`, leaves the extension's `hello` unread in its stdin pipe, and retries the socket every 250 ms; once the companion listens, the queued `hello` is forwarded and the handshake completes on the same port. The extension treats `waiting` as “not running”, cancels its handshake deadline, and keeps the port. When an accepted connection drops, the extension opens a new port immediately, so a relay is already waiting when the companion reopens. The reconnect alarm covers only connections that were never accepted.

Only one browser profile is active. A connection object owns descriptor lifetime, bounded writes, and shutdown. Incoming callbacks, pending commands, progress, and state delivery are tied to that connection. Detach clears all pending/busy state before a replacement can attach.

## Framing

Chrome uses a native-endian 32-bit length prefix followed by UTF-8 JSON. Relay/app traffic uses compact JSON plus a newline. Stdout contains only protocol frames; relay diagnostics go to stderr. Socket writes suppress SIGPIPE, and relay pipe writes handle it too. Oversized input is rejected or disconnected.

## App commands and replies

Every command carries an integer `id`. Exactly one terminal `reply` corresponds to a completed command. A connection loss cancels pending commands locally; they are not replayed blindly after reconnect. Unanswered commands time out after 30 seconds.

| Command | Input | Success data |
| --- | --- | --- |
| `getState` | `force?: boolean` | Full application state |
| `openAll` | `scope: mine/reviewing/assigned` | Open result, including partial failures |
| `openOne` | `prId` | Open result with confirmed `focused` outcome |
| `settings` | Allowlisted `patch` | Public settings and group state |
| `ping` | — | `{pong:true, version:2}` |

Replies use `{type:"reply", id, ok:true, data}` or `{type:"reply", id, ok:false, error}`. The envelope is decoded independently of command data: a settings/ping payload is not mistaken for an open result. Unknown nonessential payload shapes are tolerated without dropping the reply ID/outcome.

Open results include `created`, `adopted`, `skipped`, `groupId`, `opened`, `failures`, `warnings`, and `focused` when relevant. A successful transport reply can contain individual failed tabs. Clients must inspect those failures and retain them as an actionable outcome. A metadata warning does not imply that grouping itself failed.

## State and progress

The extension pushes state after handshake and successful commands. The companion requests updates every five seconds while its panel is visible and every minute while hidden. Requests share the extension's cache/throttle; a pending refresh is not duplicated. The worker's badge alarm also uses that same coordinator.

State includes `stage`, public `settings`, `viewer`, `scopes`, `group`, `authRevision`, `fetchedAt`, `truncated`, `stale`, `rateLimit`, and an optional `error`. Each displayed PR carries the canonical `key` computed by the extension. Native group membership is exact key membership, including the host. Older account revisions are ignored.

Progress uses `{type:"progress", operationId, kind, ...}`. `start` begins an operation; `tab` reports creation/adoption progress; `grouped` confirms membership; `done` ends progress. Native operation IDs are `native:COMMAND_ID` on the wire and additionally scoped to the connection inside the worker. Clients do not interpret successful tab creation as successful grouping. Every terminal reply, including failure and no-op success, clears its command's progress and busy state.

## Security and tests

The native host's `allowed_origins` contains the generated extension ID. The socket directory/file use owner-only permissions. Other applications running as the same OS user remain inside the local trust boundary. No TCP listener is used.

`npm run mac:test` builds required binaries, generates wire fixtures from the actual JavaScript handlers, and decodes them in Swift. It also drives the actual native runtime over isolated Unix sockets to check failures, concurrent clients, account revisions, and reconnects. The relay is exercised separately over framed pipes. No test installs hosts or uses a live companion/browser profile.
