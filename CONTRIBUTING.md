# Contributing

Run `npm ci`, then `npm run check` and `npm test` before changing code. Node 22.13+ is required; use the latest Node 22 patch release. The shipped extension has no runtime npm dependencies.

## Working on a change

1. Reproduce the behavior with a test at the boundary where it fails. Concurrent callers, navigation changes, and disconnects require integration tests.
2. Keep the change focused and add its regression coverage. Use `npm run format` for JavaScript formatting.
3. Run `npm run check` and `npm test`. For native changes, run `npm run mac:test` and `npm run mac:build` on macOS with Swift 5.9+.
4. Describe the concrete before/after behavior, verification, and remaining limits in the pull request.

## Boundaries to preserve

- `refresh.js` owns network refreshes, authentication generations, cache commits, and cooldowns. New callers use it through `app-state.js`.
- `app-state.js` serializes tab operations. Progress belongs to one operation; terminal replies must settle success, failure, cancellation, and no-op outcomes.
- UI modules render data and send commands. Treat PR titles and branch names as text. Preserve focused PR identity during live updates.
- `bridge-protocol.js` and `manifest.json` define shared protocol/identity/release metadata. Run `npm run generate` when changing them. Swift and browser identities must agree.
- Native connection objects own descriptor lifetime; shutdown cancels pending commands. Keep tests away from installed hosts, real browser profiles, and the live app. Temporary fixtures belong under the repository's `.claude/tmp/` directory.

The Node tests cover API errors, shared refresh/auth races, serialized tab operations, declarative shortcut rules, and DOM interactions. `mac:test` builds every required product, runs protocol/framing/installer tests, runs the actual native server in an isolated directory, and verifies the relay over real framed pipes.

Use `npm run preview` to inspect the popup and resolver with synthetic data. This preview is not a substitute for testing the packaged extension in a separate browser profile.

Report security issues as described in SECURITY.md. Never include real tokens, private PR data, browser preference files, or signing keys in an issue or test fixture.
