# Pull Deck: full code and release-readiness review

**Historical audit of commit `9b20c2b`.** The fixes and current validation results are recorded in [the remediation report](remediation-2026-09-08.md). Findings and line references below describe the original code, before those changes.

Fix F01–F04 before a public release. The current version can open the wrong PR, duplicate tabs, restore private cached data after disconnect, and crash the native app during a browser disconnect.

Reviewed the full repository at `9b20c2ba2f80e3fa1c9a6a9bb319cca2f4675646`, on `main`, initially clean. No remote or `origin/main` is configured, so this review is pinned to that local commit. Scope includes the extension, Swift app/relay/installer, tests, developer tools, and product/install documentation. No production source files were changed.

**Findings: 4 P1, 17 P2, and 1 P3.** P1 means high-impact correctness/privacy/reliability defects to prioritize immediately; P2 means meaningful behavior or compatibility defects; P3 means a smaller usability issue. Release-process and structure recommendations are separate from those counts. Runtime reproductions use isolated mocks or native harnesses unless explicitly identified as a browser-preview check.

## What was verified

| Check | Result | Practical limit |
| --- | --- | --- |
| `npm test` | 82/82 passed | Existing tests miss the asynchronous and UI defects below. |
| `npm run mac:test` in the existing checkout | 57 Swift + 6 relay checks passed | Existing debug relay binary masked a missing build step. |
| Swift self-test with an empty scratch directory | 57/57 passed; relay absent | Running the relay check against that output failed with `relay binary missing`. |
| Full `swift build` in that isolated scratch directory | All products built successfully | Compiled app; did not install or launch it. Relay then passed all 6 checks. |
| Additional JavaScript audit probes | 12 defective behaviors reproduced | Sanitized in-memory Chrome/storage/GitHub APIs, using unchanged production modules. |
| Independent native probes | SIGPIPE crash, stuck progress, dropped replies, second connection not serviced | Actual native source in isolated harnesses; private methods exposed only in temporary copies where needed. |
| Actual popup preview keyboard interaction | Hidden Open All activated from Settings | Generated preview with fake transport; no real tabs opened. |
| Tracked-history secret pattern scan | No matches in 30 commits / 133 unique blobs | Checked common GitHub token, AWS access-key, and private-key patterns; not a complete secrets certification. |

Environment: Node `22.22.1`, Apple Swift `6.2.3`, arm64 macOS. No real GitHub credentials, live native app, installed host manifests, Docker stacks, or user browser profiles were used for verification. Real extension installation/navigation, network leakage, older Chrome rendering, and screen-reader speech were not exercised end to end.

The repeatable extension probes are saved in [reproduce.mjs](/Users/ddomb/pull-deck/.claude/tmp/review/reproduce.mjs). Run from the repository root:

```bash
node .claude/tmp/review/reproduce.mjs
```

That script passes when it reproduces today's defects; it is an audit tool, not a passing regression suite for the desired behavior.

## Highest priority

### F01 · P1 · A partial ticket can automatically open the wrong PR

[resolve.js:126](/Users/ddomb/pull-deck/src/resolve.js:126)

After `containsToken()` correctly rejects a truncated ticket, `tierFor()` falls through to unrestricted `includes()` matching. `findMatches('ABV-424', [branch ABV-4242])` returns `one`; so does `ABV-4242` against `ABV-42421`. The service worker automatically opens that single result. This defeats the explicit product promise to refuse a wrong hit.

**Evidence:** both cases reproduced through the real `findMatches()` export. Existing boundary tests only exercise `containsToken()`, so all 82 tests remain green.

**Fix:** classify structured ticket/repository/number queries before fuzzy matching and prohibit fuzzy fallback for them. Test the public matcher and routing decision, not only the helper.

### F02 · P1 · Concurrent opens violate the no-duplicates promise

[app-state.js:199](/Users/ddomb/pull-deck/src/app-state.js:199), [tab-group.js:73](/Users/ddomb/pull-deck/src/tab-group.js:73)

