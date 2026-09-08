// swift-tools-version: 5.9
import PackageDescription

// Test executables run with SwiftPM and Command Line Tools without XCTest setup.
let package = Package(
    name: "PullDeck",
    platforms: [.macOS(.v13)], // MenuBarExtra is macOS 13+
    products: [
        .executable(name: "pulldeck-bridge", targets: ["PullDeckBridge"]),
        .executable(name: "pulldeck-selftest", targets: ["PullDeckSelfTest"]),
        .executable(name: "pulldeck-runtime-test", targets: ["PullDeckRuntimeTest"]),
        .executable(name: "PullDeckApp", targets: ["PullDeckApp"]),
    ],
    targets: [
        .target(name: "PullDeckKit"),
        .executableTarget(name: "PullDeckBridge", dependencies: ["PullDeckKit"]),
        .executableTarget(name: "PullDeckSelfTest", dependencies: ["PullDeckKit"]),
        .target(name: "PullDeckRuntime", dependencies: ["PullDeckKit"]),
        .executableTarget(name: "PullDeckApp", dependencies: ["PullDeckKit", "PullDeckRuntime"]),
        .executableTarget(name: "PullDeckRuntimeTest", dependencies: ["PullDeckKit", "PullDeckRuntime"]),
    ]
)
