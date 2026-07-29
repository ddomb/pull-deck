import Foundation

/// Finds Chromium-family browsers, works out where Pull Deck is loaded, and
/// keeps the native messaging host manifest correct in those browsers.
///
/// This exists because the manual version has three silent failure modes, all
/// of which look identical from the outside ("Chrome not connected"):
/// the repo moves and the extension id changes; the app moves and the relay
/// path goes stale; the manifest lands in a browser you don't actually use.
public enum HostInstaller {
    /// Pinned by the `key` field in manifest.json, so it no longer depends on
    /// where the repo lives. Regenerate with tools/make-extension-key.mjs.
    public static let extensionID = "jdpikjmmmljjpkmfmhgildnaihbpmfpj"
    public static let hostName = "com.pulldeck.bridge"

    /// Relative to ~/Library/Application Support. Each is checked both directly
    /// and with a "User Data" suffix, which is where some forks keep profiles.
    static let knownBrowsers: [(name: String, path: String)] = [
        ("Chrome", "Google/Chrome"),
        ("Chrome Beta", "Google/Chrome Beta"),
        ("Chrome Canary", "Google/Chrome Canary"),
        ("Chrome Dev", "Google/Chrome Dev"),
        ("Chromium", "Chromium"),
        ("Edge", "Microsoft Edge"),
        ("Edge Beta", "Microsoft Edge Beta"),
        ("Edge Dev", "Microsoft Edge Dev"),
        ("Edge Canary", "Microsoft Edge Canary"),
        ("Brave", "BraveSoftware/Brave-Browser"),
        ("Brave Beta", "BraveSoftware/Brave-Browser-Beta"),
        ("Brave Nightly", "BraveSoftware/Brave-Browser-Nightly"),
        ("Vivaldi", "Vivaldi"),
        ("Arc", "Arc"),
        ("Opera", "com.operasoftware.Opera"),
    ]

    public struct Browser: Hashable, Identifiable {
        public let name: String
        public let userDataDir: URL
        public var id: String { userDataDir.path }

        public var hostDirectory: URL {
            userDataDir.appendingPathComponent("NativeMessagingHosts", isDirectory: true)
        }
        public var manifestURL: URL {
            hostDirectory.appendingPathComponent("\(HostInstaller.hostName).json")
        }
    }

    public struct Status: Identifiable {
        public let browser: Browser
        public let extensionLoaded: Bool
        public let manifestPresent: Bool
        /// Present *and* pointing at this exact relay with this exact extension.
        public let manifestCorrect: Bool

        public var id: String { browser.id }
        public var needsInstall: Bool { extensionLoaded && !manifestCorrect }
        public var ready: Bool { extensionLoaded && manifestCorrect }
        /// A manifest we wrote for a browser that no longer has the extension.
        public var stale: Bool { !extensionLoaded && manifestPresent }
    }

    // MARK: - Discovery

