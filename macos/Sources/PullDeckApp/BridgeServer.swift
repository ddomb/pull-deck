import Foundation
import AppKit
import PullDeckKit

/// Owns the Unix socket the relay attaches to, and everything the UI renders.
///
/// The connection direction is inverted from what you would expect: this app
/// cannot reach into Chrome. It listens, and Chrome's extension reaches out —
/// via a relay Chrome itself spawns. So "no relay attached" is an ordinary,
/// displayable condition (Chrome closed, extension unloaded, service worker
/// between lives), not an error state.
@MainActor
final class BridgeServer: ObservableObject {
    @Published private(set) var state: AppState?
    @Published private(set) var isAttached = false
    @Published private(set) var progress: ProgressEvent?
    @Published private(set) var lastFailure: String?
    @Published private(set) var setup: [HostInstaller.Status] = []
    @Published private(set) var relayPath: String?
    @Published var scope: Scope = .mine

    private var listenFD: Int32 = -1
    private var clientFD: Int32 = -1
    private var nextCommandID = 1
    /// The accept queue is occupied by `pumpLines` for the whole life of a
    /// connection, so writes need their own. Sharing one serial queue means
    /// every outbound command queues up behind the read loop and is delivered
    /// only once the connection closes — the app attaches and then goes mute.
    private let acceptQueue = DispatchQueue(label: "com.pulldeck.bridge.accept")
    private let writeQueue = DispatchQueue(label: "com.pulldeck.bridge.write")
    private let installQueue = DispatchQueue(label: "com.pulldeck.hosts")
    private var pollTimer: Timer?
    private var liveTimer: Timer?
    private let socketPath: String

    /// Five seconds while the panel is on screen, one minute while only the
    /// menu bar count is visible. The extension throttles what actually reaches
    /// GitHub, so these are requests for freshness rather than guaranteed
    /// network calls — but there is no reason to ask at five-second resolution
    /// for a number nobody is looking at.
    static let liveInterval: TimeInterval = 5
    static let idleInterval: TimeInterval = 60

    /// One listener per process, started at launch rather than when the panel
    /// is first opened — Chrome's extension reaches out on its own schedule and
    /// must find a socket waiting whether or not anyone has clicked the icon.
    static let shared = BridgeServer()

    init(socketPath: String = UnixSocket.defaultPath) {
        self.socketPath = socketPath
    }

    // MARK: - Lifecycle

