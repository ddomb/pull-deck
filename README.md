# Pull Deck

See your open GitHub pull requests and put them in one browser tab group.

**Mine**, **Reviews**, and **Assigned** show the PRs you authored, were asked to review, or were assigned. Rows include review status, CI status, and diff size. An optional macOS menu bar app controls the same extension.

## Install the extension

No build step or npm install is needed to load the extension. Requires Chrome 111+ or a compatible Chromium browser, including Edge and Brave.

1. Download and extract the repository, or clone it using the repository's clone URL.
2. Open `chrome://extensions` (`edge://extensions` or `brave://extensions` in those browsers).
3. Enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
4. Pin Pull Deck, open its popup, and connect a GitHub token.

Packaged source releases can also be loaded after extracting the extension ZIP. Keep the extracted folder in place; an unpacked extension uses those files directly.

## Connect GitHub

The popup links to GitHub's classic personal access token page. For private repositories it requests `repo` and `read:org`; for public-only use, `public_repo` is sufficient. Classic `repo` grants write privileges too, even though Pull Deck only reads GitHub data. Prefer a dedicated token and revoke it when no longer needed.

Fine-grained tokens see only repositories they were granted and can omit repositories from a cross-organization search. Organization policies and SSO authorization can also restrict results. GitHub Enterprise Server is not supported.

The token and cached PRs are stored in `chrome.storage.local`, within this browser profile. Pull Deck does not encrypt that storage. The token is sent only to `https://api.github.com/graphql`; it is not sent to the companion app. **Settings → Forget this token** clears account data and invalidates pending refreshes. Revoke the token on GitHub separately if you want to invalidate the credential itself.

## Opening pull requests

**Open all** puts the selected list into the saved tab group. Matching uses PR identity, including URLs ending in `/files`, `/commits`, query strings, fragments, and pending navigations. Repeated and simultaneous commands reuse the current group/tab state.

An existing unpinned PR tab in the group's window is moved into the group. The group stays in its own window. Pinned tabs and tabs in other windows are left in place, so opening a list can create a separate copy in those cases. Shortcut navigation instead reuses a matching tab across windows.

Failures are reported explicitly. If tabs open but cannot be grouped, they remain open for recovery; retrying adopts them instead of creating another copy.

Each scope currently contains up to **50 most recently updated PRs**. The UI says when a scope is truncated. A truncated or stale snapshot requires explicit selection in the shortcut chooser instead of automatic navigation.

## Keyboard

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move between PR rows |
| Enter | Open the focused PR |
| ⌘Enter / Ctrl+Enter | Open the current list |
| ⌘R / Ctrl+R | Refresh, subject to API cooldown |
| ← / → | Change scope when the scope tabs are focused |
| Esc | Close Settings |

Settings owns keyboard focus while open. Live updates preserve the focused PR when it remains in the list.

## Shortcut URLs

Use a URL such as `http://pull-dock/pr/ABC-123` to find a PR by ticket/branch. `pull-deck`, `pulldeck`, `pulldock`, and their `.test` variants also work.

| Shorthand | Meaning |
| --- | --- |
| `ABC-123` | Whole ticket token in a branch or title |
| `123` | Exact PR number |
| `api/123` | Exact PR number in that repository |
| `acme/api/123` | Exact PR number with owner and repository |
| `refresher` | Text search in branch/title, after whole-token matches |

A partial structured ticket such as `ABC-12` cannot select `ABC-123`. Ties and misses open a chooser; Enter never opens a nonmatching fallback row. Use slash-separated PR numbers in links; literal `#` has URL-fragment semantics, and encoded `%23` is preferable when generating a repository/number URL.

While the extension and its host permissions are enabled, Chrome's packaged declarative rules redirect matching top-level HTTP(S) requests to the internal resolver before the request is sent. This also works while the service worker is asleep. It does not make shortcut strings secret: browser history, operating-system integrations, and other extensions are outside Pull Deck's control.

The resolver checks cache freshness before automatic opening. It reuses an existing matching tab across windows, or creates/groups a PR tab. Its source page closes only after a destination was focused. Navigating away cancels the old page's ownership of the operation.

