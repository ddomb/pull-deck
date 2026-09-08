# Pull Deck review fixes — 2026-09-08

Read this report alongside the [original audit](code-review-2026-09-08.md). Fixes for all 22 numbered findings were implemented on `ariel/open-source-hardening`, based on commit `9b20c2ba2f80e3fa1c9a6a9bb319cca2f4675646`. This report records local implementation and validation; it does not certify a published release. Release version is 1.4.0; the extension and companion now use bridge protocol 2.

## Correctness, privacy, and process survival

| Finding | Implemented change | Regression evidence |
| --- | --- | --- |
| F01: partial ticket opens the wrong PR | Structured ticket, repository/number, and numeric queries require exact matches; they cannot fall through to fuzzy matching. | Public matcher tests cover truncated tickets and structured queries; chooser tests reject a nonmatch on Enter. |
| F02: overlapping opens duplicate tabs | A worker-wide queue serializes complete tab operations. Inputs are deduplicated and existing state is read inside the operation. Pending navigation destinations participate in identity matching. | Concurrent open tests verify one tab/group; tab tests cover navigation toward and away from a PR. |
| F03: obsolete requests restore account data | One refresh coordinator cancels obsolete fetches. Authentication revisions and serialized commits prevent old results from changing storage, badges, or delivered state. UI/native consumers reject older account revisions. | Delayed refresh, forget, reconnect, and load-during-auth-transition regressions; native revision test. |
| F04: disconnected socket terminates the app | Connected and accepted sockets suppress SIGPIPE. The relay handles broken stdout pipes. Connection ownership controls shutdown, queued writes, and final close. | Actual socket write after peer closure survives; real relay tests verify exit on disconnect. |

## Refresh and shortcut behavior

| Finding | Implemented change | Regression evidence |
| --- | --- | --- |
| F05: Enter opens a fallback nonmatch | Match status is independent of displayed fallback rows. Implicit activation requires a real unique, fresh, complete result. | Actual chooser module under jsdom; browser preview confirms partial ticket has no match. |
| F06: throttle is bypassed or races | Popup, resolver, native commands, and alarms share a single in-flight request and persisted scheduling policy. Requests have a 15-second timeout; UI polling also prevents overlap. | Concurrent callers, ordinary exhausted-budget load, timeout, and coordinator tests. |
| F07: rate-limit cooldown disappears | HTTP and GraphQL errors preserve retry metadata. Retry-After takes precedence, and the next allowed fetch time is persisted independently of a successful cache. | Primary/secondary limit, HTTP-200 GraphQL error, 403 classification, and repeated-load deadline tests. |
| F08: asynchronous redirect cannot guarantee network isolation | Static Declarative Net Request rules redirect exact shortcut hosts to an internal resolver before asynchronous application work. Rules are generated from the extension identity; the resolver has an explicit CSP. | Generated rule/host coverage tests and Chrome's documented API contract. Actual installed-extension network behavior remains a release smoke check below. |
| F09: delayed shortcut completion closes the wrong page | Opening is tied to the originating tab URL and document identity. Source ownership is rechecked; focus has an explicit result. The chooser dismisses only after success and invalidates work on page exit. | Navigation cancellation, failed focus, partial failure, and page-exit tests. |
| F10: resolver uses arbitrarily old data | Resolution obtains a freshness-qualified snapshot through the coordinator. Stale/truncated results require deliberate selection and have visible status. | Stale resolver refresh and chooser activation tests. |
| F11: failed scope looks empty | Missing/failed GraphQL search connections reject the refresh, preserving the previous cache and reporting an error. Page information exposes truncated scopes. | Partial/null/missing scope and truncation tests. |

## Native protocol and operation lifecycle

| Finding | Implemented change | Regression evidence |
| --- | --- | --- |
| F12: grouping failure/no-op leaves Open All stuck | Every operation has an ID and terminal event. Grouping failure preserves recoverable tabs and returns failures; metadata errors return warnings. Native completion settles progress and busy state on every outcome. | JavaScript grouping/no-op tests and native failure/no-op/partial-result tests. |
| F13: native decoder drops valid replies | Reply payloads distinguish state, open results, and other acknowledgments. Pending commands are correlated by ID, and partial failures survive decoding. | Actual JavaScript-produced getState/settings/ping/open fixtures decoded by Swift; native state display and error tests. |
| F14: second browser/profile silently waits | Connection acceptance is serviced independently. Additional sessions receive an explicit rejection. The extension reports connected only after a compatible application handshake. | Actual two-client socket test; extension rejection/timeout/handshake tests. |
| F15: reconnect retains stale busy state | Detach cancels pending commands and clears operation state. Writes, replies, progress, and asynchronous errors are bound to their connection. Reconnect scheduling covers failed sends as well as disconnect events. | Disconnect during opening, replacement-session, stale-error, and reconnect-on-send-failure tests/probes. |

## UI, compatibility, and build portability

