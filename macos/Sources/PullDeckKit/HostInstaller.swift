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

    /// Chromium writes this file at the root of every user data directory. It
    /// is the only reliable marker of "a Chromium-family browser lives here".
    ///
    /// Deliberately not a list of known browser names. A hard-coded list cannot
    /// know about Helium (`net.imput.helium`), Dia, or whatever ships next, and
    /// the failure mode is silent: the extension loads fine and the bridge is
    /// simply never installed.
    static let userDataMarker = "Local State"

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
        /// Set when Pull Deck is loaded here but under a pre-pinning id, which
        /// a reload fixes.
        public let legacyID: String?

        public var id: String { browser.id }
        public var needsReload: Bool { !extensionLoaded && legacyID != nil }
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

    /// Every Chromium-family browser with at least one profile on this Mac,
    /// found by shape rather than by name.
    ///
    /// Two levels deep covers everything seen in the wild: `net.imput.helium`
    /// and `Microsoft Edge` sit directly under Application Support, while
    /// `Google/Chrome` and `Dia/User Data` are nested one further.
    public static func discover(root: URL? = nil) -> [Browser] {
        let base = root ?? supportRoot
        let fm = FileManager.default
        var found: [Browser] = []
        var seen = Set<String>()

        func consider(_ dir: URL) {
            guard !seen.contains(dir.path), isUserDataDirectory(dir) else { return }
            seen.insert(dir.path)
            found.append(Browser(name: displayName(for: dir), userDataDir: dir))
        }

        func children(of dir: URL) -> [URL] {
            (try? fm.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
            ))?.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true } ?? []
        }

        for entry in children(of: base) {
            consider(entry)
            // Only descend when the parent is not itself a user data directory;
            // a browser keeps its profiles in one place, not two.
            if !seen.contains(entry.path) {
                for sub in children(of: entry) { consider(sub) }
            }
        }
        return found.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func isUserDataDirectory(_ dir: URL) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(userDataMarker).path)
            && !profiles(in: dir).isEmpty
    }

    /// Turn a directory into something worth showing a human:
    /// `Google/Chrome` → Chrome, `Dia/User Data` → Dia, `net.imput.helium` → Helium.
    static func displayName(for dir: URL) -> String {
        var name = dir.lastPathComponent
        if name == "User Data" { name = dir.deletingLastPathComponent().lastPathComponent }
        // Reverse-DNS bundle identifiers are common for newer forks.
        if name.contains("."), !name.contains(" "), let last = name.split(separator: ".").last {
            name = last.capitalized
        }
        return name
    }

    /// Profile preference files. Extensions are recorded in "Secure
    /// Preferences", not "Preferences" — the latter is empty of them on a
    /// modern Chrome, which is exactly the trap that makes hand-rolled
    /// detection silently report "not loaded".
    public static func profiles(in userDataDir: URL) -> [URL] {
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

    // Preference files run to several megabytes and this is polled every few
    // seconds, so results are cached against the file's modification date.
    private static let cacheLock = NSLock()
    private static var loadedCache: [String: (stamp: String, finding: Finding)] = [:]

    public struct Finding {
        public var pinned = false
        /// Pull Deck loaded from our folder but under some *other* id — which
        /// means it was loaded before the id was pinned and has not been
        /// reloaded since. Chromium keeps an extension registered under
        /// whatever id it had at load time; editing manifest.json on disk does
        /// not retroactively change it. Without naming this, the symptom is
        /// simply that nothing ever connects.
        public var legacyID: String?
    }

    /// What this browser knows about Pull Deck, across all its profiles.
    public static func find(in browser: Browser, extensionPath: String? = nil) -> Finding {
        let path = extensionPath ?? extensionSourcePath()
        var result = Finding()
        for file in profiles(in: browser.userDataDir) {
            let finding = cachedFinding(for: file, extensionPath: path)
            if finding.pinned { return finding }
            if result.legacyID == nil { result.legacyID = finding.legacyID }
        }
        return result
    }

    public static func isExtensionLoaded(in browser: Browser) -> Bool {
        find(in: browser).pinned
    }

    private static func cachedFinding(for file: URL, extensionPath: String?) -> Finding {
        // Size as well as mtime: filesystem timestamps have one-second
        // resolution, and a preferences file can easily change twice inside
        // the same second.
        let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
        let stamp = attributes.map { attrs -> String in
            let date = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
            return "\(date)-\(size)-\(extensionPath ?? "")"
        }

        cacheLock.lock()
        let cached = loadedCache[file.path]
        cacheLock.unlock()
        if let cached, let stamp, cached.stamp == stamp { return cached.finding }

        let finding = scan(file: file, extensionPath: extensionPath)
        if let stamp {
            cacheLock.lock()
            loadedCache[file.path] = (stamp, finding)
            cacheLock.unlock()
        }
        return finding
    }

    private static func scan(file: URL, extensionPath: String?) -> Finding {
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return Finding() }

        // Two cheap substring scans before committing to a JSON parse of
        // several megabytes; a miss is by far the common case.
        //
        // The path probe deliberately uses only the last component. JSON
        // escapes forward slashes, so these files store "\/Users\/you\/pull-deck"
        // and a search for the plain path silently matches nothing — which made
        // the whole legacy-id check a no-op. A folder name has no slashes in it.
        let mentionsPinned = data.range(of: Data(extensionID.utf8)) != nil
        let folderName = extensionPath.map { URL(fileURLWithPath: $0).lastPathComponent }
        let mentionsFolder = folderName.map { !$0.isEmpty && data.range(of: Data($0.utf8)) != nil } ?? false
        guard mentionsPinned || mentionsFolder else { return Finding() }

        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let extensions = root["extensions"] as? [String: Any],
              let settings = extensions["settings"] as? [String: Any]
        else { return Finding() }

        var finding = Finding()
        if settings[extensionID] != nil { finding.pinned = true }
        if let extensionPath, !finding.pinned {
            let wanted = URL(fileURLWithPath: extensionPath).standardizedFileURL.path
            for (id, value) in settings where id != extensionID {
                guard let entry = value as? [String: Any],
                      let recorded = entry["path"] as? String, recorded.hasPrefix("/"),
                      URL(fileURLWithPath: recorded).standardizedFileURL.path == wanted
                else { continue }
                finding.legacyID = id
                break
            }
        }
        return finding
    }

    public static func status(
        relayPath: String, root: URL? = nil, extensionPath: String? = nil
    ) -> [Status] {
        let source = extensionPath ?? extensionSourcePath()
        return discover(root: root).map { browser in
            let finding = find(in: browser, extensionPath: source)
            let manifest = readManifest(at: browser.manifestURL)
            let correct = manifest?["path"] as? String == relayPath
                && (manifest?["allowed_origins"] as? [String])?
                    .contains("chrome-extension://\(extensionID)/") == true
            return Status(
                browser: browser,
                extensionLoaded: finding.pinned,
                manifestPresent: manifest != nil,
                manifestCorrect: correct,
                legacyID: finding.legacyID
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
    public static func reconcile(
        relayPath: String, root: URL? = nil, extensionPath: String? = nil
    ) -> [Status] {
        for entry in status(relayPath: relayPath, root: root, extensionPath: extensionPath) {
            if entry.needsInstall {
                try? install(into: entry.browser, relayPath: relayPath)
            } else if entry.stale && !entry.needsReload {
                // Keep the manifest while the extension is only waiting for a
                // reload; removing it would just have to be undone in a moment.
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
