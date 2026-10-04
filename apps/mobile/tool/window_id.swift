// Prints the CGWindowID of the largest on-screen window owned by the named app (for screencapture -l).
//   swiftc tool/window_id.swift -o /tmp/window_id && /tmp/window_id Waypack
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.dropFirst().first ?? "Waypack"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let best = list
  .filter { ($0[kCGWindowOwnerName as String] as? String) == owner && ($0[kCGWindowLayer as String] as? Int) == 0 }
  .max { a, b in
    let ra = a[kCGWindowBounds as String] as? [String: CGFloat] ?? [:], rb = b[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
    return (ra["Width"] ?? 0) * (ra["Height"] ?? 0) < (rb["Width"] ?? 0) * (rb["Height"] ?? 0)
  }
guard let id = best?[kCGWindowNumber as String] as? Int else { exit(1) }
print(id)