    func start() {
        do {
            listenFD = try UnixSocket.listen(at: socketPath)
        } catch {
            lastFailure = "Could not open \(socketPath): \(error)"
            return
        }
        // Hand the descriptor to the loop by value. Reading it back from the
        // main actor inside a background loop would mean assumeIsolated(), which
        // traps rather than blocks when the assumption is false.
        let fd = listenFD
        acceptQueue.async { [weak self] in self?.acceptLoop(listening: fd) }

        relayPath = HostInstaller.relayPathInBundle()
        reconcileHosts()
        // Keep watching while nothing is attached: the extension may be loaded
        // into a browser minutes from now, and the manifest has to be waiting
        // when it is or the first connectNative fails for nothing.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reconcileHosts() }
        }
    }

    /// Install the host manifest wherever the extension actually lives, and
    /// remove ones left behind where it no longer does. Idempotent and cheap.
    func reconcileHosts() {
        guard let relay = relayPath else { return }
        // These preference files run to several megabytes; keep them off main.
        installQueue.async {
            let statuses = HostInstaller.reconcile(relayPath: relay)
            Task { @MainActor in self.setup = statuses }
        }
    }

    /// Driven by the panel appearing and disappearing.
    func setPanelVisible(_ visible: Bool) {
        guard panelVisible != visible else { return }
        panelVisible = visible
        restartLiveUpdates()
        if visible { refresh() } // don't make the first look wait for a tick
    }

    private var panelVisible = false

    private func restartLiveUpdates() {
        liveTimer?.invalidate()
        liveTimer = nil
        guard isAttached else { return }
        let interval = panelVisible ? Self.liveInterval : Self.idleInterval
        liveTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func tick() {
        guard isAttached, !isOpening else { return }
        send(.getState(id: nextID(), force: true))
    }

    /// True between clicking Open and the run settling, so a live tick cannot
    /// stomp the progress display.
    private var isOpening = false

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        liveTimer?.invalidate()
        liveTimer = nil
        if clientFD >= 0 { close(clientFD) }
        if listenFD >= 0 { close(listenFD) }
        unlink(socketPath)
    }

    // MARK: - Setup state

    /// Browsers that actually have the extension loaded.
    var browsersWithExtension: [HostInstaller.Status] { setup.filter(\.extensionLoaded) }
    var extensionFound: Bool { !browsersWithExtension.isEmpty }
    var bridgeInstalled: Bool { setup.contains(where: \.ready) }

    /// Loaded, but under a pre-pinning id — one reload away from working.
    var browsersNeedingReload: [HostInstaller.Status] { setup.filter(\.needsReload) }

    /// Chrome will not open a `chrome://` URL handed to it by another app, but
    /// it does accept one on its command line.
    func openExtensionsPage() {
        let browser = browsersWithExtension.first?.browser.name ?? "Google Chrome"
        let appName = browser == "Chrome" ? "Google Chrome" : browser
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-a", appName, "chrome://extensions"]
        try? task.run()
    }

    func revealExtensionFolder() {
        guard let path = HostInstaller.extensionSourcePath() else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    private nonisolated func acceptLoop(listening listenFD: Int32) {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 {
                if errno == EINTR { continue }
                return // listener closed
            }
            Task { @MainActor in self.adopt(fd) }
            // One relay at a time. pumpLines blocks until this one goes away,
            // then we come back around for the next connectNative().
            UnixSocket.pumpLines(fd: fd) { line in
                guard let message = InboundMessage.decode(line) else { return }
                Task { @MainActor in self.handle(message) }
            }
            close(fd)
            Task { @MainActor in self.detach(fd) }
        }
    }

    private func adopt(_ fd: Int32) {
        if clientFD >= 0 && clientFD != fd { close(clientFD) }
        clientFD = fd
        isAttached = true
        lastFailure = nil
        send(.getState(id: nextID(), force: false))
        restartLiveUpdates()
    }

    private func detach(_ fd: Int32) {
        guard clientFD == fd else { return }
        clientFD = -1
        isAttached = false
        progress = nil
        liveTimer?.invalidate()
        liveTimer = nil
    }

    // MARK: - Inbound

    private func handle(_ message: InboundMessage) {
        switch message {
        case .hello(let version, _):
            if version != 1 {
                lastFailure = "The extension speaks bridge protocol \(version); this app speaks 1."
            }
        case .state(let next):
            state = next
            // Land on a scope that has something in it, but only while the user
            // has not chosen one themselves.
            if !userPickedScope, next.scopes?[scope].isEmpty ?? true,
               let populated = Scope.allCases.first(where: { !(next.scopes?[$0].isEmpty ?? true) }) {
                scope = populated
            }
        case .stateError(let error):
            lastFailure = error.message
        case .progress(let event):
            progress = event.kind == "done" ? nil : event
            if event.kind == "done" { isOpening = false }
        case .reply(_, let ok, _, let error):
            isOpening = false
            if !ok { lastFailure = error?.message ?? "The extension rejected that." }
            if ok { lastFailure = nil }
        case .unknown:
            break // a newer extension saying something we do not need to understand
        }
    }

    private var userPickedScope = false

    func choose(_ next: Scope) {
        userPickedScope = true
        scope = next
    }

    // MARK: - Outbound

    private func nextID() -> Int {
        defer { nextCommandID += 1 }
        return nextCommandID
    }

    func send(_ command: OutboundCommand) {
        guard clientFD >= 0, let payload = try? command.encoded() else { return }
        let fd = clientFD
        writeQueue.async {
            if !UnixSocket.writeLine(fd: fd, payload) {
                Task { @MainActor in self.detach(fd) }
            }
        }
    }

    func refresh() { send(.getState(id: nextID(), force: true)) }
    func openAll() {
        isOpening = true
        send(.openAll(id: nextID(), scope: scope))
    }
    func open(_ pr: PullRequest) { send(.openOne(id: nextID(), prId: pr.id)) }
    func setGroupColor(_ color: String) {
        send(.settings(id: nextID(), patch: SettingsPatch(groupColor: color)))
    }

    // MARK: - Derived

    var pullRequests: [PullRequest] { state?.scopes?[scope] ?? [] }

    var groupedKeys: Set<String> { Set(state?.group?.keys ?? []) }

    /// Membership is tested against keys the extension computed. The app never
    /// parses a GitHub URL — one copy of that rule, in one language.
    func isGrouped(_ pr: PullRequest) -> Bool {
        guard let key = key(for: pr) else { return false }
        return groupedKeys.contains(key)
    }

    private func key(for pr: PullRequest) -> String? {
        // The extension ships keys as host/owner/repo#number; match by suffix on
        // the number and repo rather than re-deriving the whole rule here.
        groupedKeys.first { $0.hasSuffix("/\(pr.repo.lowercased())#\(pr.number)") }
    }

    var pending: [PullRequest] { pullRequests.filter { !isGrouped($0) } }

    var groupTitle: String { state?.settings?.groupTitle ?? "Pull Requests" }

    var badgeCount: Int {
        guard let scopes = state?.scopes else { return 0 }
        var ids = Set<String>()
        for scope in Scope.allCases { for pr in scopes[scope] { ids.insert(pr.id) } }
        return ids.count
    }
}
