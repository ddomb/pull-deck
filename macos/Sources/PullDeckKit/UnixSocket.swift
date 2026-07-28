import Foundation

/// Plain POSIX Unix-domain sockets.
///
/// Network.framework documents an `NWEndpoint.unix(path:)` case, but nothing on
/// developer.apple.com documents binding an `NWListener` to it —
/// `requiredLocalEndpoint` is described in terms of "a specific local IP address
/// and port". Rather than build the transport on an undocumented pairing, this
/// is 60 lines of POSIX that behaves exactly as specified.
///
/// A Unix socket rather than a localhost TCP port on purpose: a TCP listener is
/// reachable by any page in any browser on the machine, which is a poor trade
/// for a channel that can open tabs.
public enum UnixSocket {
    public enum SocketError: Error, CustomStringConvertible {
        case pathTooLong(String)
        case failed(String, errno: Int32)

        public var description: String {
            switch self {
            case .pathTooLong(let path):
                return "Socket path is too long for sockaddr_un: \(path)"
            case .failed(let call, let code):
                return "\(call) failed: \(String(cString: strerror(code))) (\(code))"
            }
        }
    }

    /// `~/Library/Application Support/PullDeck/bridge.sock`
    public static var defaultPath: String {
        directory.appendingPathComponent("bridge.sock").path
    }

    public static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/PullDeck", isDirectory: true)
    }

    private static func address(_ path: String) throws -> sockaddr_un {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        let bytes = Array(path.utf8)
        guard bytes.count < capacity else { throw SocketError.pathTooLong(path) }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
        }
        return addr
    }

    private static func withSockaddr<T>(
        _ addr: inout sockaddr_un,
        _ body: (UnsafePointer<sockaddr>, socklen_t) -> T
    ) -> T {
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        return withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, size) }
        }
    }

    /// Connect as a client. Throws when nothing is listening — which is the
    /// normal case when the menu bar app is not running.
    public static func connect(to path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.failed("socket", errno: errno) }
        var addr = try address(path)
        let result = withSockaddr(&addr) { pointer, size in
            Darwin.connect(fd, pointer, size)
        }
        guard result == 0 else {
            let code = errno
            close(fd)
            throw SocketError.failed("connect", errno: code)
        }
        return fd
    }

    /// Bind and listen. Removes a stale socket file left by a previous run.
    public static func listen(at path: String, backlog: Int32 = 4) throws -> Int32 {
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            // Owner-only: nothing else on the machine should be able to drive this.
            attributes: [.posixPermissions: 0o700]
        )
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError.failed("socket", errno: errno) }
        var addr = try address(path)
        let bound = withSockaddr(&addr) { pointer, size in
            Darwin.bind(fd, pointer, size)
        }
        guard bound == 0 else {
            let code = errno
            close(fd)
            throw SocketError.failed("bind", errno: code)
        }
        chmod(path, 0o600)
        guard Darwin.listen(fd, backlog) == 0 else {
            let code = errno
            close(fd)
            throw SocketError.failed("listen", errno: code)
        }
        return fd
    }

    /// Read until the fd closes, handing whole newline-delimited lines to `onLine`.
    public static func pumpLines(fd: Int32, onLine: (Data) -> Void) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return } // 0 = clean EOF, <0 = error; either way we're done
            buffer.append(contentsOf: chunk[0..<n])
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<newline])
                buffer = Data(buffer[buffer.index(after: newline)...])
                if !line.isEmpty { onLine(line) }
            }
        }
    }

    /// Write every byte, retrying short writes.
    @discardableResult
    public static func writeAll(fd: Int32, _ data: Data) -> Bool {
        var remaining = data
        while !remaining.isEmpty {
            let written = remaining.withUnsafeBytes { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return write(fd, base, raw.count)
            }
            if written <= 0 {
                if errno == EINTR { continue }
                return false
            }
            remaining = Data(remaining.dropFirst(written))
        }
        return true
    }

    /// One compact JSON object per line.
    @discardableResult
    public static func writeLine(fd: Int32, _ payload: Data) -> Bool {
        var out = payload
        out.append(0x0A)
        return writeAll(fd: fd, out)
    }
}
