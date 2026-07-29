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

The extension id is pinned to `jdpikjmmmljjpkmfmhgildnaihbpmfpj` by the `key` field in `manifest.json`, so it is stable across machines and paths. Regenerate that identity with `node tools/make-extension-key.mjs --force` — which invalidates every installed host manifest, so only do it deliberately.

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
| `webNavigation` | Catching `http://pull-dock/…` shortcuts before they hit the network |
| `https://api.github.com/*` | The one host it talks to |

`webNavigation` adds no new warning text — `tabs` already covers it — and the listener is registered with a host filter, so Chrome only wakes the worker for the shortcut hosts rather than for every page you open.

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

## Jump straight to a pull request

Type this anywhere a URL goes:

```
http://pull-dock/pr/abv-4242
```

and you land on `https://github.com/Above-Security/above/pull/6081` — whichever open pull request has that ticket in its branch. Nothing is configured per repository; it resolves against the same list the popup is showing.

It is not a real address, and it never reaches the network. The extension catches the navigation in `webNavigation.onBeforeNavigate` — before the request leaves the browser — and replaces it. Waiting for `pull-dock` to fail DNS instead would mean watching an error page appear and then disappear.

**What you can put after the slash**, best match first:

| Shorthand | Matches |
| --- | --- |
| `abv-4242` | The ticket id as a whole token in the branch name |
| `6081`, `#6081` | That pull request number |
| `above#6081`, `above/6081` | That number in that repository, when two repos share one |
| `refresher` | Words in the branch, then in the title |

`pull-deck` and `pulldeck` work too, as does `/abv-4242` with no `/pr/`. If a corporate DNS search list turns the bare host into something that genuinely resolves, use `pull-dock.test` — [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761) reserves `.test` so it can never be registered.

**It refuses to guess.** Two pull requests carrying the same ticket is ordinary — a stacked branch, a revert, a cherry-pick to a release branch — so a tie is never broken. You get a chooser instead, and nothing opens until you pick. Same for a miss, which lists everything open with a search field, so a typo costs a keystroke rather than a retype.

That caution is the whole design. A miss is a mild annoyance; a *wrong* hit sends you to somebody else's pull request and you may not notice until you have already commented on it. So matching is on whole tokens, not substrings: `abv-424` does not match `ABV-4242`, and `abv-4242` does not match `ABV-42421`. `test/resolve.test.mjs` leads with those two cases.

**Already open? You go to that tab. Otherwise it lands in the group.** The shortcut resolves to a pull request and then looks for it using the same `(host, owner, repo, number)` identity the rest of the extension uses — across every window, not just the current one. Found, and that tab is focused and left exactly where it is; moving a tab you never asked to have moved is its own kind of surprise. Not found, and it goes through the same `openIntoGroup()` the popup uses, so it arrives in the group with everything else.

Either way the tab you typed into closes, because you are by then looking at the pull request somewhere else. The one thing that keeps it alive is failing to put you anywhere: if focusing the existing tab fails, or grouping does, it redirects in place instead.

### From the Claude Code footer

Typing the URL by hand is the fallback, not the point. Claude Code's `footerLinksRegexes` turns any ticket id that appears in turn output — a tool result, or something Claude wrote — into a clickable badge in the footer row. Point that badge at the shortcut and the whole path is one click.

In `~/.claude/settings.json` (user settings only — the setting is ignored in project `.claude/settings.json` and in `.claude/settings.local.json`):

```json
"footerLinksRegexes": [
  {
    "type": "regex",
    "pattern": "\\b(?<key>[Aa][Bb][Vv]-\\d+)\\b",
    "label": "PR {key}",
    "url": "http://pull-dock/pr/{key}"
  }
]
```

`http` is fine here: the scheme allowlist is `https`, `http`, and a set of editor and workspace deep links, and the origin only has to be literal in the template — which `http://pull-dock` is.

The character classes are doing real work. Claude Code compiles the pattern itself and it is not documented whether it adds the `i` flag, so `[Aa][Bb][Vv]` matches `ABV-4242` in a branch name and `abv-4242` in prose without depending on the answer. The matcher lowercases both sides anyway, so the captured case never reaches GitHub.

Two things worth knowing before relying on it: at most **five** badges render at once, the oldest displaced by newer matches, and `/clear` removes them all. And the badge opens your **default** browser — the shortcut only resolves in a browser that has Pull Deck loaded.

## Live updates

Both surfaces poll every 5 seconds while they are on screen — the popup while it is open, the menu bar app while its panel is open. With the panel closed the app drops to 60 seconds, which keeps the badge honest, and with nothing attached the 15-minute background alarm takes over.

The rate is gated where it matters rather than in each caller. `mayFetchNow()` in `app-state.js` is the single choke point every request passes through:

| Condition | Effect |
| --- | --- |
| Less than 4s since the last network fetch | Serve cache. Two surfaces polling at once cannot double the spend. |
| Under 500 points remaining | Stretch to one request a minute |
| Under 100 points remaining | Stop entirely and coast on cache until the window resets |

That last one matters: the alternative is spending the hour's allowance in twenty minutes and then showing nothing at all.

**What it costs.** One GraphQL round trip is about 3 points against a 5,000/hour budget, so a sustained 5-second cadence runs at roughly 2,160 points/hour — viable, but only worth paying while somebody is looking, which is why it is gated on visibility. Rows are only rebuilt when something they display actually changed, so a tick does not reset your scroll position or drop keyboard focus.

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