| Finding | Implemented change | Regression evidence |
| --- | --- | --- |
| F16: refresh loses keyboard focus | List updates preserve focused PR identity and scroll position. Counts from another scope no longer invalidate the visible list. | Actual popup DOM tests for status refresh and unrelated scope updates. |
| F17: Settings exposes covered keyboard actions | Covered views become inert, and global shortcuts respect the active view. Focus returns when Settings closes. | Popup DOM tests and browser accessibility/keyboard smoke check. |
| F18: declared Chrome floor is too old | Manifest and installation documentation now require Chrome/Chromium 111 or newer. | Manifest check; CSS/API compatibility checked against official Chrome documentation. Chrome 111 itself was not executed. |
| F19: clean native tests omit the relay build | The native test runner builds required products, resolves the actual binary directory, and runs self-tests, runtime tests, and the real relay. | Advertised test command passed with a new, empty Swift build directory. |
| F20: checkout paths break app metadata | Python plist serialization safely encodes paths. Assembly validates the plist, fails on signing errors, and verifies the completed signature. Build output handles absolute destinations. | XML-metacharacter fixture and successful release app assembly/signature verification. |
| F21: key rotation leaves native identity stale | Manifest identity generates native authorization and redirect rules. Key rotation updates dependent outputs; build/check commands detect drift. | Ephemeral key-rotation test and generated-configuration checks. No real signing identity was rotated. |
| F22: accessible row names omit status | Popup and chooser labels derive from the same badge model as visible status and update with grouping state. | DOM label tests and current browser accessibility tree. Screen-reader speech was not exercised. |

## Structure, performance, and contributor preparation

Refresh policy, badge handling, serialized errors, shortcut ownership, and protocol constants now have focused modules. Native connection/command handling is extracted from the app into the testable `PullDeckRuntime` library. Canonical PR keys cross the bridge, eliminating suffix-only identity matching. Shared producer fixtures test the JavaScript-to-Swift contract.

Native group membership is cached once per state. Profile reconciliation is skipped while a session is attached and cannot overlap itself. Polling shares refresh work, honors failure deadlines, and uses slower idle native polling. These changes remove identified redundant work; no CPU/battery benchmark or GitHub traffic load test was performed.

The popup remains a vanilla JavaScript controller. Shared row/status logic and actual DOM transition tests support the focused fixes; a broad framework rewrite was not needed to resolve the reviewed defects.

Contributor/release additions include a dependency lockfile, ESLint and Prettier checks, Swift formatting configuration, Linux/macOS CI jobs, CONTRIBUTING, SECURITY, generated version/identity checks, and a deterministic extension package whitelist. README and BRIDGE documentation now cover permissions, account clearing, scope truncation, current polling, installation prerequisites, and protocol compatibility.

**License assumption:** MIT is included as a proposed local default because no license preference was supplied. The owner must review that choice before publication. A public GitHub repository/private vulnerability reporting channel and Developer ID signing/notarization are not configured by these local changes.

## Final validation

| Check | Result |
| --- | --- |
| `npm test` | 118 passed, 0 failed. |
| `npm run check` | JavaScript syntax, generated configuration, manifest/version consistency, ESLint, and Prettier passed. |
| `PULLDECK_BUILD_PATH="$PWD/.claude/tmp/final-clean-swift" npm run mac:test` | Clean build passed: 57 Swift self-checks, 23 native runtime checks, 6 actual relay checks. |
| `PULLDECK_APP_OUTPUT="$PWD/.claude/tmp/release-check/Pull Deck.app" npm run mac:build` | Release app built; plist validation and strict ad-hoc signature verification passed. |
| `npm run package` | Created `dist/pull-deck-1.4.0.zip`; package whitelist regression passed. |
| `npm audit --omit=dev` | 0 reported vulnerabilities in production dependencies. The extension has no production npm dependencies. |
| `git diff --check` | Passed. |
| Browser preview | Current popup visuals, accessible status labels, Settings keyboard ownership, and resolver nonmatch checked; no console errors observed. Synthetic transport only. |
| Independent targeted recheck | Auth snapshot delivery, pending tab identity, failed-send reconnect, and stale bridge errors rechecked after correction; reviewers reported no remaining findings within those targeted checks. |

Verification logs and sanitized fixtures are under the ignored project-root `.claude/tmp/`; they are not included in the extension artifact. The temporary browser preview servers were stopped after verification. No credentials, live GitHub requests, installed hosts, running companion, or Docker stacks were used.

## Before public release

1. Review the proposed MIT license and the local changes.
2. Run the isolated-profile installation and network checks in [the release guide](releasing.md), using the matching protocol-2 companion. Browser preview and socket tests do not verify an installed extension's declarative network behavior.
3. Configure the public repository and private vulnerability reporting; run the committed CI workflow. No Git remote is configured in this checkout, so hosted CI was not run.

Only source-built, ad-hoc-signed macOS installation is prepared. Publishing downloadable macOS binaries still needs a separately verified signing and notarization process.