Two operations can inspect the same pre-operation tab/group state and both create what they believe is missing. There is no worker-wide queue or lock. The popup's `busy` flag covers one popup's bulk operation; it cannot protect simultaneous native/shortcut operations, and individual row clicks do not set it.

**Evidence:** two simultaneous `openAll([samePR])` calls produced **two tabs and two groups**. Sequential re-click tests do not exercise this race.

**Fix:** serialize the complete read/create/group/persist operation in the worker, including single-PR opens. Deduplicate incoming identities and re-read group state after acquiring ownership. Test overlapping popup/native/single-PR commands.

### F03 · P1 · In-flight refreshes survive token removal or replacement

[app-state.js:116](/Users/ddomb/pull-deck/src/app-state.js:116), [app-state.js:140](/Users/ddomb/pull-deck/src/app-state.js:140), [app-state.js:167](/Users/ddomb/pull-deck/src/app-state.js:167)

Removing a token clears storage immediately, but an older request can later write its private PR cache back and restore the badge. Replacing the token has a related race: the old response can overwrite the newly connected account's cache while the new token remains stored. Outstanding callers can also receive obsolete account state.

**Evidence:** a delayed refresh restored the old cache and badge after `applySettings({token:null})`; a second probe ended with `token='new-token'` and `cache.viewer.login='old-user'`.

**Fix:** give authentication changes a generation/version, cancel obsolete requests, and reject stale results at both storage-commit and response-delivery boundaries. Include background and shortcut refreshes in the same mechanism.

### F04 · P1 · A closed socket can kill the native app

[UnixSocket.swift:125](/Users/ddomb/pull-deck/macos/Sources/PullDeckKit/UnixSocket.swift:125), [BridgeServer.swift:235](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/BridgeServer.swift:235)

`writeAll()` calls POSIX `write()` without handling `SIGPIPE`. A queued refresh/open write can race a relay disconnect during browser shutdown or extension reload. The process can terminate before the intended `false` return and detach logic run.

