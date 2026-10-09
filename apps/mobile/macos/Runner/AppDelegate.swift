import Cocoa
import FlutterMacOS
import Sparkle

@main
class AppDelegate: FlutterAppDelegate {
  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}

/// Sparkle auto-updates for the direct-download (GitHub Releases) build. The feed URL and public key
/// are in Info.plist; tool/release_mac.sh publishes the signed Waypack.zip + appcast.xml.
/// Settings talks to it over the "waypack/updater" channel; the app menu gets "Check for Updates…".
final class WaypackUpdater: NSObject {
  static let shared = WaypackUpdater()
  private var controller: SPUStandardUpdaterController?

  /// Debug builds aren't signed or numbered like releases, so they never update themselves.
  var isEnabled: Bool {
    #if DEBUG
    return false
    #else
    return true
    #endif
  }

  func start(messenger: FlutterBinaryMessenger) {
    if isEnabled && controller == nil {
      controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
      // The menu bar is loaded from MainMenu.xib after the window; add the item once it exists.
      DispatchQueue.main.async { self.addMenuItem() }
    }
    let channel = FlutterMethodChannel(name: "waypack/updater", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      let updater = self.controller?.updater
      switch call.method {
      case "info":
        let info = Bundle.main.infoDictionary ?? [:]
        result([
          "enabled": updater != nil,
          "version": info["CFBundleShortVersionString"] as? String ?? "",
          "build": info["CFBundleVersion"] as? String ?? "",
          "automatic": updater?.automaticallyChecksForUpdates ?? false,
          "lastCheck": updater?.lastUpdateCheckDate.map { $0.timeIntervalSince1970 * 1000 } as Any,
        ])
      case "setAutomatic":
        updater?.automaticallyChecksForUpdates = (call.arguments as? Bool) ?? true
        result(nil)
      case "check":
        self.controller?.checkForUpdates(nil)
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func addMenuItem() {
    guard let controller, let appMenu = NSApp.mainMenu?.items.first?.submenu,
          !appMenu.items.contains(where: { $0.action == #selector(SPUStandardUpdaterController.checkForUpdates(_:)) })
    else { return }
    let item = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
    item.target = controller
    // Right after "About Waypack".
    appMenu.insertItem(item, at: min(1, appMenu.items.count))
  }
}
