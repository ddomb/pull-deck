import AppKit
import Combine
import Foundation
import PullDeckKit

@MainActor
public final class BridgeServer: ObservableObject {
    @Published public private(set) var state: AppState?
    @Published public private(set) var isAttached = false
    @Published public private(set) var progress: ProgressEvent?
    @Published public private(set) var lastFailure: String?
    @Published public private(set) var setup: [HostInstaller.Status] = []
    @Published public private(set) var relayPath: String?
    @Published public private(set) var scope: Scope = .mine
    @Published public private(set) var isOpening = false

    public static let shared = BridgeServer()
    public static let liveInterval: TimeInterval = 5
    public static let idleInterval: TimeInterval = 60

    private var listenFD: Int32 = -1
    private var client: SocketClient?
    private var listenerGeneration = UUID()
    private let acceptQueue = DispatchQueue(label: "com.pulldeck.accept")
    private let readQueue = DispatchQueue(label: "com.pulldeck.read", attributes: .concurrent)
    private let writeQueue = DispatchQueue(label: "com.pulldeck.write")
    private let installQueue = DispatchQueue(label: "com.pulldeck.install")
    private var pollTimer: Timer?
    private var liveTimer: Timer?
    private var installPending = false
    private var panelVisible = false
    private var userPickedScope = false
    private var nextCommandID = 1
    private var openingID: Int?
    private var refreshID: Int?
    private var pending: Set<Int> = []
    private var membership = Set<String>()
    private let socketPath: String

    public init(socketPath: String = UnixSocket.defaultPath) { self.socketPath = socketPath }

