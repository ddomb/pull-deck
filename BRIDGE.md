# Native bridge protocol

The extension initiates `chrome.runtime.connectNative`. Chrome starts `pulldeck-bridge`, the relay, which lives as long as that port. The relay is the hub: it answers the extension's handshake itself, dials the companion's Unix socket whenever the companion is open, and serves local viewers (the Claude Code mod) on a second socket.

```text
                                        ┌─ bridge.sock ─▶ companion (optional)
extension worker ─ native messaging ─▶ relay
                                        └─ viewer.sock ◀─ viewers (HTTP)
```

The relay holds no account state. The GitHub token remains in the extension. The companion receives display data, including PR URLs and canonical identity keys, but commands refer only to scopes or PR IDs. Group settings are applied by the extension's settings API.

## Identity and handshake

`src/bridge-protocol.js` defines protocol version 4 and the host name. `manifest.json` supplies the public key and release version. `npm run generate` derives the extension ID and emits `BuildIdentity.swift` and the packaged shortcut rules. `npm run check` rejects stale generated files.

The extension sends `{type:"hello", version:4, extensionId}`. The relay replies `{type:"hello", version:4, accepted:true, peer:"relay"}` only when both identity and protocol match its own build. The extension serves commands only after acceptance, and reports "connecting" until then.

The relay then reports the companion with `{type:"peers", app:boolean, reason?}`: once at acceptance, and whenever the companion attaches, detaches, or refuses. The popup shows the companion as connected only while `app` is true. A companion that is not running costs nothing: the relay retries its socket every 250 ms, and the extension keeps the same port.

To attach, the relay sends the companion `{type:"hello", version:4, extensionId}` with the identity it accepted. The companion replies as before. A second relay (another browser profile) receives `accepted:false` with a reason, which the relay forwards as `peers`; it retries every 5 seconds.

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
| `search` | `query` | `{status, prIds, stale}` from the shortcut matcher over all scopes; no state push follows |
| `ping` | — | `{pong:true, version:4}` |

Replies use `{type:"reply", id, ok:true, data}` or `{type:"reply", id, ok:false, error}`. The envelope is decoded independently of command data: a settings/ping payload is not mistaken for an open result. Unknown nonessential payload shapes are tolerated without dropping the reply ID/outcome.

Open results include `created`, `adopted`, `skipped`, `groupId`, `opened`, `failures`, `warnings`, and `focused` when relevant. A successful transport reply can contain individual failed tabs. Clients must inspect those failures and retain them as an actionable outcome. A metadata warning does not imply that grouping itself failed.

Every client numbers its own commands. The relay renumbers each forwarded command into its own id space and maps the `reply` and `progress` (`native:<id>`) back, so the companion and viewers never see each other's ids or progress. State pushes go to the companion; the relay keeps the latest for viewers.

## Viewer socket

The relay serves HTTP/1.1, one request per connection, on `~/Library/Application Support/PullDeck/viewer.sock` (`PULLDECK_VIEWER_SOCKET` overrides it). Bodies are JSON, at most 64 KB, with `Content-Length` or chunked encoding.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /ping` | — | `{pong:true, version:4}` |
| `GET /state` | — | `{app, state, error}`; asks the extension (`getState`) when the cached state is older than 5 seconds |
| `POST /open` | `{prId}` | `{ok, data, error}` from `openOne` |
| `POST /open-all` | `{scope}` | `{ok, data, error}` from `openAll` |
| `POST /search` | `{query}` | `{ok, data, error}` from `search` |

Viewers may send only `getState`, `openOne`, `openAll` and `search`; settings are not reachable. One viewer open runs at a time (409 otherwise), and an open that is not answered in 30 seconds returns 504.

Only one relay serves viewers. Before binding, a relay connects to the path: if another relay answers, it leaves the socket alone and checks again every 5 seconds, so the next profile's relay takes over when the first one exits. A relay removes its socket at exit.

## State and progress

The extension pushes state after handshake and successful commands. The companion requests updates every five seconds while its panel is visible and every minute while hidden. Requests share the extension's cache/throttle; a pending refresh is not duplicated. The worker's badge alarm also uses that same coordinator.

State includes `stage`, public `settings`, `viewer`, `scopes`, `group`, `authRevision`, `fetchedAt`, `truncated`, `stale`, `rateLimit`, and an optional `error`. Each displayed PR carries the canonical `key` computed by the extension. Native group membership is exact key membership, including the host. Older account revisions are ignored.

Progress uses `{type:"progress", operationId, kind, ...}`. `start` begins an operation; `tab` reports creation/adoption progress; `grouped` confirms membership; `done` ends progress. Native operation IDs are `native:COMMAND_ID` on the wire and additionally scoped to the connection inside the worker. Clients do not interpret successful tab creation as successful grouping. Every terminal reply, including failure and no-op success, clears its command's progress and busy state.

## Security and tests

The native host's `allowed_origins` contains the generated extension ID. The socket directory and both sockets use owner-only permissions. Viewers receive the same display data as the companion and send only PR IDs or scopes; the token never leaves the extension. Other applications running as the same OS user remain inside the local trust boundary. No TCP listener is used.

`npm run mac:test` builds required binaries, generates wire fixtures from the actual JavaScript handlers, and decodes them in Swift. It also drives the actual native runtime over isolated Unix sockets to check failures, concurrent clients, account revisions, and reconnects. `macos/tools/relay-hub.mjs` drives the actual relay binary over framed pipes, a fake companion socket and viewer HTTP: handshake, renumbering, progress routing, the viewer routes and allowlist, companion attach/quit/refusal, and viewer socket handover between relays. No test installs hosts or uses a live companion/browser profile.
