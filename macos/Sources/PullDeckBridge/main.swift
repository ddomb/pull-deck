import Foundation
import PullDeckKit

// stdout is a pipe, so SO_NOSIGPIPE alone cannot protect relay writes.
signal(SIGPIPE, SIG_IGN)

// The relay Chrome spawns.
//
// Chrome launches this process itself, one per connectNative() port, and it
// dies with that port. It answers the extension's handshake itself, then
// routes between Chrome's length-prefixed stdio and two Unix sockets: the menu
// bar app's (dialled, whenever it is open) and viewer.sock (served, for local
// viewers such as the Claude Code mod). Hub.swift holds the routing.
//
// Everything it prints for humans goes to stderr. The docs are explicit that
// stdout is the wire and nothing else may appear there:
// "Make sure that all output in stdout adheres to the native messaging protocol."

// argv[1] is "the origin of the caller, usually chrome-extension://[ID]".
let callerOrigin = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "(none)"

// Scripted install path. Chrome only ever passes a chrome-extension:// origin,
// so this flag cannot collide with a real launch. Sharing the app's installer
// keeps the command line and the GUI from drifting apart.
// Shows exactly what discovery sees. The failure this exists for — a browser
// that is not detected — is otherwise completely silent.
if callerOrigin == "--diagnose" {
    print("extension id: \(HostInstaller.extensionID)")
    print("relay:        \(HostInstaller.relayPathInBundle() ?? "NOT FOUND")")
    let browsers = HostInstaller.discover()
    print("\ndiscovered \(browsers.count) Chromium user data directories:\n")
    print("extension source: \(HostInstaller.extensionSourcePath() ?? "unknown")\n")
    for browser in browsers {
        let finding = HostInstaller.find(in: browser)
        let manifest = HostInstaller.readManifest(at: browser.manifestURL) != nil
        print("  \(finding.pinned ? "●" : "○") \(browser.name)")
        print("      dir:      \(browser.userDataDir.path)")
        print("      profiles: \(HostInstaller.profiles(in: browser.userDataDir).count)")
        print("      loaded:   \(finding.pinned)   manifest: \(manifest)")
        if let legacy = finding.legacyID {
            print("      !! loaded under an older id: \(legacy)")
            print("         It was loaded before the id was pinned. Reload it at")
            print("         chrome://extensions and it will re-register as the pinned id.")
        }
    }
    if browsers.isEmpty {
        print("  (none — nothing under ~/Library/Application Support looked like one)")
    }
    exit(0)
}

if callerOrigin == "--install-hosts" || callerOrigin == "--uninstall-hosts" {
    let uninstalling = callerOrigin == "--uninstall-hosts"
    guard let relay = HostInstaller.relayPathInBundle() else {
        print("Could not locate the relay inside the app bundle.")
        exit(1)
    }
    if uninstalling {
        for browser in HostInstaller.discover() {
            try? HostInstaller.uninstall(from: browser)
        }
        print("Removed the Pull Deck host manifest from every browser.")
        exit(0)
    }
    let statuses = HostInstaller.reconcile(relayPath: relay)
    let ready = statuses.filter(\.ready)
    if ready.isEmpty {
        print("Pull Deck is not loaded in any browser yet, so there is nowhere to install.")
        print("Load it, then run this again — or just leave the app running and it will")
        print("install itself the moment the extension appears.")
        exit(1)
    }
    for entry in ready {
        print("installed for \(entry.browser.name)  ->  \(entry.browser.manifestURL.path)")
    }
    print("\nextension id: \(HostInstaller.extensionID)")
    exit(0)
}

// Chrome already enforces allowed_origins before launching us; this is a
// belt-and-braces check and is logged rather than trusted as security.
if callerOrigin != "(none)",
    !callerOrigin.contains(HostInstaller.extensionID)
{
    log("warning: launched by an unexpected origin \(callerOrigin)")
}
log("launched by \(callerOrigin)")

let environment = ProcessInfo.processInfo.environment
let socketPath = environment["PULLDECK_SOCKET"] ?? UnixSocket.defaultPath
let viewerPath =
    environment["PULLDECK_VIEWER_SOCKET"]
    ?? UnixSocket.directory.appendingPathComponent("viewer.sock").path

let stdinFD = FileHandle.standardInput.fileDescriptor
let stdoutFD = FileHandle.standardOutput.fileDescriptor

/// Serialises writes to stdout. Chrome's parser cannot survive interleaving.
let stdoutLock = NSLock()

func writeToChrome(_ payload: Data) {
    do {
        let framed = try NativeMessaging.frame(payload)
        stdoutLock.lock()
        defer { stdoutLock.unlock() }
        if !UnixSocket.writeAll(fd: stdoutFD, framed) { exit(0) }
    } catch {
        // A message Chrome would reject. Dropping one message beats corrupting
        // the stream for every message after it.
        log("dropping outbound message: \(error)")
    }
}

let hub = Hub(
    Hub.Config(appSocket: socketPath, viewerSocket: viewerPath, writeToChrome: writeToChrome))
atexit { hub.cleanUp() }

// Chrome → hub. Framed JSON in. Runs on the main thread so that stdin EOF ends
// the process naturally.
var buffer = Data()
var chunk = [UInt8](repeating: 0, count: 64 * 1024)

while true {
    let n = read(stdinFD, &chunk, chunk.count)
    if n < 0 && errno == EINTR { continue }
    if n <= 0 {
        // Chrome closed the pipe: the port is gone, so we are done. The exit
        // mechanism is not spelled out in Chrome's docs, but a closed stdin is
        // the only signal a stdio host is given.
        log("chrome closed stdin")
        break
    }
    buffer.append(contentsOf: chunk[0..<n])

    do {
        for message in try NativeMessaging.drain(buffer: &buffer) { hub.fromExtension(message) }
    } catch {
        // A desynchronised stream cannot be recovered — every subsequent length
        // prefix would be read from the wrong offset.
        log("malformed frame from chrome: \(error)")
        break
    }
}

exit(0)
