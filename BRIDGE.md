# The bridge

How the macOS menu bar app drives the extension.

## Why there is a relay at all

Chrome native messaging is **extension-initiated only**. A native process cannot open a connection into an extension; Chrome spawns the host executable itself, one process per `connectNative()` call, and kills it when the port closes.

That is backwards from what the app wants. The app needs to *push* "open these", but it can only ever answer. So the flow is inverted:

```
  extension service worker
        │  connectNative("com.pulldeck.bridge")
        ▼
  Chrome spawns  pulldeck-bridge          ← stateless, one per connection
        │  stdin/stdout, length-prefixed JSON
        │
        │  connects out to the app's socket
        ▼
  ~/Library/Application Support/PullDeck/bridge.sock
        │  newline-delimited JSON
        ▼
  Pull Deck.app (menu bar, long-running)  ← holds all durable state
```

Once the relay attaches, the app has a live channel it can write into at any time. Until then it has nothing, and that is a **normal displayable state** ("Chrome not connected"), not an error — Chrome may be closed, the extension may be unloaded, or the service worker may be between lives.

Consequences that shape both sides:

- The relay holds **no state**. It dies with the port and is not restarted by anything except the extension reconnecting.
- The extension reconnects on disconnect with backoff (`0.5, 1, 2, 5, 15, 30` minutes, capped). The backoff resets only on **proof of life** — the first message actually received — never on `connectNative()` returning, because Chrome returns a Port synchronously even when no host exists.
- The app must tolerate the channel appearing and disappearing under it at any moment.

## What deliberately does not cross the boundary

- **The GitHub token.** It stays in extension storage. The app never sees it and never talks to GitHub.
- **URLs.** The app names a *scope* (`mine` / `reviewing` / `assigned`) or a pull request *id*. The extension resolves those against its own cache.
- **Group identity.** Title and colour are read from extension storage inside `app-state.js`. No command may specify them.

That third one is the important one. If a command could carry a group title, the popup and the menu bar app would each have their own idea of which group is "the" group and would silently fill two different ones. The second exists so the pull-request identity rule (`pr-url.js`, 11 tests) is never reimplemented in Swift — two copies of that rule drifting is precisely how the duplicate-tab bug comes back.

## Framing

**Chrome ⟷ relay** — Chrome's native messaging framing: a 4-byte length prefix followed by that many bytes of UTF-8 JSON.

**Relay ⟷ app** — newline-delimited JSON (one compact object per line) over a Unix domain socket. Chosen over the length-prefixed form because it is trivially inspectable with `nc` while debugging.

## Messages

### App → extension

Every command may carry an `id`. If it does, exactly one `reply` comes back bearing the same `id`. Without an `id` the command is fire-and-forget.

| Command | Fields | Does |
| --- | --- | --- |
| `getState` | `force?: bool` | Returns the full state. `force` bypasses the 60s cache. |
| `openAll` | `scope` | Opens everything in that scope not already grouped. |
| `openOne` | `prId` | Opens one pull request and focuses its tab. |
| `settings` | `patch` | Same allow-list as the popup: `groupTitle`, `groupColor`, `badgeEnabled`. |
| `ping` | — | Liveness. Replies `{pong: true, version}`. |

### Extension → app

| Message | When |
| --- | --- |
| `hello` | Immediately on connect. Carries `version` and `extensionId`. |
| `state` | After connect, after every command, and after each background refresh. The app never polls. |
| `progress` | While tabs are opening: `{done, total, id, ok}`, one per tab, emitted as each is genuinely created. |
| `reply` | `{id, ok, data}` or `{id, ok: false, error}`. |

### The state object

Identical to what the popup renders, because it is the same `loadState()`:

```jsonc
{
  "stage": "list" | "onboarding" | "error",
  "settings": { "groupTitle", "groupColor", "badgeEnabled", "hasToken", "tokenTail" },
  "viewer":   { "login", "avatarUrl" },
  "scopes":   { "mine": [PR], "reviewing": [PR], "assigned": [PR] },
  "group":    { "groupId", "keys": [String], "otherWindow": Bool },
  "rateLimit": { "remaining", "limit", "resetAt", "cost" },
  "fetchedAt": Number,
  "error":     { "kind", "message", "retryAt" } | null
}
```

A `PR` carries `id`, `number`, `title`, `url`, `repo`, `isDraft`, `updatedAt`, `additions`, `deletions`, `reviewDecision`, `checks`.

`group.keys` holds the identity keys (`host/owner/repo#number`) of every pull request already in the group. The app renders "in group" by testing membership — it does **not** parse the URLs itself; the extension has already done that with the tested rule.

## Errors

Every error crosses as `{kind, message, retryAt}` with the same `kind` values the popup already handles: `badToken`, `forbidden`, `rateLimited`, `offline`, `server`, `malformed`, `unknown`.

## Security

`allowed_origins` in the host manifest names the one extension ID permitted to launch the relay, so no other extension can reach the socket path through it. The socket lives under the user's Application Support directory with user-only permissions. Nothing listens on a TCP port — a localhost server would be reachable by any page in any browser on the machine, which for a tool holding a GitHub token is not a trade worth making.
