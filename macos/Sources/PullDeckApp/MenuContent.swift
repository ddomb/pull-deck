import PullDeckKit
import PullDeckRuntime
import SwiftUI

/// The panel. Same grammar as the extension popup — grouped inset rows,
/// hairline separators, glyph-plus-word status, one accent — expressed in
/// native controls rather than reimplementing the CSS.
struct MenuContent: View {
    @ObservedObject var bridge: BridgeServer

    private let accent = Color(red: 0.0, green: 0.467, blue: 0.447)  // oklch(50% .118 190)

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            if !bridge.isAttached {
                setupChecklist
            } else if bridge.state?.needsToken == true {
                notice(
                    symbol: "key",
                    title: "Connect GitHub",
                    body:
                        "Open the Pull Deck extension in Chrome and paste a personal access token. The token stays there."
                )
            } else if let error = bridge.state?.error {
                notice(
                    symbol: "exclamationmark.triangle", title: "GitHub said no", body: error.message
                )
            } else {
                scopePicker
                list
                dock
            }
        }
        // The panel window keeps the height it was first measured at, so a
        // panel opened on the short setup state would squeeze the list flat.
        .frame(width: 380)
        .frame(minHeight: 420, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
        // Live only while the panel is actually on screen.
        .onAppear { bridge.setPanelVisible(true) }
        .onDisappear { bridge.setPanelVisible(false) }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "rectangle.stack.fill")
                .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 0) {
                Text("Pull Deck").font(.system(size: 13, weight: .semibold))
                if let login = bridge.state?.viewer?.login {
                    Text("@\(login)").font(.system(size: 10)).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Button {
                bridge.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .disabled(!bridge.isAttached)
            .help("Refresh")

            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Image(systemName: "power")
            }
            .buttonStyle(.borderless)
            .help("Quit Pull Deck")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var scopePicker: some View {
        Picker("", selection: Binding(get: { bridge.scope }, set: { bridge.choose($0) })) {
            ForEach(Scope.allCases) { scope in
                Text(label(for: scope)).tag(scope)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(.horizontal, 14)
        .padding(.top, 10)
    }

    private func label(for scope: Scope) -> String {
        let count = bridge.state?.scopes?[scope].count ?? 0
        return count > 0 ? "\(scope.title)  \(count)" : scope.title
    }

    // MARK: - List

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if bridge.pullRequests.isEmpty {
                    Text(emptyCopy)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.vertical, 40)
                        .padding(.horizontal, 24)
                } else {
                    ForEach(Array(bridge.pullRequests.enumerated()), id: \.element.id) {
                        index, pr in
                        if index > 0 { Divider().padding(.leading, 14) }
                        row(pr)
                    }
                }
            }
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(14)
        }
        .frame(maxHeight: 360)
    }

    private var emptyCopy: String {
        switch bridge.scope {
        case .mine: return "Nothing you have authored is open right now."
        case .reviewing: return "Nobody has asked you to review anything."
        case .assigned: return "No open pull request is assigned to you."
        }
    }

    private func row(_ pr: PullRequest) -> some View {
        Button {
            bridge.open(pr)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(pr.title)
                        .font(.system(size: 12.5, weight: .medium))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 5) {
                        Text(pr.repo).lineLimit(1).truncationMode(.middle)
                        Text("#\(pr.number)")
                        Text(age(pr.updatedAt))
                        Text("+\(pr.additions)").foregroundStyle(.green)
                        Text("−\(pr.deletions)").foregroundStyle(.red)
                    }
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)

                    badges(pr)
                }
                Spacer(minLength: 4)
                if bridge.isGrouped(pr) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(accent)
                        .help("Already in \(bridge.groupTitle)")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(bridge.isGrouped(pr) ? accent.opacity(0.07) : .clear)
    }

    @ViewBuilder
    private func badges(_ pr: PullRequest) -> some View {
        // Glyph plus word, never colour alone.
        let items = badgeItems(pr)
        if !items.isEmpty {
            HStack(spacing: 5) {
                ForEach(items, id: \.text) { item in
                    HStack(spacing: 2.5) {
                        Image(systemName: item.symbol)
                        Text(item.text)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(item.color)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(item.color.opacity(0.12), in: Capsule())
                }
            }
            .padding(.top, 1)
        }
    }

    private struct Badge {
        let symbol: String
        let text: String
        let color: Color
    }

    private func badgeItems(_ pr: PullRequest) -> [Badge] {
        var out: [Badge] = []
        if pr.isDraft {
            out.append(Badge(symbol: "circle.dashed", text: "Draft", color: .secondary))
        }
        switch pr.reviewDecision {
        case "APPROVED":
            out.append(Badge(symbol: "checkmark.circle", text: "Approved", color: .green))
        case "CHANGES_REQUESTED":
            out.append(Badge(symbol: "minus.circle", text: "Changes", color: .red))
        case "REVIEW_REQUIRED" where !pr.isDraft:
            out.append(Badge(symbol: "clock", text: "In review", color: .secondary))
        default: break
        }
        // Only non-passing checks earn a badge; a green tick on every row is noise.
        switch pr.checks {
        case "FAILURE", "ERROR":
            out.append(Badge(symbol: "xmark", text: "Checks failed", color: .red))
        case "PENDING", "EXPECTED":
            out.append(Badge(symbol: "circle.dotted", text: "Checks running", color: .orange))
        default: break
        }
        return out
    }

    // MARK: - Dock

    private var dock: some View {
        VStack(spacing: 6) {
            Divider()
            Button(action: { bridge.openAll() }) {
                HStack(spacing: 6) {
                    if let progress = bridge.progress, let done = progress.done,
                        let total = progress.total
                    {
                        Text("Opening \(done) of \(total)…")
                    } else if bridge.pendingPullRequests.isEmpty {
                        Text(
                            bridge.pullRequests.isEmpty
                                ? "Nothing to open"
                                : "All \(bridge.pullRequests.count) in “\(bridge.groupTitle)”")
                    } else {
                        Text("Open \(bridge.pendingPullRequests.count) in “\(bridge.groupTitle)”")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(accent)
            .disabled(bridge.pendingPullRequests.isEmpty || bridge.isOpening)
            .padding(.horizontal, 14)
            .padding(.top, 8)

            Text(footnote)
                .font(.system(size: 10))
                .foregroundStyle(bridge.lastFailure == nil ? Color.secondary : Color.red)
                .padding(.bottom, 10)
        }
    }

    private var footnote: String {
        if let failure = bridge.lastFailure { return failure }
        if bridge.state?.truncated?[bridge.scope.rawValue] == true {
            return "Showing the 50 most recently updated pull requests."
        }
        if bridge.state?.group?.otherWindow == true { return "The group lives in another window." }
        let already = bridge.pullRequests.count - bridge.pendingPullRequests.count
        if already > 0 && !bridge.pendingPullRequests.isEmpty {
            return "\(already) already there, so \(already == 1 ? "it stays" : "they stay") put."
        }
        return " "
    }

    // MARK: - Setup

    /// Names the step that is actually incomplete. The generic "not connected"
    /// this replaced was indistinguishable across three unrelated causes.
    private var setupChecklist: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Not connected yet")
                .font(.system(size: 13, weight: .semibold))

            VStack(alignment: .leading, spacing: 7) {
                step(
                    done: bridge.extensionFound,
                    title: bridge.extensionFound
                        ? "Extension loaded in \(bridge.browsersWithExtension.map(\.browser.name).joined(separator: ", "))"
                        : bridge.browsersNeedingReload.isEmpty
                            ? "Load the extension in your browser"
                            : "Reload the extension in \(bridge.browsersNeedingReload.map(\.browser.name).joined(separator: ", "))"
                )
                step(
                    done: bridge.bridgeInstalled,
                    title: bridge.bridgeInstalled
                        ? "Bridge installed"
                        : "Bridge installs itself once the extension is loaded"
                )
                step(
                    done: false,
                    title: bridge.bridgeInstalled
                        ? "Waiting for the extension to reconnect…"
                        : "Waiting"
                )
            }

            if !bridge.extensionFound {
                HStack(spacing: 8) {
                    Button("Open Extensions") { bridge.openExtensionsPage() }
                    if HostInstaller.extensionSourcePath() != nil {
                        Button("Reveal Folder") { bridge.revealExtensionFolder() }
                    }
                }
                .controlSize(.small)

                Text(
                    bridge.browsersNeedingReload.isEmpty
                        ? "Turn on Developer mode, choose Load unpacked, and pick the revealed folder. The bridge installs itself the moment it appears."
                        : "Pull Deck is loaded, but under an id from before the id was pinned — Chromium keeps whatever id an extension had when it was loaded. Press the reload arrow on its card and this sorts itself out."
                )
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            } else if bridge.bridgeInstalled {
                Text(
                    "If this persists, open the extension and use Retry now — it may still be waiting out a backoff."
                )
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 16)
    }

    private func step(done: Bool, title: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? accent : Color.secondary)
                .font(.system(size: 11))
            Text(title)
                .font(.system(size: 11.5))
                .foregroundStyle(done ? Color.primary : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Notices

    private func notice(symbol: String, title: String, body: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 22)).foregroundStyle(.secondary)
            Text(title).font(.system(size: 13, weight: .semibold))
            Text(body)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 34)
    }

    private func age(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: iso) else { return "" }
        let seconds = max(0, Date().timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
        if seconds < 604_800 { return "\(Int(seconds / 86_400))d" }
        return "\(Int(seconds / 604_800))w"
    }
}
