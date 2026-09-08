import Foundation
import PullDeckKit
import PullDeckRuntime

final class Peer: @unchecked Sendable {
    let fd: Int32
    private let lock = NSLock()
    private var received: [[String: Any]] = []
    init(path: String) throws {
        fd = try UnixSocket.connect(to: path)
        Thread { [self] in
            UnixSocket.pumpLines(fd: fd) { data in
                if let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    lock.lock()
                    received.append(message)
                    lock.unlock()
                }
            }
        }.start()
    }
    func send(_ message: [String: Any]) {
        _ = UnixSocket.writeLine(fd: fd, try! JSONSerialization.data(withJSONObject: message))
    }
    func last(_ type: String) -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return received.last { $0["type"] as? String == type }
    }
    func closePeer() { shutdown(fd, SHUT_RDWR) }
    deinit { close(fd) }
}

@main
struct RuntimeChecks {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ name: String, _ passed: Bool) {
            checks += 1
            print("\(passed ? "ok" : "not ok") \(checks) - \(name)")
            if !passed { exit(1) }
        }
        func eventually(_ condition: @escaping @MainActor () -> Bool) async -> Bool {
            for _ in 0..<200 {
                if condition() { return true }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
            return false
        }
        let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
        guard root.hasPrefix("/") else { fatalError("Pass an absolute temporary test directory.") }
        let fixtures =
            try JSONSerialization.jsonObject(
                with: Data(contentsOf: URL(fileURLWithPath: root + "/bridge-fixtures.json")))
            as! [[String: Any]]
        for fixture in fixtures {
            let decoded = InboundMessage.decode(try JSONSerialization.data(withJSONObject: fixture))
            if case .reply(_, let ok, let payload, _)? = decoded {
                check("actual JS reply \(fixture["id"]!) decodes", ok && payload != nil)
            } else {
                check("actual JS reply decodes", false)
            }
        }
        let path = root + "/bridge.sock"
        let server = BridgeServer(socketPath: path)
        server.start(installHosts: false)
        defer { server.stop() }

        var pair: [Int32] = [0, 0]
        check("socket pair created", socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
        UnixSocket.suppressBrokenPipe(fd: pair[0])
        close(pair[1])
        check(
            "closed-peer write returns failure without SIGPIPE",
            !UnixSocket.writeAll(fd: pair[0], Data([1])))
        close(pair[0])

        let first = try Peer(path: path)
        first.send([
            "type": "hello", "version": BuildIdentity.protocolVersion,
            "extensionId": BuildIdentity.extensionID,
        ])
        check(
            "first profile completes the handshake",
            await eventually { server.isAttached && first.last("getState") != nil })
        let state: [String: Any] = [
            "stage": "list", "authRevision": 2,
            "viewer": ["login": "user"],
            "scopes": [
                "mine": [
                    [
                        "id": "pr1", "number": 1, "title": "A change",
                        "url": "https://github.com/acme/api/pull/1",
                        "key": "github.com/acme/api#1", "repo": "acme/api", "isDraft": false,
                        "updatedAt": "2026-09-08T00:00:00Z", "additions": 1, "deletions": 0,
                    ]
                ], "reviewing": [], "assigned": [],
            ],
            "group": ["keys": ["git.example.test/acme/api#1"], "otherWindow": false],
        ]
        first.send([
            "type": "reply", "id": first.last("getState")!["id"]!, "ok": true, "data": state,
        ])
        check(
            "getState reply is decoded and displayed",
            await eventually { server.state?.viewer?.login == "user" })
        check("group membership distinguishes hosts", server.pendingPullRequests.count == 1)

        server.openAll()
        check("open command is sent", await eventually { first.last("openAll") != nil })
        let id = first.last("openAll")!["id"] as! Int
        first.send([
            "type": "progress", "operationId": "native:\(id)", "kind": "tab", "done": 1, "total": 1,
        ])
        check("matching operation progress is shown", await eventually { server.progress != nil })
        first.send([
            "type": "reply", "id": id, "ok": false,
            "error": ["kind": "unknown", "message": "Group failed"],
        ])
        check(
            "failed terminal reply clears every busy state",
            await eventually { !server.isOpening && server.progress == nil })
        check("failure remains actionable", server.lastFailure == "Group failed")

        server.openAll()
        check(
            "a new operation is accepted after failure",
            await eventually { (first.last("openAll")?["id"] as? Int) != id })
        let secondID = first.last("openAll")!["id"] as! Int
        first.send([
            "type": "progress", "operationId": "native:\(secondID)", "kind": "start", "total": 0,
        ])
        first.send([
            "type": "reply", "id": secondID, "ok": true,
            "data": ["created": 0, "adopted": 0, "skipped": 1, "failures": []],
        ])
        check(
            "no-op success also clears progress",
            await eventually { !server.isOpening && server.progress == nil })

        server.openAll()
        check(
            "partial-failure operation starts",
            await eventually { (first.last("openAll")?["id"] as? Int) != secondID })
        let thirdID = first.last("openAll")!["id"] as! Int
        first.send([
            "type": "reply", "id": thirdID, "ok": true,
            "data": [
                "created": 0, "adopted": 0, "skipped": 0,
                "failures": [["id": "pr1", "message": "Tab unavailable"]],
            ],
        ])
        check(
            "partial failures survive the protocol boundary",
            await eventually { server.lastFailure?.contains("Tab unavailable") == true })

        let other = try Peer(path: path)
        check(
            "second profile receives an explicit rejection",
            await eventually { other.last("hello")?["accepted"] as? Bool == false })
        check("first profile remains attached", server.isAttached)
        other.closePeer()

        server.openAll()
        first.closePeer()
        check(
            "disconnect cancels outstanding operations",
            await eventually { !server.isAttached && !server.isOpening && server.progress == nil })
        let replacement = try Peer(path: path)
        replacement.send([
            "type": "hello", "version": BuildIdentity.protocolVersion,
            "extensionId": BuildIdentity.extensionID,
        ])
        check(
            "another profile can connect after disconnect",
            await eventually { server.isAttached && replacement.last("getState") != nil })
        replacement.send([
            "type": "reply", "id": replacement.last("getState")!["id"]!, "ok": true, "data": state,
        ])
        check("reconnected state is usable", await eventually { server.state?.isList == true })
        var stale = state
        stale["authRevision"] = 1
        stale["viewer"] = ["login": "old-user"]
        replacement.send(["type": "state", "state": stale])
        try? await Task.sleep(nanoseconds: 30_000_000)
        check(
            "older account revisions cannot replace current data",
            server.state?.viewer?.login == "user")
        replacement.closePeer()
        print("1..\(checks)")
    }
}
