# Plan: Pull Deck mod for Claude Code

**Summary.** A Claude Code mod adds a **Pull Deck** pane and a `/pull-deck` command. The pane lists your open PRs (Mine / Reviews / Assigned) with the same review, CI, and diff-size chips as the popup and the menu app. Clicking a row runs the extension's `openOne`, which reuses a matching tab or creates and groups one, then focuses it.

The extension stays the master. The mod talks to it through the **relay** (`pulldeck-bridge`), the native program Chrome starts for the extension. The menu app does not need to be running. The relay becomes a small hub: one extension on one side, and on the other the menu app (optional) plus any number of Claude sessions.

```text
                                       ┌──bridge.sock──▶ Pull Deck.app (optional)
extension ──stdio──▶ relay (hub) ──────┤
 (master)   v3       answers hello     └──viewer.sock──◀ Claude Code mod (HTTP)
                     muxes command ids                    GET /state, POST /open
```

## Grounding (current code)

- The relay already stays up whenever Chrome is open and the host is installed. `ensureBridge()` connects on every worker start, and `waitForApp()` parks the relay until the app appears (`macos/Sources/PullDeckBridge/main.swift`).
- Today the relay passes everything through without reading it. The **app** answers the extension's `hello`, so the extension processes no commands until the app is running (`src/bridge.js`, `if (!accepted) return`). That is the main thing B changes.
- Command ids belong to whoever sent the command (`native:<id>` progress ids, `reply.id`). With two senders, the relay has to rewrite the ids.
- `UnixSocket.listen` unlinks any existing socket before binding. A second profile's relay would steal `viewer.sock` from the first unless the relay probes it first.

## Tasks (one branch, one PR, one commit per task)

### 1. Spike: the three unverified facts (~45 min)
- Desktop Code tab: `$.ui.open` gives `isPlaced: true`, and `$.http.fetch(url, { socketPath })` reaches a `nc -lU` socket. If the pane can't be placed, use an `AbovePrompt` band.
- With the app quit, the relay process stays alive for hours. Watch `ps` while Chrome idles. This checks that the native port keeps the MV3 worker alive.
- **Done when:** all three are confirmed, or the plan is adjusted where one fails.

### 2. Protocol v3: relay handshake + peer status (~half a day)
- Bump `PROTOCOL_VERSION` to 3, then run `npm run generate`.
- The relay answers the extension's `hello` itself. It validates `version` and `extensionId` against `BuildIdentity`, then replies `accepted:true, peer:"relay"`.
- The relay sends `{type:"peers", app:boolean}` whenever the app attaches or detaches.
- Extension (`src/bridge.js`): split `accepted` (the relay accepted, so commands are allowed) from `appAttached` (shown in the popup). `bridgeStatus()` returns both. Remove the `waiting` path, which `peers` replaces.
- App: does its handshake with the relay, not with the extension. The relay forwards the extension's id in its own `hello`. The "another browser profile" rejection stays.
- **Done when:** `test/bridge.test.mjs` covers commands with no app and app attach/detach while connected. The popup still says "Pull Deck.app is not open" when the app is closed.

### 3. Relay hub: id mux + viewer socket (~1–1.5 days)
- Restructure `main.swift` into these parts, all routed through one serial queue:
  - a stdin reader;
  - an app connector (retries every 250 ms, as now);
  - a viewer listener.
- Command mux: each upstream command gets a relay id. A map `relayId → (client, originalId)` rewrites `reply.id` and `progress.operationId` back to the sender. The relay keeps the latest `state` push, forwards it to the app, and serves it to viewers.
- `viewer.sock` lives at `~/Library/Application Support/PullDeck/viewer.sock`, mode 0600. Before binding, the relay connect-probes the path: if another relay answers, this one serves no viewers and logs that. If the socket is stale, unlink it and bind.
- Minimal HTTP/1.1: one request per connection, a `Content-Length` body, a 64 KB cap. Routes:
  - `GET /state` returns `{ app, state }`. If the cached state is older than 5 s, send `getState` first. That uses the extension's shared throttle, so no new poller is added.
  - `POST /open {prId}` sends `openOne` and returns its reply (`ok`, `focused`, `failures`). Return 409 if an open is already in flight, 503 if the extension isn't connected yet.
  - `GET /ping`.
  - Allowlist: viewers may send only `getState`, `openOne`, and `openAll`, never `settings`.
- **Done when:** `macos/tools/relay-hub.mjs` (replacing `relay-roundtrip.mjs` and `relay-waits.mjs`) drives a fake extension on stdio and a fake app plus viewers on sockets. It covers interleaved ids, progress routing, app quit mid-command, a second relay seeing the socket already owned, a stale socket, an oversized body, and the allowlist. `npm run mac:test` passes.

### 4. Mod scaffold + types (~30 min)
- `~/.claude/dev-mods/<session>/pull-deck/` contains `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, and `types/index.d.ts`.
- `PluginState.pull-deck`: `snapshot`, `scope`, `opening` (a prId or null), `notice`.
- `userConfig.socketPath`, defaulting to the path above.

### 5. Mod: data + pane (~2 h)
- `session.start` registers `/pull-deck`. The pane opens on its own only where `e.viewport.isFullscreen`.
- `command.run` (`pull-deck`) calls `$.ui.open({ id: 'pull-deck', title: 'Pull Deck' })`.
- Poll `GET /state` every 5 s while the pane is placed, every 60 s otherwise (`$.clock.every`).
- `ui.render` on `{ component: 'Pane', requestId: 'pull-deck' }`:
  - scope `Button`s with counts, hotkeys `m`, `r`, `a`;
  - rows as `<Button plain key={pr.id}>` with `Text` chips matching `MenuContent.swift` `badgeItems`;
  - a footer with the age and a truncated or stale warning;
  - one-line states for: no token, extension not connected, Chrome closed (socket missing).
- Row press: `POST /open`, then `$.ui.toast` the first failure, if any.
- **Done when:** with the menu app quit, the pane lists live PRs and a click focuses the PR tab in Chrome.

### 6. Tests + docs (~1.5 h)
- Mod `*.test.ts`: render loaded, empty, not connected, and Chrome closed, on terminal and desktop. A row press posts that `prId`. Hotkeys switch the scope. Then run `claude plugin validate`, `tsc -p`, and `claude plugin test`.
- `BRIDGE.md`: v3 handshake, the hub diagram, viewer routes, the allowlist, and the trust boundary (same user, 0600 socket, no token, prIds only).
- README: a "Claude Code mod" section. It needs the host installed once (`macos/install-host.sh` or opening the app once), and the app does not need to be running afterwards.
- Ship the mod in the repo under `claude-mod/` with `.claude-plugin/marketplace.json`.

## Known limits

- Only one Chromium profile serves viewers: the first relay to bind wins, the same "one profile" rule the app already has.
- Chrome must be running. No Chrome means no relay, which means no list. The pane says so.
- Rows past the 50-per-scope cap are not shown, the same as in the extension.

**Estimate:** about 3 days in total, most of it task 3.
