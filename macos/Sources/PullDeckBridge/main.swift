import Foundation
import PullDeckKit

// The relay Chrome spawns.
//
// Chrome launches this process itself, one per connectNative() port, and it
// dies with that port. It holds no state: it forwards Chrome's length-prefixed
// stdio on one side to the menu bar app's Unix socket on the other.
//
// Everything it prints for humans goes to stderr. The docs are explicit that
// stdout is the wire and nothing else may appear there:
// "Make sure that all output in stdout adheres to the native messaging protocol."

func log(_ message: String) {
    FileHandle.standardError.write(Data("pulldeck-bridge: \(message)\n".utf8))
}

// argv[1] is "the origin of the caller, usually chrome-extension://[ID]".
// Chrome already enforces allowed_origins before launching us; this is a
// belt-and-braces check and is logged rather than trusted as security.
let callerOrigin = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "(none)"
log("launched by \(callerOrigin)")

let socketPath = ProcessInfo.processInfo.environment["PULLDECK_SOCKET"] ?? UnixSocket.defaultPath

let socketFD: Int32
do {
    socketFD = try UnixSocket.connect(to: socketPath)
} catch {
    // The overwhelmingly common case: the menu bar app is not running. Exiting
    // cleanly makes Chrome close the port, which the extension sees as a
    // disconnect and retries later with backoff.
    log("menu bar app not reachable at \(socketPath) — \(error)")
    exit(0)
}
log("attached to \(socketPath)")

let stdinFD = FileHandle.standardInput.fileDescriptor
let stdoutFD = FileHandle.standardOutput.fileDescriptor

/// Serialises writes to stdout. Chrome's parser cannot survive interleaving.
let stdoutLock = NSLock()

func writeToChrome(_ payload: Data) {
    do {
        let framed = try NativeMessaging.frame(payload)
        stdoutLock.lock()
        defer { stdoutLock.unlock() }
        UnixSocket.writeAll(fd: stdoutFD, framed)
    } catch {
        // A message the app produced that Chrome would reject. Dropping one
        // message beats corrupting the stream for every message after it.
        log("dropping outbound message: \(error)")
    }
}

// App → Chrome. Newline-delimited JSON in, framed JSON out.
let appToChrome = Thread {
    UnixSocket.pumpLines(fd: socketFD) { line in
        writeToChrome(line)
    }
    log("app closed the socket")
    exit(0)
}
appToChrome.stackSize = 512 * 1024
appToChrome.start()

// Chrome → app. Framed JSON in, newline-delimited JSON out.
// Runs on the main thread so that stdin EOF ends the process naturally.
var buffer = Data()
var chunk = [UInt8](repeating: 0, count: 64 * 1024)

while true {
    let n = read(stdinFD, &chunk, chunk.count)
    if n <= 0 {
        // Chrome closed the pipe: the port is gone, so we are done. The exit
        // mechanism is not spelled out in Chrome's docs, but a closed stdin is
        // the only signal a stdio host is given.
        log("chrome closed stdin")
        break
    }
    buffer.append(contentsOf: chunk[0..<n])

    do {
        for message in try NativeMessaging.drain(buffer: &buffer) {
            if !UnixSocket.writeLine(fd: socketFD, message) {
                log("app socket went away mid-write")
                exit(0)
            }
        }
    } catch {
        // A desynchronised stream cannot be recovered — every subsequent length
        // prefix would be read from the wrong offset.
        log("malformed frame from chrome: \(error)")
        break
    }
}

close(socketFD)
exit(0)
