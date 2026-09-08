# Releasing Pull Deck

Prepare artifacts with `npm ci`, `npm run test:all`, `npm run mac:build`, and `npm run package` on macOS. These commands build locally; they do not publish, install hosts, or start the companion.

## Release checks

1. Set the release version in both `manifest.json` and `package.json`. Run `npm run generate`; the generated Swift version, extension identity, and redirect rules must be current.
2. Review the license choice and release notes. Enable GitHub private vulnerability reporting. Verify the repository's CI jobs passed from a clean checkout.
3. Unzip `dist/pull-deck-VERSION.zip` into a new folder and load it in a separate Chromium profile. Connect a test token, check all scopes, keyboard settings navigation, and concurrent opens. Verify one shortcut match, a partial ticket miss, and stale/error behavior. Use only sanitized test repositories.
4. Build and open the matching companion from that checkout. Test disconnect/reconnect and a second browser profile; the second must explain that another profile is active. Remove test hosts/profile data after the smoke test.
5. Publish only the reviewed artifacts. The local app is ad-hoc signed for building from source. Downloadable macOS binaries require a separate Developer ID signing/notarization process; that distribution path is not configured here.

`manifest.json` is the source for the native app's bundle version. `bridge-protocol.js` defines wire protocol compatibility. Release 1.4 uses protocol 2; older app binaries must be rebuilt when upgrading the extension.

The extension package contains only the manifest, rules, runtime source, icons, README, and license. It contains no token, signing private key, `.git`, `.claude`, `node_modules`, or native build output. Keep Chrome Web Store metadata/privacy disclosures synchronized with README and SECURITY.md.

Regenerating the extension key is an identity change. `node tools/make-extension-key.mjs --force` updates the dependent rules and Swift identity too. Rebuild the app and reload the extension; installed native manifests are repaired on app launch. Public distribution should retain its established signing identity.
