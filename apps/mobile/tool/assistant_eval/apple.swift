// Runs one assistant request against Apple's on-device model, like the app does.
//   apple <instructions-file> <prompt-file>
import Foundation
import FoundationModels

@main struct Main {
  static func main() async {
    let instructions = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    let prompt = try! String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
    guard case .available = SystemLanguageModel.default.availability else {
      print("UNAVAILABLE: \(SystemLanguageModel.default.availability)")
      exit(2)
    }
    let session = LanguageModelSession(instructions: instructions)
    do {
      // Same options as the app (lib/assistant/engine.dart defaults).
      let r = try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.3, maximumResponseTokens: 350))
      print(r.content)
    } catch {
      print("ERROR: \(error)")
      exit(1)
    }
  }
}
