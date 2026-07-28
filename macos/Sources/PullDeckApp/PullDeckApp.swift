import SwiftUI
import AppKit
import PullDeckKit

@main
struct PullDeckApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var bridge = BridgeServer.shared

    var body: some Scene {
        // .window rather than .menu: this is a panel with a list, a segmented
        // control and a primary action, not a column of menu items.
        MenuBarExtra {
            MenuContent(bridge: bridge)
        } label: {
            // The label tells the truth at a glance: hollow icon when Chrome is
            // not attached, with the open count when it is.
            HStack(spacing: 3) {
                Image(systemName: bridge.isAttached ? "rectangle.stack.fill" : "rectangle.stack")
                if bridge.isAttached, bridge.badgeCount > 0 {
                    Text("\(bridge.badgeCount)")
                }
            }
        }
        .menuBarExtraStyle(.window)
    }
}

/// Owns startup and shutdown. The socket has to exist from launch, not from the
/// first time the panel is opened, or the extension has nothing to connect to.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        BridgeServer.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        BridgeServer.shared.stop()
    }
}
