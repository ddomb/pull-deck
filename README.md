# Pull Deck

A Chromium extension that shows every pull request waiting on you and opens them all into one tab group, without ever opening the same pull request twice.

- Three lists: **Mine** (you authored), **Reviews** (your review was requested), **Assigned** (assigned to you).
- One button puts the current list into a named tab group. Anything already in the group is left alone.
- A tab already open elsewhere in that window gets **moved into** the group rather than duplicated.
- Follows the system light/dark appearance.

## Install

No build step. Load it straight from disk:

```bash
open -a "Google Chrome" --args --new-window "chrome://extensions"
```

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked**.
3. Choose this folder: `/Users/ddomb/pull-deck`
4. Pin Pull Deck to the toolbar so the badge count is visible.

Works the same in Edge (`edge://extensions`) and Brave (`brave://extensions`). Needs **Chrome 99+**: `chrome.tabGroups` shipped in 89, but `chrome.runtime.sendMessage` only started returning a promise in 99, and every call here is awaited.

## Connect a token

The popup links straight to GitHub's token page with the scopes pre-filled. If you'd rather do it by hand, create a **classic** personal access token with:

| Scope | Why |
| --- | --- |
| `repo` | Read pull requests in private repositories. GitHub has no read-only private-repo scope, so this is the narrowest option that works. |
| `read:org` | See pull requests in organisation repositories. |

For public repositories only, `public_repo` is enough.

**Fine-grained tokens are not recommended here.** They are scoped per repository, so a cross-org "all my pull requests" search silently misses anything the token wasn't explicitly granted. GitHub's own docs do not state whether the search endpoints support them.

The token is stored with `chrome.storage.local`. That means it lives in this browser profile, unencrypted, and is sent nowhere except `api.github.com`. Revoke it on GitHub if the profile is shared. **Settings → Forget this token** clears it and the cached list.

## About the install warning

Chrome will say **"Read your browsing history"**. That comes from the `tabs` permission, and it is load-bearing: reading `tab.url` is the only way to know which pull requests are already open. Without it Chrome hands back `undefined` instead of an error, nothing matches, and every click would duplicate the whole set.

Full permission list:

| Permission | Used for |
| --- | --- |
| `tabs` | Reading tab URLs to detect what is already open |
| `tabGroups` | Naming and colouring the group |
| `storage` | The token, settings, and the cached list |
| `alarms` | The 15-minute badge refresh |
| `https://api.github.com/*` | The one host it talks to |

## How "don't open it twice" actually works

Two things make this hold up in practice:

1. **Identity is the pull request, not the URL.** An already-open tab is usually at `/pull/4120/files`, or carries `#issuecomment-…`, or `?w=1`. Matching URL strings misses all of those. Pull Deck matches on the `(host, owner, repo, number)` tuple parsed out of the URL. See `src/pr-url.js` and its tests.
2. **The group is found by saved id first, title second.** Rename the group in Chrome and it is still the same group, so you don't end up with two. If it was closed, the id is forgotten and a fresh one is created.

Deliberate behaviour worth knowing: **the group stays in whichever window it already lives in.** New tabs are created in that window, so grouping never yanks tabs between windows behind your back. If the group is in a different window than the one you're looking at, the popup says so.

## Keyboard

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between rows |
| `↵` | Open the focused pull request and go to it |
| `⌘↵` / `Ctrl↵` | Open all of the current list into the group |
| `⌘R` / `Ctrl R` | Refresh |
| `←` `→` | Switch list (when a tab is focused) |
| `Esc` | Close settings |

## Data source

One GraphQL request per refresh covers all three lists, the viewer, review decisions, CI rollup, and diff sizes. The REST `/search/issues` endpoint returns neither `reviewDecision` nor check status, which would have meant three extra calls per pull request. Cost is roughly 3 points against a 5,000/hour budget; the list is cached for 60 seconds so reopening the popup is free.

## Development

```bash
npm test
```

Tests cover the URL-identity rules that the no-duplicates promise depends on.

```bash
npm run icons
```

Regenerates the PNG icons from `tools/make-icons.mjs`. The mark is drawn procedurally, so there are no binary source assets to keep in sync.

```bash
npm run preview
```

Generates a stubbed copy of the popup under `.claude/tmp/preview/` and serves it at
<http://127.0.0.1:8731/.claude/tmp/preview/preview.html>. Append `?scenario=` with `list`, `mixed`, `empty`, `onboarding`, `error`, `ratelimit`, or `loading` to inspect each state. The preview is generated from `src/popup.html` rather than copied, so it cannot drift, and it is not part of the packaged extension.

## Layout

```
manifest.json          MV3 manifest
src/popup.html         Popup markup
src/popup.css          Design tokens and every component
src/popup.js           UI only: renders state, sends messages
src/service-worker.js  All network and tab work
src/github.js          GraphQL client and typed errors
src/tab-group.js       The idempotent open-into-a-group operation
src/pr-url.js          Pull request identity
src/store.js           Persisted settings
src/icons.js           The 16px icon set
```

`popup.js` never calls `fetch` or the tab APIs. Chrome destroys a popup the moment focus leaves it, and `chrome.tabs.create` can take focus, so a create-then-group sequence started in the popup would strand itself with tabs opened but never grouped. The service worker owns the whole operation and reports progress back to the popup if it is still alive.

## Limitations

- `api.github.com` only. No GitHub Enterprise Server.
- Up to 50 pull requests per list.
- The badge refreshes every 15 minutes, so it can lag reality by that much. The popup always refetches if its cache is over 60 seconds old.
