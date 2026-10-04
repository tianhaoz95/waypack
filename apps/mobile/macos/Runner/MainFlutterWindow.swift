import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    // Default size (MainMenu.xib, 1280×832) is wide enough for the plan's desktop layout
    // (side rail + map from 1100pt); narrower windows get the tablet and phone layouts.
    self.minSize = NSSize(width: 420, height: 640)
    self.title = "Waypack"
    // Reopen where the user left it; first launch is centered.
    if !self.setFrameUsingName("WaypackMain") { self.center() }
    self.setFrameAutosaveName("WaypackMain")

    RegisterGeneratedPlugins(registry: flutterViewController)
    WaypackAssistant.register(messenger: flutterViewController.registrar(forPlugin: "WaypackAssistant").messenger)

    super.awakeFromNib()
  }
}