    static var supportRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
    }

    /// Every Chromium-family browser with at least one profile on this Mac.
    public static func discover(root: URL? = nil) -> [Browser] {
        let base = root ?? supportRoot
        var found: [Browser] = []
        for candidate in knownBrowsers {
            for suffix in ["", "User Data"] {
                var dir = base.appendingPathComponent(candidate.path, isDirectory: true)
                if !suffix.isEmpty { dir = dir.appendingPathComponent(suffix, isDirectory: true) }
                guard !profiles(in: dir).isEmpty else { continue }
                found.append(Browser(name: candidate.name, userDataDir: dir))
                break // a browser keeps its profiles in one place, not both
            }
        }
        return found
    }

    /// Profile preference files. Extensions are recorded in "Secure
    /// Preferences", not "Preferences" — the latter is empty of them on a
    /// modern Chrome, which is exactly the trap that makes hand-rolled
    /// detection silently report "not loaded".
    static func profiles(in userDataDir: URL) -> [URL] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: userDataDir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        ) else { return [] }

        var files: [URL] = []
        for entry in entries {
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
            for name in ["Secure Preferences", "Preferences"] {
                let file = entry.appendingPathComponent(name)
                if fm.fileExists(atPath: file.path) { files.append(file) }
            }
        }
        return files
    }

    // MARK: - Detection

    /// Is our extension loaded in this browser, in any profile?
    public static func isExtensionLoaded(in browser: Browser, id: String = extensionID) -> Bool {
        let needle = Data(id.utf8)
        for file in profiles(in: browser.userDataDir) {
            // Substring pre-filter first: these files run to several megabytes
            // and parsing every one of them on every scan is wasteful.
            guard let data = try? Data(contentsOf: file, options: .mappedIfSafe),
                  data.range(of: needle) != nil else { continue }
            guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let extensions = root["extensions"] as? [String: Any],
                  let settings = extensions["settings"] as? [String: Any]
            else { continue }
            if settings[id] != nil { return true }
        }
        return false
    }

    public static func status(relayPath: String, root: URL? = nil) -> [Status] {
        discover(root: root).map { browser in
            let loaded = isExtensionLoaded(in: browser)
            let manifest = readManifest(at: browser.manifestURL)
            let correct = manifest?["path"] as? String == relayPath
                && (manifest?["allowed_origins"] as? [String])?
                    .contains("chrome-extension://\(extensionID)/") == true
            return Status(
                browser: browser,
                extensionLoaded: loaded,
                manifestPresent: manifest != nil,
                manifestCorrect: correct
            )
        }
    }

    public static func readManifest(at url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    // MARK: - Install

    @discardableResult
    public static func install(into browser: Browser, relayPath: String) throws -> URL {
        let manifest: [String: Any] = [
            "name": hostName,
            "description": "Pull Deck bridge between the Chrome extension and the macOS menu bar app",
            // Must be absolute on macOS.
            "path": relayPath,
            "type": "stdio",
            // The only gate Chrome enforces on who may launch the relay.
            "allowed_origins": ["chrome-extension://\(extensionID)/"],
        ]
        try FileManager.default.createDirectory(
            at: browser.hostDirectory, withIntermediateDirectories: true
        )
        let data = try JSONSerialization.data(
            withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        )
        try data.write(to: browser.manifestURL, options: .atomic)
        return browser.manifestURL
    }

    public static func uninstall(from browser: Browser) throws {
        try? FileManager.default.removeItem(at: browser.manifestURL)
    }

    /// Bring every browser into the right state: install where the extension
    /// lives, remove manifests we left behind where it no longer does.
    /// Idempotent, and cheap enough to run on every launch.
    @discardableResult
    public static func reconcile(relayPath: String, root: URL? = nil) -> [Status] {
        for entry in status(relayPath: relayPath, root: root) {
            if entry.needsInstall {
                try? install(into: entry.browser, relayPath: relayPath)
            } else if entry.stale {
                try? uninstall(from: entry.browser)
            }
        }
        return status(relayPath: relayPath, root: root)
    }

    /// The relay inside the running app's own bundle. Taking it from the bundle
    /// rather than a stored value is what makes moving the app self-healing.
    public static func relayPathInBundle(_ bundle: Bundle = .main) -> String? {
        let fm = FileManager.default
        let inBundle = bundle.bundleURL.appendingPathComponent("Contents/MacOS/pulldeck-bridge")
        if fm.isExecutableFile(atPath: inBundle.path) { return inBundle.path }
        // `swift run` has no .app around it; fall back to a sibling of the
        // running executable so the app is debuggable outside a bundle.
        let sibling = URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent()
            .appendingPathComponent("pulldeck-bridge")
        return fm.isExecutableFile(atPath: sibling.path) ? sibling.path : nil
    }

    /// Where the extension lives on disk, baked in at build time so the app can
    /// reveal it in Finder. The app cannot otherwise know where it was cloned.
    public static func extensionSourcePath(_ bundle: Bundle = .main) -> String? {
        bundle.object(forInfoDictionaryKey: "PDExtensionPath") as? String
    }
}