Generates stubbed copies of the popup and the chooser under `.claude/tmp/preview/` and serves them at
<http://127.0.0.1:8731/.claude/tmp/preview/preview.html> and
<http://127.0.0.1:8731/.claude/tmp/preview/resolve.html>. Append `?scenario=` with `list`, `mixed`, `empty`, `onboarding`, `error`, `ratelimit`, or `loading` to inspect each popup state; the chooser takes `?q=` and drives the real matcher, so what you see there is what `src/resolve.js` actually decides. Both are generated from the shipped HTML rather than copied, so they cannot drift, and neither is part of the packaged extension.

The chooser especially needs this: nothing links to it, and the service worker only navigates a tab there on a miss — without a preview the only way to look at the page would be to type a shortcut and hope it fails.

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
src/resolve.js         Shortcut URL parsing and the matching rules
src/resolve.html/.css  The chooser, for a tie or a miss
src/resolve-page.js    Chooser UI
src/pr-row.js          Row furniture shared by both surfaces
src/store.js           Persisted settings
src/icons.js           The 16px icon set
```

`pr-row.js` exists for `badgesFor`. Two copies of the mapping from GitHub's review and check states to what you actually see would drift, and then the popup and the chooser would disagree about whether the same pull request is approved — worse than either being wrong, because there is no longer a right answer to point at.

`popup.js` never calls `fetch` or the tab APIs. Chrome destroys a popup the moment focus leaves it, and `chrome.tabs.create` can take focus, so a create-then-group sequence started in the popup would strand itself with tabs opened but never grouped. The service worker owns the whole operation and reports progress back to the popup if it is still alive.

## The macOS menu bar app

`macos/` holds a native menu bar app that drives this extension. The extension keeps working entirely on its own — the app is an additional client, not a replacement.

**Why it needs the extension at all.** A native macOS app cannot create Chrome tab groups. Chrome's scripting dictionary exposes `application`, `window`, `tab`, `bookmark folder` and `bookmark item` — there is no tab group class, and `tab` exposes only `id`, `title`, `URL` and `loading`. Edge ships the identical dictionary; Safari's has only `tab`. Tab groups exist solely behind `chrome.tabGroups`, inside the extension sandbox. So the app asks the extension to do it.

**The app holds no secrets and knows no URLs.** It has no GitHub token, no GitHub client, and no copy of the pull-request identity rule. It names a scope (`mine` / `reviewing` / `assigned`); the extension resolves that against its own cache and calls the same `openIntoGroup()` the popup uses. See [BRIDGE.md](BRIDGE.md) for the protocol and the reasoning.

### Install

```bash
npm run mac:build
open "macos/build/Pull Deck.app"
```

That is the whole thing. The app installs the native messaging host itself, into whichever browsers actually have the extension loaded, and re-checks every few seconds while it is not connected. Load the extension whenever you like — before or after opening the app — and the two find each other within about a minute.

Add the app to Login Items to have it start with the Mac.

**Why there is nothing to paste.** The extension id is pinned by the `key` field in `manifest.json`, so it is the same on every machine and survives the repo moving. Without it Chrome derives the id from the absolute path — `SHA-256("/Users/you/pull-deck")` — so relocating the repo silently changed the id and broke every manifest naming the old one.

**Why it keeps working.** Three things used to break it silently, all of which looked identical from the outside:

| Used to break | Now |
| --- | --- |
| Repo moves → id changes | Id is pinned, so it does not |
| App moves or is rebuilt → `path` goes stale | Rewritten from the app's own bundle path each launch |
| Manifest installed in a browser you do not use | Installed only where the extension is loaded, and removed when it is not |

The app's setup panel names the step that is actually incomplete rather than saying "not connected", and the extension's Settings has a **Menu bar app** row with a **Retry now** button for skipping any pending backoff.

```bash
cd macos
./install-host.sh              # same thing, from a terminal
./install-host.sh --uninstall  # remove it everywhere

# Shows every browser found, whether the extension is loaded, and why not
"build/Pull Deck.app/Contents/MacOS/pulldeck-bridge" --diagnose
```

**Browsers are found by shape, not by name.** Any directory under `~/Library/Application Support` holding Chromium's `Local State` marker plus a profile counts — which is how Helium (`net.imput.helium`), Dia and other forks get picked up. A hard-coded list of browser names cannot know about the next fork, and the failure is silent: the extension loads fine and the bridge is simply never installed.

**If you loaded the extension before the id was pinned**, Chromium still has it registered under the old path-derived id — editing `manifest.json` does not retroactively move it. Press the reload arrow on its card at `chrome://extensions`. The app detects this case by name and says so rather than sitting there unconnected.

Both call straight into the app's own installer, so the command line and the GUI cannot drift apart.

Requires macOS 13+ (`MenuBarExtra`). Builds with Command Line Tools; full Xcode is not needed.

### Tests

```bash
npm run test:all     # extension + macOS
npm run mac:test     # Swift assertions, then a real round trip through the relay binary
npm run mac:live     # impersonates Chrome against the running app
```

`mac:live` spawns the actual relay with Chrome's argv and stdio framing and talks to whatever app is listening, so it exercises the live app process, the real socket, and real JSON decoding. The only simulated part is Chrome itself.

## Limitations

- `api.github.com` only. No GitHub Enterprise Server.
- Up to 50 pull requests per list.
- The badge refreshes every 15 minutes, so it can lag reality by that much. The popup always refetches if its cache is over 60 seconds old.
