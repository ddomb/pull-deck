import Foundation

// Swift mirrors of the messages in BRIDGE.md. Deliberately lenient: an older
// app should keep working against a newer extension rather than failing to
// decode, so unknown message types degrade to `.unknown` and absent fields to
// nil instead of throwing.

public struct PullRequest: Codable, Identifiable, Hashable {
    public let id: String
    public let number: Int
    public let title: String
    public let url: String
    public let repo: String
    public let isDraft: Bool
    public let updatedAt: String
    public let additions: Int
    public let deletions: Int
    public let reviewDecision: String?
    public let checks: String?

    // A public struct's memberwise init is internal; spell it out so callers
    // outside the module (the self-test, and SwiftUI previews) can build one.
    public init(
        id: String, number: Int, title: String, url: String, repo: String, isDraft: Bool,
        updatedAt: String, additions: Int, deletions: Int,
        reviewDecision: String?, checks: String?
    ) {
        self.id = id
        self.number = number
        self.title = title
        self.url = url
        self.repo = repo
        self.isDraft = isDraft
        self.updatedAt = updatedAt
        self.additions = additions
        self.deletions = deletions
        self.reviewDecision = reviewDecision
        self.checks = checks
    }
}

public struct Viewer: Codable, Hashable {
    public let login: String
    public let avatarUrl: String?

    public init(login: String, avatarUrl: String?) {
        self.login = login
        self.avatarUrl = avatarUrl
    }
}

public struct GroupState: Codable, Hashable {
    public let groupId: Int?
    public let keys: [String]
    public let otherWindow: Bool

    public init(groupId: Int?, keys: [String], otherWindow: Bool) {
        self.groupId = groupId
        self.keys = keys
        self.otherWindow = otherWindow
    }

    public static let empty = GroupState(groupId: nil, keys: [], otherWindow: false)
}

public struct BridgeSettings: Codable, Hashable {
    public let groupTitle: String
    public let groupColor: String
    public let badgeEnabled: Bool
    public let hasToken: Bool
    public let tokenTail: String?
}

public struct BridgeError: Codable, Hashable, Error {
    public let kind: String
    public let message: String
    public let retryAt: String?
}

public struct Scopes: Codable, Hashable {
    public let mine: [PullRequest]
    public let reviewing: [PullRequest]
    public let assigned: [PullRequest]

    public init(mine: [PullRequest], reviewing: [PullRequest], assigned: [PullRequest]) {
        self.mine = mine
        self.reviewing = reviewing
        self.assigned = assigned
    }

    public static let empty = Scopes(mine: [], reviewing: [], assigned: [])

    public subscript(name: Scope) -> [PullRequest] {
        switch name {
        case .mine: return mine
        case .reviewing: return reviewing
        case .assigned: return assigned
        }
    }
}

public enum Scope: String, Codable, CaseIterable, Identifiable {
    case mine, reviewing, assigned
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .mine: return "Mine"
        case .reviewing: return "Reviews"
        case .assigned: return "Assigned"
        }
    }
}

/// Exactly what the popup renders, because it is the same `loadState()`.
public struct AppState: Codable, Hashable {
    public let stage: String
    public let settings: BridgeSettings?
    public let viewer: Viewer?
    public let scopes: Scopes?
    public let group: GroupState?
    public let fetchedAt: Double?
    public let error: BridgeError?

    public var isList: Bool { stage == "list" }
    public var needsToken: Bool { stage == "onboarding" }
}

public struct OpenResult: Codable, Hashable {
    public let created: Int
    public let adopted: Int
    public let skipped: Int
    public let groupId: Int?
    public let movedWindow: Bool?
}

public struct ProgressEvent: Codable, Hashable {
    /// `start` | `tab` | `done`. Named `kind` because the transport envelope
    /// already owns `type`; see the regression test in tab-group.test.mjs.
    public let kind: String?
    public let done: Int?
    public let total: Int?
    public let id: String?
    public let ok: Bool?
}

/// Extension → app.
public enum InboundMessage {
    case hello(version: Int, extensionId: String?)
    case state(AppState)
    case stateError(BridgeError)
    case progress(ProgressEvent)
    case reply(id: Int, ok: Bool, result: OpenResult?, error: BridgeError?)
    case unknown(String)

    public static func decode(_ data: Data) -> InboundMessage? {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
        switch envelope.type {
        case "hello":
            return .hello(version: envelope.version ?? 0, extensionId: envelope.extensionId)
        case "state":
            if let state = envelope.state { return .state(state) }
            if let error = envelope.error { return .stateError(error) }
            return .unknown("state")
        case "progress":
            return .progress(
                ProgressEvent(
                    kind: envelope.kind, done: envelope.done, total: envelope.total,
                    id: envelope.id.flatMap(\.stringValue), ok: envelope.ok
                )
            )
        case "reply":
            guard let id = envelope.id?.intValue else { return .unknown("reply") }
            return .reply(id: id, ok: envelope.ok ?? false, result: envelope.data, error: envelope.error)
        default:
            return .unknown(envelope.type)
        }
    }

    private struct Envelope: Decodable {
        let type: String
        let version: Int?
        let extensionId: String?
        let state: AppState?
        let error: BridgeError?
        let data: OpenResult?
        let ok: Bool?
        let kind: String?
        let done: Int?
        let total: Int?
        /// `id` is an Int on replies and a pull-request String on progress.
        let id: LooseID?
    }
}

/// A JSON value that is an Int in one message and a String in another.
public enum LooseID: Decodable, Hashable {
    case int(Int)
    case string(String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public var intValue: Int? { if case .int(let v) = self { return v }; return nil }
    public var stringValue: String? { if case .string(let v) = self { return v }; return nil }
}

/// App → extension.
public struct OutboundCommand: Encodable {
    public let id: Int
    public let type: String
    public var scope: String?
    public var prId: String?
    public var force: Bool?
    public var patch: SettingsPatch?

    public static func getState(id: Int, force: Bool = false) -> OutboundCommand {
        OutboundCommand(id: id, type: "getState", force: force)
    }

    /// Names a scope. The app never sends URLs — resolving them extension-side
    /// is what keeps the pull-request identity rule in exactly one place.
    public static func openAll(id: Int, scope: Scope) -> OutboundCommand {
        OutboundCommand(id: id, type: "openAll", scope: scope.rawValue)
    }

    public static func openOne(id: Int, prId: String) -> OutboundCommand {
        OutboundCommand(id: id, type: "openOne", prId: prId)
    }

    public static func settings(id: Int, patch: SettingsPatch) -> OutboundCommand {
        OutboundCommand(id: id, type: "settings", patch: patch)
    }

    public static func ping(id: Int) -> OutboundCommand {
        OutboundCommand(id: id, type: "ping")
    }

    private init(
        id: Int, type: String, scope: String? = nil, prId: String? = nil,
        force: Bool? = nil, patch: SettingsPatch? = nil
    ) {
        self.id = id
        self.type = type
        self.scope = scope
        self.prId = prId
        self.force = force
        self.patch = patch
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

/// The same allow-list the popup uses. Notably absent: anything that would let
/// a client name the tab group, which would give the popup and the app two
/// different ideas of which group is "the" group.
public struct SettingsPatch: Encodable {
    public var groupTitle: String?
    public var groupColor: String?
    public var badgeEnabled: Bool?

    public init(groupTitle: String? = nil, groupColor: String? = nil, badgeEnabled: Bool? = nil) {
        self.groupTitle = groupTitle
        self.groupColor = groupColor
        self.badgeEnabled = badgeEnabled
    }
}