    public func start(installHosts: Bool = true) {
        guard listenFD < 0 else { return }
        do { listenFD = try UnixSocket.listen(at: socketPath) } catch {
            lastFailure = "Could not start the bridge: \(error)"
            return
        }
        let fd = listenFD
        let generation = listenerGeneration
        acceptQueue.async { [weak self] in self?.acceptLoop(fd, generation: generation) }
        if installHosts {
            relayPath = HostInstaller.relayPathInBundle()
            reconcileHosts()
            pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, !self.isAttached else { return }
                    self.reconcileHosts()
                }
            }
        }
    }

    public func stop() {
        listenerGeneration = UUID()
        pollTimer?.invalidate()
        pollTimer = nil
        if let client { detach(client) }
        if listenFD >= 0 {
            shutdown(listenFD, SHUT_RDWR)
            close(listenFD)
            listenFD = -1
        }
        unlink(socketPath)
    }

    public func reconcileHosts() {
        guard !installPending, let relay = relayPath else { return }
        installPending = true
        installQueue.async {
            let result = HostInstaller.reconcile(relayPath: relay)
            Task { @MainActor in
                self.setup = result
                self.installPending = false
            }
        }
    }

    public func setPanelVisible(_ visible: Bool) {
        guard visible != panelVisible else { return }
        panelVisible = visible
        restartLiveUpdates()
        if visible { refresh() }
    }
    private func restartLiveUpdates() {
        liveTimer?.invalidate()
        liveTimer = nil
        guard isAttached else { return }
        liveTimer = Timer.scheduledTimer(
            withTimeInterval: panelVisible ? Self.liveInterval : Self.idleInterval, repeats: true
        ) { [weak self] _ in
            Task { @MainActor in if let self, !self.isOpening { self.refresh() } }
        }
    }

    private nonisolated func acceptLoop(_ fd: Int32, generation: UUID) {
        while true {
            let accepted = accept(fd, nil, nil)
            if accepted < 0 {
                if errno == EINTR { continue }
                return
            }
            let candidate = SocketClient(accepted)
            Task { @MainActor in
                guard self.listenerGeneration == generation, self.listenFD >= 0 else {
                    candidate.finish()
                    return
                }
                self.adopt(candidate)
            }
        }
    }

    private func adopt(_ candidate: SocketClient) {
        if client != nil {
            let message: [String: Any] = [
                "type": "hello", "version": BuildIdentity.protocolVersion, "accepted": false,
                "reason":
                    "Another browser profile is using the menu bar app. Close that profile or quit its browser, then retry here.",
            ]
            writeQueue.async {
                if let data = try? JSONSerialization.data(withJSONObject: message) {
                    _ = candidate.send(data)
                }
                candidate.finish()
            }
            return
        }
        client = candidate
        readQueue.async {
            UnixSocket.pumpLines(fd: candidate.fd) { line in
                guard let message = InboundMessage.decode(line) else { return }
                Task { @MainActor in if self.client === candidate { self.handle(message) } }
            }
            candidate.finish()
            Task { @MainActor in self.detach(candidate) }
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard let self, self.client === candidate, !self.isAttached else { return }
            self.detach(candidate)
        }
    }

    private func detach(_ previous: SocketClient) {
        guard client === previous else { return }
        client = nil
        previous.stop()
        isAttached = false
        state = nil
        membership.removeAll()
        openingID = nil
        refreshID = nil
        pending.removeAll()
        isOpening = false
        progress = nil
        liveTimer?.invalidate()
        liveTimer = nil
    }

    private func apply(_ next: AppState) {
        guard (next.authRevision ?? 0) >= (state?.authRevision ?? 0) else { return }
        state = next
        membership = Set(next.group?.keys ?? [])
        if !userPickedScope, next.scopes?[scope].isEmpty ?? true,
            let populated = Scope.allCases.first(where: { !(next.scopes?[$0].isEmpty ?? true) })
        {
            scope = populated
        }
    }

    private func handle(_ message: InboundMessage) {
        if case .hello(let version, let extensionID) = message {
            guard let current = client else { return }
            let compatible =
                version == BuildIdentity.protocolVersion && extensionID == BuildIdentity.extensionID
            let reply: [String: Any] = [
                "type": "hello", "version": BuildIdentity.protocolVersion, "accepted": compatible,
                "reason": compatible
                    ? ""
                    : "App and extension do not match. Rebuild and reload both from the same checkout."
                    ,
            ]
            writeQueue.async {
                if let data = try? JSONSerialization.data(withJSONObject: reply) {
                    _ = current.send(data)
                }
                if !compatible { current.stop() }
            }
            guard compatible else {
                lastFailure = reply["reason"] as? String
                return
            }
            isAttached = true
            lastFailure = nil
            restartLiveUpdates()
            refresh(force: false)
            return
        }
        guard isAttached else { return }
        switch message {
        case .state(let next): apply(next)
        case .stateError(let error): lastFailure = error.message
        case .progress(let event):
            guard let openingID, event.operationId == "native:\(openingID)" else { return }
            progress = event.kind == "done" ? nil : event
        case .reply(let id, let ok, let payload, let error):
            guard pending.remove(id) != nil else { return }
            if refreshID == id { refreshID = nil }
            if openingID == id {
                openingID = nil
                isOpening = false
                progress = nil
            }
            if !ok {
                lastFailure = error?.message ?? "The extension rejected the command."
                return
            }
            if let next = payload?.state { apply(next) }
            if let result = payload?.openResult {
                let failures = result.failures ?? []
                if !failures.isEmpty {
                    lastFailure =
                        "\(failures.count) pull request(s) could not be opened. \(failures[0].message)"
                } else {
                    lastFailure = result.warnings?.joined(separator: " ")
                    if lastFailure == "" { lastFailure = nil }
                }
            }
        case .hello, .unknown: break
        }
    }

    private func nextID() -> Int {
        defer { nextCommandID += 1 }
        return nextCommandID
    }
    private func send(_ command: OutboundCommand) {
        guard let current = client, isAttached, let payload = try? command.encoded() else { return }
        pending.insert(command.id)
        writeQueue.async {
            if !current.send(payload) { Task { @MainActor in self.detach(current) } }
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard let self, self.client === current, self.pending.remove(command.id) != nil else {
                return
            }
            if self.refreshID == command.id { self.refreshID = nil }
            if self.openingID == command.id {
                self.openingID = nil
                self.isOpening = false
                self.progress = nil
            }
            self.lastFailure = "The extension did not finish the command. Try again."
        }
    }
    public func refresh(force: Bool = true) {
        guard isAttached, refreshID == nil else { return }
        let id = nextID()
        refreshID = id
        send(.getState(id: id, force: force))
    }
    public func openAll() {
        guard isAttached, !isOpening else { return }
        let id = nextID()
        openingID = id
        isOpening = true
        send(.openAll(id: id, scope: scope))
    }
    public func open(_ pr: PullRequest) {
        guard isAttached, !isOpening else { return }
        let id = nextID()
        openingID = id
        isOpening = true
        send(.openOne(id: id, prId: pr.id))
    }
    public func setGroupColor(_ color: String) {
        send(.settings(id: nextID(), patch: SettingsPatch(groupColor: color)))
    }
    public func choose(_ next: Scope) {
        userPickedScope = true
        scope = next
    }
    public var browsersWithExtension: [HostInstaller.Status] { setup.filter(\.extensionLoaded) }
    public var browsersNeedingReload: [HostInstaller.Status] { setup.filter(\.needsReload) }
    public var extensionFound: Bool { !browsersWithExtension.isEmpty }
    public var bridgeInstalled: Bool { setup.contains(where: \.ready) }
    public func openExtensionsPage() {
        let browser = browsersWithExtension.first?.browser.name ?? "Google Chrome"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = [
            "-a", browser == "Chrome" ? "Google Chrome" : browser, "chrome://extensions",
        ]
        try? task.run()
    }
    public func revealExtensionFolder() {
        if let path = HostInstaller.extensionSourcePath() {
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
        }
    }
    public var pullRequests: [PullRequest] { state?.scopes?[scope] ?? [] }
    public func isGrouped(_ pr: PullRequest) -> Bool {
        pr.key.map { membership.contains($0) } ?? false
    }
    public var pendingPullRequests: [PullRequest] { pullRequests.filter { !isGrouped($0) } }
    public var groupTitle: String { state?.settings?.groupTitle ?? "Pull Requests" }
    public var badgeCount: Int {
        Set(Scope.allCases.flatMap { state?.scopes?[$0].map(\.id) ?? [] }).count
    }
}
