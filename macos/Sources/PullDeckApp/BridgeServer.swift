import Foundation
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
    private let socketPath: String

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
    }

    func stop() {
        if clientFD >= 0 { close(clientFD) }
        if listenFD >= 0 { close(listenFD) }
        unlink(socketPath)
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
    }

    private func detach(_ fd: Int32) {
        guard clientFD == fd else { return }
        clientFD = -1
        isAttached = false
        progress = nil
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
        case .reply(_, let ok, _, let error):
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
    func openAll() { send(.openAll(id: nextID(), scope: scope)) }
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
