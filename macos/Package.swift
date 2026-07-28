// swift-tools-version: 5.9
import PackageDescription

// Tests are a plain executable rather than a `.testTarget`. XCTest ships only
// with full Xcode, and while swift-testing's Testing.framework is present in
// Command Line Tools it is not on SwiftPM's search path — wiring it up means
// hard-coding an -F flag that would make this package build on exactly one
// machine. `swift run pulldeck-selftest` works anywhere Swift does.
let package = Package(
    name: "PullDeck",
    platforms: [.macOS(.v13)], // MenuBarExtra is macOS 13+
    products: [
        .executable(name: "pulldeck-bridge", targets: ["PullDeckBridge"]),
        .executable(name: "pulldeck-selftest", targets: ["PullDeckSelfTest"]),
        .executable(name: "PullDeckApp", targets: ["PullDeckApp"]),
    ],
    targets: [
        .target(name: "PullDeckKit"),
        .executableTarget(name: "PullDeckBridge", dependencies: ["PullDeckKit"]),
        .executableTarget(name: "PullDeckSelfTest", dependencies: ["PullDeckKit"]),
        .executableTarget(name: "PullDeckApp", dependencies: ["PullDeckKit"]),
    ]
)
