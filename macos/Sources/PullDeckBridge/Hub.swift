import Foundation
import PullDeckKit

func log(_ message: String) {
    FileHandle.standardError.write(Data("pulldeck-bridge: \(message)\n".utf8))
}

private func decode(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

private func encode(_ object: [String: Any]) -> Data? {
    try? JSONSerialization.data(withJSONObject: object)
}

/// The relay's routing table between the one extension on stdio and its
/// upstream clients: the menu bar app on `bridge.sock`, and any number of
/// viewers (the Claude Code mod) on `viewer.sock`.
///
/// Every client numbers its own commands, so the hub gives each forwarded
/// command a relay id and maps the reply and progress back to the sender.
/// All routing state is touched on `queue` only.
final class Hub {
    struct Config {
        let appSocket: String
        let viewerSocket: String
        let writeToChrome: (Data) -> Void
    }

    final class Waiter {
        let command: String
        let semaphore = DispatchSemaphore(value: 0)
        var reply: [String: Any]?
        init(command: String) { self.command = command }
    }

    private enum Origin {
        case app(Int)
        case viewer(Waiter)
    }

    static let freshFor: TimeInterval = 5
    static let viewerCommands: Set<String> = ["getState", "openOne", "openAll", "search"]

    private let queue = DispatchQueue(label: "com.pulldeck.relay.hub")
    private let config: Config
    private var extensionID: String?
    private var appFD: Int32 = -1
    private var nextID = 1
    private var pending: [Int: Origin] = [:]
    private var state: Any = NSNull()
    private var stateError: Any = NSNull()
    private var stateAt: Date?
    private var viewerOpening = false
    private var ownsViewerSocket = false

    init(_ config: Config) { self.config = config }

    // MARK: Extension

    func fromExtension(_ payload: Data) {
        queue.async { if let message = decode(payload) { self.handleExtension(message) } }
    }

    private func handleExtension(_ message: [String: Any]) {
        let type = message["type"] as? String
        guard extensionID != nil else {
            guard type == "hello" else { return }
            accept(message)
            return
        }
        switch type {
        case "reply":
            guard let id = message["id"] as? Int, let origin = pending.removeValue(forKey: id) else {
                return
            }
            switch origin {
            case .app(let original):
                var forwarded = message
                forwarded["id"] = original
                writeToApp(forwarded)
            case .viewer(let waiter):
                if waiter.command == "getState", message["ok"] as? Bool == true {
                    remember(state: message["data"] ?? NSNull(), error: NSNull())
                }
                waiter.reply = message
                waiter.semaphore.signal()
            }
        case "progress":
            guard let operation = message["operationId"] as? String,
                operation.hasPrefix("native:"), let id = Int(operation.dropFirst(7)),
                case .app(let original)? = pending[id]
            else { return }
            var forwarded = message
            forwarded["operationId"] = "native:\(original)"
            writeToApp(forwarded)
        case "state":
            remember(state: message["state"] ?? NSNull(), error: message["error"] ?? NSNull())
            writeToApp(message)
        default:
            writeToApp(message)
        }
    }

    private func accept(_ hello: [String: Any]) {
        let version = hello["version"] as? Int
        let id = hello["extensionId"] as? String
        let compatible =
            version == BuildIdentity.protocolVersion && id == BuildIdentity.extensionID
        var reply: [String: Any] = [
            "type": "hello", "version": BuildIdentity.protocolVersion, "accepted": compatible,
            "peer": "relay",
        ]
        if !compatible {
            reply["reason"] =
                "The bridge and extension do not match. Rebuild and reload both from the same checkout."
        }
        writeToChrome(reply)
        guard compatible, let id else { return }
        extensionID = id
        sendPeers(app: false, reason: nil)
        startThread(name: "app") { self.appLoop(extensionID: id) }
        startThread(name: "viewers") { self.viewerLoop() }
    }

    private func remember(state: Any, error: Any) {
        self.state = state
        stateError = error
        stateAt = Date()
    }

    private func writeToChrome(_ object: [String: Any]) {
        if let data = encode(object) { config.writeToChrome(data) }
    }

    private func sendPeers(app: Bool, reason: String?) {
        var message: [String: Any] = ["type": "peers", "app": app]
        if let reason { message["reason"] = reason }
        writeToChrome(message)
    }

    /// A command from an upstream client, renumbered into the relay's id space.
    private func forward(_ command: [String: Any], from origin: Origin) {
        let id = nextID
        nextID += 1
        pending[id] = origin
        var renumbered = command
        renumbered["id"] = id
        writeToChrome(renumbered)
    }

    // MARK: Menu bar app

    private func writeToApp(_ object: [String: Any]) {
        guard appFD >= 0, let data = encode(object) else { return }
        // A failed write is noticed by the reader, which detaches the app.
        if !UnixSocket.writeLine(fd: appFD, data) { shutdown(appFD, SHUT_RDWR) }
    }

    /// Attaches whenever the app's socket answers, for the relay's whole life.
    /// The app cannot reach into Chrome, so this side always dials.
    private func appLoop(extensionID: String) {
        var announcedWaiting = false
        while true {
            guard let fd = try? UnixSocket.connect(to: config.appSocket) else {
                if !announcedWaiting {
                    log("menu bar app not reachable at \(config.appSocket) — waiting for it")
                    announcedWaiting = true
                }
                usleep(250_000)
                continue
            }
            announcedWaiting = false
            let hello: [String: Any] = [
                "type": "hello", "version": BuildIdentity.protocolVersion,
                "extensionId": extensionID,
            ]
            guard let data = encode(hello), UnixSocket.writeLine(fd: fd, data) else {
                close(fd)
                continue
            }
            var attached = false
            var refusal: String?
            UnixSocket.pumpLines(fd: fd) { line in
                guard let message = decode(line) else { return }
                if attached {
                    queue.async { self.handleApp(message) }
                    return
                }
                guard message["type"] as? String == "hello",
                    message["version"] as? Int == BuildIdentity.protocolVersion,
                    message["accepted"] as? Bool == true
                else {
                    refusal = message["reason"] as? String ?? "The menu bar app refused the bridge."
                    shutdown(fd, SHUT_RDWR)
                    return
                }
                attached = true
                log("attached to \(config.appSocket)")
                queue.sync {
                    appFD = fd
                    sendPeers(app: true, reason: nil)
                }
            }
            queue.sync {
                if appFD == fd { appFD = -1 }
                pending = pending.filter { if case .app = $0.value { return false } else { return true } }
                sendPeers(app: false, reason: refusal)
            }
            close(fd)
            // A refusal (another profile owns the app) will not change in 250 ms.
            if refusal != nil { sleep(5) }
        }
    }

    private func handleApp(_ message: [String: Any]) {
        guard let id = message["id"] as? Int else {
            writeToChrome(message)
            return
        }
        forward(message, from: .app(id))
    }

    // MARK: Viewers

    /// Serves `viewer.sock` unless another profile's relay already does. The
    /// socket is probed before binding: `UnixSocket.listen` unlinks whatever is
    /// at the path, which would take a live socket from the relay that has it.
    private func viewerLoop() {
        while true {
            if let probe = try? UnixSocket.connect(to: config.viewerSocket) {
                close(probe)
                sleep(5)
                continue
            }
            let fd: Int32
            do { fd = try UnixSocket.listen(at: config.viewerSocket, backlog: 16) } catch {
                log("could not serve viewers: \(error)")
                sleep(5)
                continue
            }
            queue.sync { ownsViewerSocket = true }
            log("serving viewers at \(config.viewerSocket)")
            while true {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 {
                    if errno == EINTR { continue }
                    break
                }
                UnixSocket.suppressBrokenPipe(fd: client)
                startThread(name: "viewer") { self.serveViewer(client) }
            }
            close(fd)
            queue.sync { ownsViewerSocket = false }
        }
    }

    /// Called at exit so a dead relay does not leave a socket that refuses.
    func cleanUp() {
        if ownsViewerSocket { unlink(config.viewerSocket) }
    }

    private func serveViewer(_ fd: Int32) {
        defer { close(fd) }
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let response: HTTPResponse
        if let request = HTTPRequest.read(fd: fd) {
            response = route(request)
        } else {
            response = .json(400, ["error": "Malformed or oversized request."])
        }
        UnixSocket.writeAll(fd: fd, response.encoded())
    }

    private func route(_ request: HTTPRequest) -> HTTPResponse {
        switch (request.method, request.path) {
        case ("GET", "/ping"):
            return .json(200, ["pong": true, "version": BuildIdentity.protocolVersion])
        case ("GET", "/state"):
            return viewerState()
        case ("POST", "/open"):
            guard let body = decode(request.body), let prId = body["prId"] as? String, !prId.isEmpty
            else { return .json(400, ["error": "Expected {\"prId\": string}."]) }
            return viewerOpen(["type": "openOne", "prId": prId])
        case ("POST", "/open-all"):
            guard let body = decode(request.body), let scope = body["scope"] as? String,
                ["mine", "reviewing", "assigned"].contains(scope)
            else { return .json(400, ["error": "Expected {\"scope\": mine|reviewing|assigned}."]) }
            return viewerOpen(["type": "openAll", "scope": scope])
        case ("POST", "/search"):
            guard let body = decode(request.body), let query = body["query"] as? String
            else { return .json(400, ["error": "Expected {\"query\": string}."]) }
            // Runs per keystroke, so it skips the one-open lock and waits briefly.
            return answer(run(["type": "search", "query": query], timeout: 5))
        default:
            return .json(404, ["error": "No route \(request.method) \(request.path)."])
        }
    }

    private func viewerState() -> HTTPResponse {
        let isFresh = queue.sync { stateAt.map { -$0.timeIntervalSinceNow < Self.freshFor } ?? false }
        if !isFresh { _ = run(["type": "getState"], timeout: 5) }
        return queue.sync {
            .json(200, ["app": appFD >= 0, "state": state, "error": stateError])
        }
    }

    private func viewerOpen(_ command: [String: Any]) -> HTTPResponse {
        let busy = queue.sync {
            if viewerOpening { return true }
            viewerOpening = true
            return false
        }
        if busy { return .json(409, ["error": "Another open is still running."]) }
        defer { queue.sync { viewerOpening = false } }
        return answer(run(command, timeout: 30))
    }

    private func answer(_ reply: [String: Any]?) -> HTTPResponse {
        guard let reply else {
            return .json(504, ["error": "The extension did not finish the command."])
        }
        return .json(
            200,
            [
                "ok": reply["ok"] as? Bool ?? false, "data": reply["data"] ?? NSNull(),
                "error": reply["error"] ?? NSNull(),
            ])
    }

    /// One viewer command, waited on. Nil on timeout.
    private func run(_ command: [String: Any], timeout: TimeInterval) -> [String: Any]? {
        guard let type = command["type"] as? String, Self.viewerCommands.contains(type) else {
            return nil
        }
        let waiter = Waiter(command: type)
        let id: Int = queue.sync {
            let id = nextID
            forward(command, from: .viewer(waiter))
            return id
        }
        if waiter.semaphore.wait(timeout: .now() + timeout) == .timedOut {
            queue.sync { _ = pending.removeValue(forKey: id) }
            return nil
        }
        return queue.sync { waiter.reply }
    }

    private func startThread(name: String, _ body: @escaping () -> Void) {
        let thread = Thread(block: body)
        thread.name = "pulldeck-bridge.\(name)"
        thread.stackSize = 512 * 1024
        thread.start()
    }
}

/// Just enough HTTP/1.1 for one request per connection from a local viewer.
struct HTTPRequest {
    static let limit = 64 * 1024

    let method: String
    let path: String
    let body: Data

    static func read(fd: Int32) -> HTTPRequest? {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        let separator = Data("\r\n\r\n".utf8)
        var headerEnd: Range<Data.Index>?
        while headerEnd == nil {
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
            if buffer.count > limit { return nil }
            headerEnd = buffer.range(of: separator)
        }
        guard let headerEnd,
            let head = String(data: buffer[..<headerEnd.lowerBound], encoding: .utf8)
        else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count == 3, parts[2].hasPrefix("HTTP/1.") else { return nil }
        var length = 0
        var isChunked = false
        for line in lines.dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1)
            guard pair.count == 2 else { continue }
            let name = pair[0].lowercased()
            let value = pair[1].trimmingCharacters(in: .whitespaces)
            if name == "transfer-encoding" {
                guard value.lowercased() == "chunked" else { return nil }
                isChunked = true
            } else if name == "content-length" {
                guard let count = Int(value), count >= 0, count <= limit else { return nil }
                length = count
            }
        }
        var rest = Data(buffer[headerEnd.upperBound...])
        let more: () -> Bool = {
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n <= 0 { return false }
            rest.append(contentsOf: chunk[0..<n])
            return rest.count <= limit + 1024
        }
        let body: Data
        if isChunked {
            // Clients that do not know the length up front (Node's http) send chunks.
            var decoded = Data()
            while true {
                let newline = Data("\r\n".utf8)
                while rest.range(of: newline) == nil { if !more() { return nil } }
                let sizeEnd = rest.range(of: newline)!
                guard let sizeLine = String(data: rest[..<sizeEnd.lowerBound], encoding: .utf8),
                    let size = Int(sizeLine.split(separator: ";")[0], radix: 16), size >= 0
                else { return nil }
                rest = Data(rest[sizeEnd.upperBound...])
                if size == 0 { break }
                while rest.count < size + 2 { if !more() { return nil } }
                decoded.append(rest.prefix(size))
                if decoded.count > limit { return nil }
                rest = Data(rest.dropFirst(size + 2))
            }
            body = decoded
        } else {
            while rest.count < length { if !more() { return nil } }
            body = rest.prefix(length)
        }
        let path = parts[1].split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        return HTTPRequest(method: String(parts[0]), path: path, body: body)
    }
}

struct HTTPResponse {
    let status: Int
    let body: Data

    static func json(_ status: Int, _ object: [String: Any]) -> HTTPResponse {
        HTTPResponse(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
    }

    func encoded() -> Data {
        let reasons = [
            200: "OK", 400: "Bad Request", 404: "Not Found", 409: "Conflict", 504: "Gateway Timeout",
        ]
        var out = Data(
            ("HTTP/1.1 \(status) \(reasons[status] ?? "Status")\r\n"
                + "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n"
                + "Connection: close\r\n\r\n").utf8)
        out.append(body)
        return out
    }
}