**Evidence:** compiled unchanged `UnixSocket.swift` into an isolated socketpair harness, closed the peer, and wrote to it: process exit **−13 / SIGPIPE**. This matches [Apple's socket guidance](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/NetworkingOverview/CommonPitfalls/CommonPitfalls.html).

**Fix:** suppress/handle SIGPIPE on all applicable accepted/connected sockets and relay pipes, handle write failure, and add a close-during-write regression check.

## Extension behavior and API use

### F05 · P2 · Enter opens a nonmatch from the chooser

[resolve-page.js:164](/Users/ddomb/pull-deck/src/resolve-page.js:164), [resolve-page.js:243](/Users/ddomb/pull-deck/src/resolve-page.js:243)

A failed search renders every PR as fallback rows. Enter checks `state.rows.length === 1`, rather than whether the matcher found one result. With one PR in the account, an unrelated query opens that PR while the heading says “Nothing open matches.”

**Evidence:** executed the actual module functions with a minimal DOM harness; matcher status was `none`, but `openOne` was sent for the unrelated PR.

**Fix:** retain the match status and permit implicit Enter activation only for a genuine single match. Require explicit row selection for fallback results.

### F06 · P2 · The refresh throttle is neither exclusive nor universal

[app-state.js:98](/Users/ddomb/pull-deck/src/app-state.js:98), [service-worker.js:253](/Users/ddomb/pull-deck/src/service-worker.js:253), [popup.js:478](/Users/ddomb/pull-deck/src/popup.js:478)

Concurrent requests read the same old timestamp and all pass the throttle before any finishes. Ordinary stale loads bypass `mayFetchNow()` entirely, because the check only applies to `force`; the background alarm fetches directly. Slow requests can accumulate across successive five-second ticks. This increases API traffic and permits responses to arrive out of order.

**Evidence:** two simultaneous forced loads issued two requests; an ordinary load with an exhausted cached budget and future reset still fetched. The alarm bypass is directly visible in its handler. The existing “two surfaces” test manually supplies a cache already updated by a completed request, which does not model concurrency.

**Fix:** use one refresh coordinator with a shared in-flight promise, request-start timing, and budget policy for every caller. Use a bounded request timeout. Keep explicit cache migrations as narrow, testable exceptions.

### F07 · P2 · GitHub rate-limit responses lose their retry deadline

[github.js:59](/Users/ddomb/pull-deck/src/github.js:59), [github.js:100](/Users/ddomb/pull-deck/src/github.js:100), [github.js:124](/Users/ddomb/pull-deck/src/github.js:124)

The HTTP-200 GraphQL `RATE_LIMITED` path drops rate-limit headers and creates an error without `retryAt`. Failed requests leave the last successful cache timestamp/budget in place, and refresh scheduling never consults the saved error deadline. As a result, the live loop can keep retrying while GitHub has told it to wait. HTTP-403 classification also treats any reset header as evidence of a rate limit, and `parseRetryAt()` prefers reset over `retry-after`.

**Evidence:** a mock HTTP-200 GraphQL rate-limit response with a future reset produced `retryAt:null`; two sequential forced loads immediately issued two requests. [GitHub documents HTTP-200 rate-limit failures and the required cooldown behavior](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#exceeding-the-rate-limit).

**Fix:** interpret status, body, remaining budget, and headers together; honor `retry-after` and persist a next-allowed-at deadline independently of successful cache data. Test primary and secondary limits through `loadState()`.

### F08 · P2 · Shortcut URLs are not guaranteed to stay off the network

[service-worker.js:112](/Users/ddomb/pull-deck/src/service-worker.js:112), [README.md:89](/Users/ddomb/pull-deck/README.md:89)

The README promises that shortcut navigation never reaches the network. `webNavigation.onBeforeNavigate` is an asynchronous notification; this callback cannot suspend the request while storage, GitHub, and tab work finish. On a network where a shortcut hostname resolves, its path can reach that destination before replacement. `.test` reservation is also not a guarantee against local DNS configuration.

**Evidence:** confirmed API contract and current call path; actual DNS/HTTP leakage was not measured. Chrome explicitly documents [no defined ordering between webNavigation and network-request events](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#relation-to-webrequest-events).

**Fix:** use a browser-supported blocking/declarative redirect to an internal resolver, or another local entry mechanism, and test it with a deliberately resolvable shortcut host. Correct the privacy/install claims to match the mechanism actually shipped.

### F09 · P2 · Shortcut completion can close the wrong tab state

[service-worker.js:136](/Users/ddomb/pull-deck/src/service-worker.js:136), [service-worker.js:164](/Users/ddomb/pull-deck/src/service-worker.js:164), [app-state.js:223](/Users/ddomb/pull-deck/src/app-state.js:223), [resolve-page.js:190](/Users/ddomb/pull-deck/src/resolve-page.js:190)

Resolution and opening have several awaits, but completion never verifies that the originating tab still belongs to that shortcut navigation. A user can navigate away while it is pending, then have their new page closed or replaced. Separately, `openOne()` swallows focus failures and returns success; the route then closes the source tab anyway. The chooser checks transport `ok` but ignores individual opening failures before dismissing itself.

**Evidence:** isolated service-worker probes reproduced source-tab removal after both a focus failure and a subsequent user navigation. The chooser's unchecked `failures` path is source-confirmed.

**Fix:** associate completion with the exact navigation/request generation, verify ownership before mutation, and return an explicit focused destination outcome. Dismiss the source only after confirmed placement; keep a recoverable error otherwise.

### F10 · P2 · Shortcut resolution ignores cache age

[app-state.js:298](/Users/ddomb/pull-deck/src/app-state.js:298)

The resolver refreshes only when the cache is missing or lacks branch fields. A normally shaped cache can be arbitrarily old. Recently opened PRs are missed, closed PRs remain eligible, and an old branch match can win even when the current result would be ambiguous. The chooser continues filtering the same snapshot locally.

**Evidence:** a day-old cache caused zero requests and a miss for a new ticket. Background refresh reduces this window when enabled; it does not make the resolver's freshness check correct.

**Fix:** obtain a freshness-qualified snapshot through the shared refresh coordinator. If freshness cannot be obtained, expose stale status and avoid claiming an authoritative unique match.

### F11 · P2 · A failed GraphQL scope is displayed as an empty list

[github.js:120](/Users/ddomb/pull-deck/src/github.js:120), [github.js:138](/Users/ddomb/pull-deck/src/github.js:138)

If GitHub returns a viewer plus a non-auth/rate-limit error on a search alias, that alias can be null. Normalization replaces it with `[]`, and the result is stored as a successful refresh. A temporarily failed Mine/Reviews query is therefore presented as no PRs, and can reduce the badge count.

**Evidence:** a payload containing `viewer`, `mine:null`, and a `mine` error normalized to a successful empty Mine scope with no warning.

**Fix:** distinguish missing/failed connections from valid empty connections. Preserve the affected cached scope with an explicit partial-data error, or reject the refresh. Retain usable field-level partial data deliberately.

## Native operation and connection state

### F12 · P2 · Failed or no-op grouping leaves native Open All disabled

[tab-group.js:135](/Users/ddomb/pull-deck/src/tab-group.js:135), [tab-group.js:185](/Users/ddomb/pull-deck/src/tab-group.js:185), [BridgeServer.swift:209](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/BridgeServer.swift:209), [MenuContent.swift:229](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/MenuContent.swift:229)

Tab progress reports success before the final grouping call. A grouping failure can leave created tabs ungrouped; either a grouping or metadata-update exception emits no `done`. The no-missing branch also emits `start` and returns without `done`. Native reply handling clears `isOpening` but never `progress`; the button remains disabled while `progress` exists. A native snapshot becoming stale after the popup opened the same list makes the no-op path realistic.

**Evidence:** JavaScript probe confirmed successful tab progress followed by an uncaught grouping failure and ungrouped tabs. A compiled native handler probe confirmed that a failed terminal reply left progress non-null.

**Fix:** represent operation identity and terminal outcome explicitly. Settle every success/failure/no-op path; distinguish tab creation from successful grouping. Make surviving tabs and grouping recovery visible to the caller.

### F13 · P2 · Native reply decoding rejects valid commands and discards partial failures

[Protocol.swift:129](/Users/ddomb/pull-deck/macos/Sources/PullDeckKit/Protocol.swift:129), [Protocol.swift:187](/Users/ddomb/pull-deck/macos/Sources/PullDeckKit/Protocol.swift:187), [BridgeServer.swift:212](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/BridgeServer.swift:212)

Every reply's `data` is decoded as `OpenResult`, which requires `created`, `adopted`, and `skipped`. Successful `getState`, `settings`, and `ping` replies have different shapes, so the whole envelope fails decoding and is silently dropped. The Swift `OpenResult` model omits `failures[]`; native code ignores the result and clears the previous error on `ok:true`, so individual failed tabs disappear from the user-visible outcome.

**Evidence:** actual Swift decoder returned nil for all three valid non-open success payloads. An open payload with failures decoded without retaining them. State pushes often mask the dropped replies, but do not repair the contract or restore all operation/error state.

**Fix:** decode the envelope independently, discriminate payloads using command/type, correlate replies by ID, and preserve partial failures. Exercise each real JS producer payload through the Swift consumer.

### F14 · P2 · The first browser/profile silently owns the menu app

[BridgeServer.swift:154](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/BridgeServer.swift:154), [bridge.js:111](/Users/ddomb/pull-deck/src/bridge.js:111)

The accept loop serves the first relay until it disconnects. Another browser/profile can establish a socket connection into the backlog without ever being serviced. Its extension reports connected based solely on a Port existing; Retry now does nothing. The installer supports multiple browsers, but the app has no session selection or explicit rejection to explain which browser receives actions.

**Evidence:** isolated actual server harness: client one received `getState`; client two connected successfully but received nothing while client one remained attached.

**Fix:** identify and explicitly select an active browser/profile, or reject additional sessions with an understandable status. Report connected only after an application handshake. Test two clients, even when both belong to the same GitHub account.

### F15 · P2 · Disconnecting during an open can stop native polling indefinitely

[BridgeServer.swift:109](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/BridgeServer.swift:109), [BridgeServer.swift:182](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/BridgeServer.swift:182)

`openAll()` sets `isOpening`, but disconnect clears only attachment/progress/timers. After reconnect, `tick()` still refuses work because `isOpening` remains true. State pushes do not clear it, and the initial successful `getState` reply is currently dropped by F13. Manual refresh or incidental pushes can make the app look partly alive while periodic freshness has stopped.

**Evidence:** state-transition path confirmed against the actual handlers and the independently reproduced decoder failure. Not reproduced by disconnecting the live app.

**Fix:** cancel and settle outstanding commands on detach, reset operation state, and associate delayed callbacks with a connection generation. Test disconnect/reconnect during both bulk and single-item opening.

## UI and compatibility

### F16 · P2 · Live refresh removes the focused row

[popup.js:187](/Users/ddomb/pull-deck/src/popup.js:187), [popup.js:255](/Users/ddomb/pull-deck/src/popup.js:255)

Changing CI/review/group state makes `renderList()` replace every row. It retains an integer focus index but never restores actual focus to the replacement DOM node. Even another scope's count changing invalidates the current list. A user navigating by keyboard can lose focus every time real state changes; after sorting, the same index can also identify a different PR.

**Evidence:** complete rendering/invalidation path inspected; a live-refresh browser reproduction was not performed.

**Fix:** update rows by stable PR ID or capture/restore focused identity and scroll position deliberately. Remove unrelated scope counts from row invalidation. Verify this during real state changes, not only static refreshes.

### F17 · P2 · Settings leaves covered actions keyboard-active

[popup.js:643](/Users/ddomb/pull-deck/src/popup.js:643), [popup.js:800](/Users/ddomb/pull-deck/src/popup.js:800), [popup.html:114](/Users/ddomb/pull-deck/src/popup.html:114)

Opening Settings visually covers the list/dock without making those controls inert. The global Open All shortcut also runs before the settings guard.

**Evidence:** actual generated popup in the in-app browser: open Settings → Back receives focus → Shift-Tab focuses the covered “Open 5” button → Enter starts “Opening 0 of 5…” while Settings is still open. The preview uses a fake transport, so this opened no real tabs.

**Fix:** give the settings view exclusive keyboard/accessibility ownership while open. Make the covered view inert/hidden as appropriate, restore focus on close, and apply view guards before global action shortcuts.

### F18 · P2 · Chrome 99 support is incompatible with the shipped CSS

[manifest.json:6](/Users/ddomb/pull-deck/manifest.json:6), [popup.css:10](/Users/ddomb/pull-deck/src/popup.css:10)

The manifest permits Chrome 99 while the theme uses `oklch()` and `color-mix()` without compatible fallback values. They require Chrome 111. On 99–110, color declarations used for surfaces, controls, and semantic states are invalid.

**Evidence:** current CSS plus official [OKLCH support](https://developer.chrome.com/docs/css-ui/access-colors-spaces#oklch) and [color-mix support](https://developer.chrome.com/docs/css-ui/css-color-mix). Older Chrome was not executed.

**Fix:** raise and verify the supported minimum across manifest and README, or provide tested fallback styling. Check all other used APIs against the selected floor too.

### F22 · P3 · Accessible row names omit review/check status

[popup.js:140](/Users/ddomb/pull-deck/src/popup.js:140), [popup.js:166](/Users/ddomb/pull-deck/src/popup.js:166), [resolve-page.js:65](/Users/ddomb/pull-deck/src/resolve-page.js:65)

Explicit button labels name the PR and grouping state but omit draft/review/check badges. The button's accessible name therefore omits information shown visually. Marking a row grouped also leaves its existing label unchanged.

**Evidence:** source and browser accessibility tree: labels omit status while child badge text exists separately. Actual screen-reader speech was not tested.

**Fix:** derive an accessible name/description from the same status model, and update it alongside grouping state.

## Contributor and build defects

### F19 · P2 · The documented macOS test command fails on a clean checkout

[package.json:12](/Users/ddomb/pull-deck/package.json:12), [relay-roundtrip.mjs:20](/Users/ddomb/pull-deck/macos/tools/relay-roundtrip.mjs:20)

`mac:test` runs `swift run pulldeck-selftest`, then expects `.build/debug/pulldeck-bridge`. Building the self-test product does not build the relay product. A release app build also does not satisfy that debug-path dependency.

**Evidence:** in an empty scratch directory, the self-test passed but no relay existed; the next command exited 1 with `relay binary missing`. Explicit full `swift build` created it, after which all six relay checks passed.

**Fix:** explicitly build the tested relay and resolve its configuration/bin path before invoking it. Run the advertised command from a clean checkout in CI.

### F20 · P2 · Valid checkout paths generate malformed app metadata

[build-app.sh:53](/Users/ddomb/pull-deck/macos/build-app.sh:53)

The build script interpolates the checkout path directly into XML. A folder such as `Projects & Tools/pull-deck` produces invalid `Info.plist`. Signing failure is then swallowed and the script still prints that the app was built.

**Evidence:** parsed the actual plist heredoc with a normal path and with an ampersand-containing path: the first parsed; the second raised an XML parse error.

**Fix:** generate the plist with a serializer, validate it, and fail the build when required assembly/signing checks fail.

### F21 · P2 · Regenerating the extension key breaks native authorization

[make-extension-key.mjs:54](/Users/ddomb/pull-deck/tools/make-extension-key.mjs:54), [HostInstaller.swift:13](/Users/ddomb/pull-deck/macos/Sources/PullDeckKit/HostInstaller.swift:13)

The README documents `make-extension-key.mjs --force`, but that tool updates only the manifest key and signing key. Swift retains the old hardcoded extension ID. Rebuilding/reinstalling hosts continues authorizing the old ID, so the documented regeneration workflow cannot repair the bridge.

**Evidence:** traced every identity producer/consumer; the generator has no Swift/config update. No real signing identity was changed during review.

**Fix:** derive/generate native identity from the authoritative manifest key, or make key rotation update every consumer atomically. Add an identity-consistency check to the build.

## Open-source release readiness

These are release requirements and contributor improvements, separate from code-bug severity.

1. **Choose and include an open-source license.** No license file or license declaration is tracked. Publishing source is not sufficient to grant the intended reuse rights; see [GitHub's licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository). The owner must choose the intended terms.
2. **Make the first install reproducible.** Replace the author's absolute path in [README.md:20](/Users/ddomb/pull-deck/README.md:20), state Node/Swift/OS/browser prerequisites, and distinguish installing the extension from developing/testing the native app. Validate instructions in a fresh clone/profile before announcing support.
3. **Add CI and a contributor contract.** No CI workflow, CONTRIBUTING, or SECURITY document is tracked. At minimum automate Node tests, native build/relay checks from scratch, and the critical regressions above. Add a small lint/static-check configuration and document its exact command. Provide a private reporting route for token/privacy issues.
4. **Define a release artifact and version process.** Manifest is `1.3.0`; package and app bundle are `1.0.0`. Either intentionally version components with a compatibility policy or derive a common release version. Define extension packaging and the macOS distribution path; the current ad-hoc local app build is not a verified downloadable release process.
5. **Correct externally visible claims.** Fix the off-network shortcut assertion (F08), Chrome floor (F18), token-clear guarantee (F03), and README's “full permission list,” which omits `nativeMessaging`. Update BRIDGE.md's “app never polls” assertion and document the 50-result cap where users see counts. The query does not request page information to tell users when a list is truncated.

## Code structure: what would improve review quality

The existing separation between GitHub access, state, tab identity/grouping, UI, and transport is useful. PR titles are inserted through `textContent`; SVG insertion uses authored icon constants. The absence of a large runtime dependency tree is reasonable for this product. A framework rewrite would not address the reproduced bugs by itself.

The structural work should follow the defects:

| Area | Evidence of the problem | Focused improvement |
| --- | --- | --- |
| Refresh/auth ownership | Direct fetches in `loadState`, connect, resolver, and alarm; no shared in-flight/generation policy | One coordinator owns authentication generation, request deduplication, deadlines, cache commit, and stale status. |
| Tab operation lifecycle | Independent callers, optimistic progress, exceptions/no-op paths without terminal events | One serialized operation API returns a typed final outcome and progress tied to an operation ID. |
| Native connection and operation state | Separate `progress`, `isOpening`, `isAttached`, and dropped uncorrelated replies can disagree | Explicit connection/command states with cancellation on detach and a defined active browser/profile. |
| Cross-language contract | Reply schema assumes one payload; extension identity is duplicated; native grouping suffix-matches keys without host | A small shared schema/fixture contract and generated identity; send canonical PR membership keys instead of re-deriving them. |
| Popup controller and tests | 838-line module mixes transport, polling, view state, rendering, keyboard handling, and mutations; existing tests bypass interactions | Separate action/view state from DOM updates, introduce checked message/data types, and test actual UI transitions. |

The native suffix-only grouping check in [BridgeServer.swift:268](/Users/ddomb/pull-deck/macos/Sources/PullDeckApp/BridgeServer.swift:268) is a concrete example of contract duplication: an existing tab on another host with the same repository/PR suffix can be mistaken for the GitHub.com PR. Carrying canonical per-PR keys from the extension avoids that discrepancy without adding Enterprise Server support.

Long comments repeatedly assert invariants that executable paths do not uphold: strict matching, universal throttling, confirmed focus before closing, and no network leakage. Keep comments that explain constraints, but convert these claims into cross-module regression checks. Length and visual polish are not substitutes for verified behavior.

## Performance assessment

The confirmed performance defect is overlapping/repeated GitHub requests (F06–F07). Five-second polling has no in-flight guard, and the failure path does not establish a cooldown. This deserves priority over small array optimizations.

The current row invalidation also does unnecessary work and loses focus (F16). Keyed updates and more precise invalidation would improve both performance and usability.

Native group membership repeatedly rebuilds/scans sets during rendering, and host reconciliation walks profile directories every five seconds even while attached. These are secondary optimization candidates, not measured CPU/battery regressions. Cache a membership set per received state and avoid redundant installer work where practical; measure before adding a complex cache. The present 50-per-scope cap keeps ordinary collection sizes small.

## Suggested implementation order

1. **Protect identity, privacy, and process survival:** F01–F04, with failing regression tests for each reproduced scenario.
2. **Unify refresh and tab-operation ownership:** F06–F07, F09–F12; route every entry point through those boundaries.
3. **Repair the native protocol/session lifecycle:** F13–F15, including actual JS-to-Swift fixtures and disconnect/two-client tests.
4. **Repair chooser/accessibility and portability:** F05, F16–F22; test keyboard interaction, supported Chrome, clean builds, unusual checkout paths, and identity regeneration.
5. **Prepare the public release:** choose the license, add CI/contribution/security instructions, verify a fresh install, and publish versioned artifacts with accurate permissions and limitations.

Next concrete step: turn F01's two wrong-ticket examples into failing `findMatches()` regression tests before changing matching behavior.
