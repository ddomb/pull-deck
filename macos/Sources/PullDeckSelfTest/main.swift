import Foundation
import PullDeckKit

// Assertions for the two things on the Swift side that fail silently:
// the native messaging framing, and decoding the extension's state.
//
// Run with: swift run pulldeck-selftest

var failures = 0
var checks = 0

func check(_ name: String, _ passed: Bool, _ detail: @autoclosure () -> String = "") {
    checks += 1
    if passed {
        print("ok \(checks) - \(name)")
    } else {
        failures += 1
        let extra = detail()
        print("not ok \(checks) - \(name)\(extra.isEmpty ? "" : "  # \(extra)")")
    }
}

func checkThrows(_ name: String, _ body: () throws -> Void) {
    do {
        try body()
        check(name, false, "expected a throw, got none")
    } catch {
        check(name, true)
    }
}

// MARK: - Framing

// Get the header wrong and Chrome reads every subsequent length from the wrong
// offset: the channel dies with no error anywhere.
do {
    let payload = Data(#"{"a":1}"#.utf8)  // 7 bytes
    let framed = try NativeMessaging.frame(payload)
    check("frame is 4-byte header + payload", framed.count == 4 + payload.count)
    check("payload survives framing", Array(framed.suffix(payload.count)) == Array(payload))
    // "preceded with 32-bit message length in native byte order"
    check(
        "header is little-endian on macOS", Array(framed.prefix(4)) == [7, 0, 0, 0],
        "got \(Array(framed.prefix(4)))")

    var allRoundTrip = true
    for length in [1, 2, 255, 256, 65_535, 1_000_000] {
        let f = try NativeMessaging.frame(Data(repeating: 0x20, count: length))
        if try NativeMessaging.payloadLength(header: Data(f.prefix(4))) != length {
            allRoundTrip = false
        }
    }
    check("header lengths round-trip", allRoundTrip)

    check(
        "documented caps are encoded",
        NativeMessaging.maxToExtension == 1_024 * 1_024
            && NativeMessaging.maxFromExtension == 64 * 1_024 * 1_024)

    checkThrows("empty messages are rejected") { _ = try NativeMessaging.frame(Data()) }
    checkThrows("payloads over Chrome's 1 MB host cap are rejected") {
        _ = try NativeMessaging.frame(
            Data(repeating: 0x20, count: NativeMessaging.maxToExtension + 1))
    }
    checkThrows("a truncated header is rejected") {
        _ = try NativeMessaging.payloadLength(header: Data([1, 2, 3]))
    }

    // Several whole messages in one buffer.
    var buffer = Data()
    for i in 1...3 { buffer.append(try NativeMessaging.frame(Data(#"{"n":\#(i)}"#.utf8))) }
    let many = try NativeMessaging.drain(buffer: &buffer)
    check("drains several whole messages", many.count == 3, "got \(many.count)")
    check("drained payloads are intact", String(data: many[1], encoding: .utf8) == #"{"n":2}"#)
    check("buffer is emptied", buffer.isEmpty)

    // Chrome's pipe delivers arbitrary chunks; a message can straddle reads.
    let whole = try NativeMessaging.frame(Data(#"{"hello":"world"}"#.utf8))
    var split = Data(whole.prefix(6))
    check("a partial message is not emitted", try NativeMessaging.drain(buffer: &split).isEmpty)
    check("and its bytes are kept", split.count == 6)
    split.append(whole.suffix(from: 6))
    let completed = try NativeMessaging.drain(buffer: &split)
    check("the message arrives once whole", completed.count == 1)
    check(
        "reassembled intact", String(data: completed[0], encoding: .utf8) == #"{"hello":"world"}"#)
    check("nothing left over", split.isEmpty)

    var trailing = try NativeMessaging.frame(Data(#"{"a":1}"#.utf8))
    trailing.append(try NativeMessaging.frame(Data(#"{"b":2}"#.utf8)).prefix(5))
    let first = try NativeMessaging.drain(buffer: &trailing)
    check("a trailing partial survives the drain", first.count == 1 && trailing.count == 5)

    checkThrows("an absurd length fails loudly rather than desynchronising") {
        var garbage = Data([0xFF, 0xFF, 0xFF, 0xFF])
        garbage.append(Data(repeating: 0, count: 8))
        _ = try NativeMessaging.drain(buffer: &garbage)
    }
} catch {
    check("framing suite ran", false, "threw \(error)")
}

// MARK: - Protocol

func decode(_ json: String) -> InboundMessage? { InboundMessage.decode(Data(json.utf8)) }

if case .hello(let version, let id)? = decode(#"{"type":"hello","version":1,"extensionId":"abc"}"#)
{
    check("decodes hello", version == 1 && id == "abc")
} else {
    check("decodes hello", false)
}

let listJSON = """
    {"type":"state","state":{
      "stage":"list",
      "settings":{"groupTitle":"Pull Requests","groupColor":"cyan","badgeEnabled":true,
                  "hasToken":true,"tokenTail":"9f2c"},
      "viewer":{"login":"ddomb","avatarUrl":null},
      "scopes":{"mine":[{"id":"pr1","number":4120,"title":"Fix it","url":"https://github.com/a/b/pull/4120",
                         "repo":"a/b","isDraft":false,"updatedAt":"2026-07-28T10:00:00Z",
                         "additions":10,"deletions":2,"reviewDecision":"APPROVED","checks":"SUCCESS"}],
                "reviewing":[],"assigned":[]},
      "group":{"groupId":42,"keys":["github.com/a/b#4120"],"otherWindow":false},
      "fetchedAt":1234567890,"error":null}}
    """
if case .state(let state)? = decode(listJSON) {
    check("decodes a full list state", state.isList)
    check("decodes the viewer", state.viewer?.login == "ddomb")
    check("decodes pull requests", state.scopes?.mine.count == 1)
    check("decodes review decision", state.scopes?.mine.first?.reviewDecision == "APPROVED")
    check("decodes settings", state.settings?.groupTitle == "Pull Requests")
    check("decodes group keys", state.group?.keys == ["github.com/a/b#4120"])
} else {
    check("decodes a full list state", false)
}

if case .state(let state)? = decode(
    #"{"type":"state","state":{"stage":"onboarding","settings":{"groupTitle":"Pull Requests","groupColor":"cyan","badgeEnabled":true,"hasToken":false,"tokenTail":""}}}"#
) {
    check("onboarding state decodes with fields absent", state.needsToken && state.scopes == nil)
} else {
    check("onboarding state decodes with fields absent", false)
}

// The envelope owns `type`; the event's discriminator must be `kind` or the
// spread that wraps it destroys the envelope.
if case .progress(let event)? = decode(
    #"{"type":"progress","kind":"tab","done":2,"total":5,"id":"pr7","ok":true}"#
) {
    check(
        "decodes progress with a string pr id",
        event.kind == "tab" && event.done == 2 && event.total == 5 && event.id == "pr7"
            && event.ok == true)
} else {
    check("decodes progress with a string pr id", false)
}

if case .reply(let id, let ok, let result, _)? = decode(
    #"{"type":"reply","id":9,"ok":true,"data":{"created":3,"adopted":1,"skipped":2,"groupId":42,"movedWindow":false}}"#
) {
    check(
        "decodes a successful reply",
        id == 9 && ok && result?.openResult?.created == 3 && result?.openResult?.adopted == 1)
} else {
    check("decodes a successful reply", false)
}

if case .reply(_, let ok, _, let error)? = decode(
    #"{"type":"reply","id":4,"ok":false,"error":{"kind":"badToken","message":"nope","retryAt":null}}"#
) {
    check("decodes a failed reply", !ok && error?.kind == "badToken")
} else {
    check("decodes a failed reply", false)
}

if case .unknown(let type)? = decode(#"{"type":"somethingNewer"}"#) {
    check("a newer extension does not break an older app", type == "somethingNewer")
} else {
    check("a newer extension does not break an older app", false)
}

check("garbage decodes to nil", decode("not json") == nil && decode(#"{"noType":true}"#) == nil)

do {
    let json = String(
        data: try OutboundCommand.openAll(id: 3, scope: .reviewing).encoded(), encoding: .utf8)!
    check(
        "openAll names a scope",
        json.contains(#""scope":"reviewing""#) && json.contains(#""type":"openAll""#))
    check("the app never constructs a GitHub URL", !json.contains("http"), json)

    let patch = String(
        data: try OutboundCommand.settings(id: 1, patch: SettingsPatch(groupColor: "purple"))
            .encoded(),
        encoding: .utf8
    )!
    check(
        "a settings patch omits absent keys",
        patch.contains(#""groupColor":"purple""#) && !patch.contains("groupTitle")
            && !patch.contains("badgeEnabled"),
        patch)
} catch {
    check("outbound commands encode", false, "threw \(error)")
}

check(
    "scope wire names match the extension",
    Scope.allCases.map(\.rawValue) == ["mine", "reviewing", "assigned"])

let samplePR = PullRequest(
    id: "pr1", number: 1, title: "t", url: "u", repo: "r", isDraft: false,
    updatedAt: "", additions: 0, deletions: 0, reviewDecision: nil, checks: nil
)
check(
    "scopes subscript matches wire names",
    Scopes(mine: [samplePR], reviewing: [], assigned: [])[.mine].count == 1)

// MARK: - Host installer, against a real profile tree on disk

do {
    let fm = FileManager.default
    let root = URL(
        fileURLWithPath: ProcessInfo.processInfo.environment["PULLDECK_TEST_ROOT"]
            ?? NSTemporaryDirectory()
    )
    .appendingPathComponent("pulldeck-installer-\(ProcessInfo.processInfo.processIdentifier)")
    defer { try? fm.removeItem(at: root) }

    /// Writes a profile whose Secure Preferences may or may not list our id,
    /// plus the "Local State" file Chromium puts at the user data root.
    func makeProfile(
        _ browser: String, profile: String, loaded: Bool,
        marker: Bool = true, legacyID: String? = nil, sourcePath: String = "/Users/ddomb/pull-deck"
    ) throws {
        let userData = root.appendingPathComponent(browser)
        let dir = userData.appendingPathComponent(profile)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        if marker {
            try Data("{}".utf8).write(to: userData.appendingPathComponent("Local State"))
        }
        var settings: [String: Any] = ["someotherextensionidaaaaaaaaaaaa": ["path": "/tmp/other"]]
        if loaded {
            settings[HostInstaller.extensionID] = ["path": sourcePath, "state": 1]
        }
        if let legacyID {
            // Same folder, different id: loaded before the id was pinned.
            settings[legacyID] = ["path": sourcePath, "state": 1]
        }
        let payload: [String: Any] = ["extensions": ["settings": settings]]
        // Extensions live in "Secure Preferences", not "Preferences".
        try JSONSerialization.data(withJSONObject: payload)
            .write(to: dir.appendingPathComponent("Secure Preferences"))
    }

    try makeProfile("Google/Chrome", profile: "Default", loaded: false)
    try makeProfile("Google/Chrome", profile: "Profile 6", loaded: true)
    try makeProfile("Microsoft Edge", profile: "Default", loaded: false)
    try makeProfile("Vivaldi", profile: "Default", loaded: false)
    // A fork nobody hard-codes: reverse-DNS directory, straight under the root.
    try makeProfile("net.imput.helium", profile: "Default", loaded: true)
    // A fork that nests its profiles one level further down.
    try makeProfile("Dia/User Data", profile: "Default", loaded: false)
    // Looks like a profile tree but has no Local State: not a browser.
    try makeProfile("SomeOtherApp", profile: "Default", loaded: true, marker: false)

    let browsers = HostInstaller.discover(root: root)
    check(
        "discovers browsers by shape, not by a hard-coded name list",
        browsers.count == 5, browsers.map(\.name).joined(separator: ","))
    check(
        "finds a reverse-DNS fork like Helium", browsers.contains { $0.name == "Helium" },
        browsers.map(\.name).joined(separator: ","))
    check(
        "unwraps a User Data directory to its browser name",
        browsers.contains { $0.name == "Dia" })
    check(
        "ignores a directory with no Local State marker",
        !browsers.contains { $0.name == "SomeOtherApp" })
    // Names come from the directory now, so it is "Microsoft Edge" rather than
    // the "Edge" a lookup table used to supply.
    check(
        "discovers them by name",
        Set(browsers.map(\.name)) == Set(["Chrome", "Microsoft Edge", "Vivaldi", "Helium", "Dia"]),
        browsers.map(\.name).joined(separator: ","))

    guard let chrome = browsers.first(where: { $0.name == "Chrome" }),
        let edge = browsers.first(where: { $0.name == "Microsoft Edge" })
    else {
        check(
            "fixture browsers were discovered", false, browsers.map(\.name).joined(separator: ","))
        throw NSError(domain: "selftest", code: 1)
    }
    check(
        "finds the extension in a non-default profile", HostInstaller.isExtensionLoaded(in: chrome))
    check("and does not invent it where it is absent", !HostInstaller.isExtensionLoaded(in: edge))

    let relay = "/Applications/Pull Deck.app/Contents/MacOS/pulldeck-bridge"
    var result = HostInstaller.reconcile(relayPath: relay, root: root)

    check(
        "installs into every browser that has it, and no others",
        result.filter(\.manifestPresent).map(\.browser.name) == ["Chrome", "Helium"],
        result.filter(\.manifestPresent).map(\.browser.name).joined(separator: ","))
    check("and reports them ready", result.filter(\.ready).count == 2)

    let written = HostInstaller.readManifest(at: chrome.manifestURL)
    check("manifest names the relay absolutely", written?["path"] as? String == relay)
    check(
        "manifest allows exactly the pinned id",
        (written?["allowed_origins"] as? [String]) == [
            "chrome-extension://\(HostInstaller.extensionID)/"
        ])
    check("manifest type is stdio", written?["type"] as? String == "stdio")

    // Moving the app must self-heal rather than silently break.
    let moved = "/Users/ddomb/Applications/Pull Deck.app/Contents/MacOS/pulldeck-bridge"
    result = HostInstaller.reconcile(relayPath: moved, root: root)
    check(
        "a moved app rewrites the stale path",
        HostInstaller.readManifest(at: chrome.manifestURL)?["path"] as? String == moved)
    check("and is ready again", result.first { $0.browser.name == "Chrome" }?.ready == true)

    // Reconcile is idempotent.
    let before = try Data(contentsOf: chrome.manifestURL)
    _ = HostInstaller.reconcile(relayPath: moved, root: root)
    check("reconcile is idempotent", try Data(contentsOf: chrome.manifestURL) == before)

    // Remove the extension from Chrome only: that manifest is now stale, while
    // Helium still has it and must be left alone.
    try makeProfile("Google/Chrome", profile: "Profile 6", loaded: false)
    result = HostInstaller.reconcile(relayPath: moved, root: root)
    check(
        "removes a manifest once the extension is gone from that browser",
        !fm.fileExists(atPath: chrome.manifestURL.path))
    check(
        "but leaves the browser that still has it alone",
        result.first { $0.browser.name == "Helium" }?.ready == true)

    // The exact trap: loaded from our folder, but under a pre-pinning id.
    // Chromium keeps whatever id an extension had when it was loaded, so
    // editing manifest.json does not move it. Detected and named, or the
    // symptom is simply that nothing ever connects.
    let source = "/Users/ddomb/pull-deck"
    try makeProfile(
        "Vivaldi", profile: "Default", loaded: false,
        legacyID: "ookeaeknjkeleihdkgfmomjlfmbfglek", sourcePath: source)
    let vivaldi = HostInstaller.discover(root: root).first { $0.name == "Vivaldi" }!
    let finding = HostInstaller.find(in: vivaldi, extensionPath: source)

    check(
        "spots the extension loaded under a pre-pinning id",
        finding.legacyID == "ookeaeknjkeleihdkgfmomjlfmbfglek", finding.legacyID ?? "nil")
    check("and does not mistake it for being properly loaded", !finding.pinned)

    let withLegacy = HostInstaller.status(relayPath: moved, root: root, extensionPath: source)
        .first { $0.browser.name == "Vivaldi" }
    check("reports it as needing a reload", withLegacy?.needsReload == true)

    // A different unpacked extension must not be mistaken for ours.
    try makeProfile(
        "Dia/User Data", profile: "Default", loaded: false,
        legacyID: "unrelatedextensionidbbbbbbbbbbbb", sourcePath: "/somewhere/else")
    let dia = HostInstaller.discover(root: root).first { $0.name == "Dia" }!
    check(
        "ignores unpacked extensions from other folders",
        HostInstaller.find(in: dia, extensionPath: source).legacyID == nil)
} catch {
    check("host installer suite ran", false, "threw \(error)")
}

// MARK: - Summary

print("1..\(checks)")
if failures > 0 {
    print("# \(failures) of \(checks) failed")
    exit(1)
}
print("# all \(checks) passed")