## Refresh behavior

The visible popup and visible companion panel request updates every five seconds. The companion requests updates every minute while its panel is closed. With the companion disconnected, a 15-minute alarm refreshes the badge when badge updates are enabled.

All requests share one in-flight refresh and cooldown policy. A successful cache is fresh for 60 seconds; forced refreshes have a four-second minimum interval. Below 500 remaining GraphQL points, refreshes slow to one minute. Below 100, cached results are retained until reset. Actual rate-limit responses preserve GitHub's retry deadline; other repeated failures use bounded backoff. Requests time out after 15 seconds.

GitHub's actual query cost and account limits can vary. The client uses returned rate-limit information rather than relying on an assumed hourly cost. Incomplete/error responses cannot silently replace a complete list with empty scopes.

## Optional macOS companion

Requires macOS 13+, Node 22.13+, Python 3, and Swift 5.9+ via Xcode or Command Line Tools. Build from the repository root:

```bash
npm run mac:build
open "macos/build/Pull Deck.app"
```

The app installs its native host manifest into detected Chromium browsers containing the extension. Load the extension before or after opening the app; setup shows what is missing. **Settings → Menu bar app → Retry now** skips the extension's reconnect delay.

One browser profile controls the companion at a time. Another profile receives an explicit “another browser profile” message. Close the controlling profile/browser, then retry from the intended profile. The extension itself continues working independently in every profile.

Release 1.4 uses bridge protocol 2. Rebuild/reopen the companion when upgrading from an earlier extension; a mismatched app/extension pair cannot complete the handshake.

For scripted installation or diagnosis:

```bash
macos/install-host.sh
"macos/build/Pull Deck.app/Contents/MacOS/pulldeck-bridge" --diagnose
```

To remove companion integration, quit the app and run `macos/install-host.sh --uninstall`. Remove the extension separately from the browser. You can add the locally built app to Login Items using macOS Settings.

The local app is ad-hoc signed. Downloadable, notarized macOS binaries are not part of the current release process.

## Permissions

| Permission | Purpose |
| --- | --- |
| `tabs` | Read tab URLs/pending destinations for reuse; open and focus PR tabs |
| `tabGroups` | Find, populate, name, and color the target group |
| `storage` | Store the token, settings, cache, and cooldown state |
| `alarms` | Background refresh and companion reconnect |
| `nativeMessaging` | Connect to the optional native relay |
| `webNavigation` | Verify the originating document still owns a shortcut action |
| `declarativeNetRequestWithHostAccess` | Redirect shortcut requests before HTTP delivery |
| `https://api.github.com/*` | Read GitHub GraphQL data |
| HTTP(S) shortcut hosts | Permit redirects for the eight exact shortcut hostnames |

The browser may describe `tabs` as access to browsing history. The resolver HTML is web-accessible to support incoming links, but other sites cannot read its extension-origin data. See SECURITY.md for the local trust boundary and reporting instructions.

## Development

```bash
npm ci
npm run check
npm test
```

Use the latest Node 22 patch release. Development dependencies provide linting, formatting, and DOM tests; none are shipped in the extension.

On macOS, `npm run test:all` adds Swift protocol/installer tests, actual native-server lifecycle tests, and a framed relay round trip. It builds its own required binaries and does not attach to an installed companion or real browser profile. `PULLDECK_BUILD_PATH` can point to an empty directory to check a clean Swift build.

`npm run preview` generates synthetic popup/resolver pages under `.claude/tmp/preview/` and serves them on loopback port 8731. Open `http://127.0.0.1:8731/.claude/tmp/preview/preview.html` or the neighboring `resolve.html`. `npm run format` formats JavaScript; `npm run generate` updates shared identity and redirect rules; `npm run package` builds the allowlisted extension ZIP in `dist/`.

The module boundaries and contribution process are in CONTRIBUTING.md. Native wire behavior is in BRIDGE.md. See `docs/releasing.md` for the release checklist and distribution limits.

## License

MIT. See LICENSE.
