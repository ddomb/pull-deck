import Foundation
import PullDeckKit

// The read loop owns final close. Shutdown wakes it; queued writes retain this
// object, never an unowned descriptor that could be recycled for another client.
final class SocketClient: @unchecked Sendable {
    let fd: Int32
    private let lock = NSLock()
    private var stopped = false
    private var finished = false

    init(_ fd: Int32) {
        self.fd = fd
        UnixSocket.suppressBrokenPipe(fd: fd)
        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        _ = setsockopt(
            fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout)))
    }
    func send(_ payload: Data) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return false }
        return UnixSocket.writeLine(fd: fd, payload)
    }
    func stop() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped else { return }
        stopped = true
        shutdown(fd, SHUT_RDWR)
    }
    func finish() {
        stop()
        lock.lock()
        defer { lock.unlock() }
        if !finished {
            close(fd)
            finished = true
        }
    }
}
