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
    let payload = Data(#"{"a":1}"#.utf8) // 7 bytes
    let framed = try NativeMessaging.frame(payload)
    check("frame is 4-byte header + payload", framed.count == 4 + payload.count)
    check("payload survives framing", Array(framed.suffix(payload.count)) == Array(payload))
    // "preceded with 32-bit message length in native byte order"
    check("header is little-endian on macOS", Array(framed.prefix(4)) == [7, 0, 0, 0],
          "got \(Array(framed.prefix(4)))")

    var allRoundTrip = true
    for length in [1, 2, 255, 256, 65_535, 1_000_000] {
        let f = try NativeMessaging.frame(Data(repeating: 0x20, count: length))
        if try NativeMessaging.payloadLength(header: Data(f.prefix(4))) != length { allRoundTrip = false }
    }
    check("header lengths round-trip", allRoundTrip)

    check("documented caps are encoded",
          NativeMessaging.maxToExtension == 1_024 * 1_024
            && NativeMessaging.maxFromExtension == 64 * 1_024 * 1_024)

    checkThrows("empty messages are rejected") { _ = try NativeMessaging.frame(Data()) }
    checkThrows("payloads over Chrome's 1 MB host cap are rejected") {
        _ = try NativeMessaging.frame(Data(repeating: 0x20, count: NativeMessaging.maxToExtension + 1))
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
    check("reassembled intact", String(data: completed[0], encoding: .utf8) == #"{"hello":"world"}"#)
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

if case .hello(let version, let id)? = decode(#"{"type":"hello","version":1,"extensionId":"abc"}"#) {
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
    check("decodes progress with a string pr id",
          event.kind == "tab" && event.done == 2 && event.total == 5 && event.id == "pr7" && event.ok == true)
} else {
    check("decodes progress with a string pr id", false)
}

if case .reply(let id, let ok, let result, _)? = decode(
    #"{"type":"reply","id":9,"ok":true,"data":{"created":3,"adopted":1,"skipped":2,"groupId":42,"movedWindow":false}}"#
) {
    check("decodes a successful reply", id == 9 && ok && result?.created == 3 && result?.adopted == 1)
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
    let json = String(data: try OutboundCommand.openAll(id: 3, scope: .reviewing).encoded(), encoding: .utf8)!
    check("openAll names a scope", json.contains(#""scope":"reviewing""#) && json.contains(#""type":"openAll""#))
    check("the app never constructs a GitHub URL", !json.contains("http"), json)

    let patch = String(
        data: try OutboundCommand.settings(id: 1, patch: SettingsPatch(groupColor: "purple")).encoded(),
        encoding: .utf8
    )!
    check("a settings patch omits absent keys",
          patch.contains(#""groupColor":"purple""#) && !patch.contains("groupTitle") && !patch.contains("badgeEnabled"),
          patch)
} catch {
    check("outbound commands encode", false, "threw \(error)")
}

check("scope wire names match the extension", Scope.allCases.map(\.rawValue) == ["mine", "reviewing", "assigned"])

let samplePR = PullRequest(
    id: "pr1", number: 1, title: "t", url: "u", repo: "r", isDraft: false,
    updatedAt: "", additions: 0, deletions: 0, reviewDecision: nil, checks: nil
)
check("scopes subscript matches wire names",
      Scopes(mine: [samplePR], reviewing: [], assigned: [])[.mine].count == 1)

// MARK: - Summary

print("1..\(checks)")
if failures > 0 {
    print("# \(failures) of \(checks) failed")
    exit(1)
}
print("# all \(checks) passed")
