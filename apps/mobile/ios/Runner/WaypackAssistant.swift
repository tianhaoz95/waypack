// The offline trip assistant's model bridge: Apple Foundation Models (DECISIONS #49).
// Same channel protocol as Android (MainActivity.kt) and macOS (MainFlutterWindow.swift):
//   waypack/assistant         status | generate {id, instructions, prompt, temperature, maxTokens, tools} | cancel {id} | download
//                             (native → Dart) search {id, query} → String, when the model calls the searchPlan tool
//   waypack/assistant/events  {id, type: text|done|error, text?, code?, message?}
// This file is shared by the iOS and macOS targets.
import Foundation
#if os(iOS)
import Flutter
#else
import FlutterMacOS
#endif
#if canImport(FoundationModels)
import FoundationModels
#endif

#if canImport(FoundationModels)
/// Lets the model look things up in the whole trip plan (the search itself runs in Dart:
/// lib/assistant/plan_index.dart), so answers aren't limited to what fit in the prompt.
@available(iOS 26.0, macOS 26.0, *)
struct SearchPlanTool: Tool {
  let name = "searchPlan"
  let description = "Searches the traveler's full trip plan (places, schedule, notes and the trip page) and returns the best matching entries."

  @Generable
  struct Arguments {
    @Guide(description: "What to look for, in a few words, e.g. \"Wuksachi Lodge phone\" or \"backup plan if Wolverton is closed\"")
    var query: String
  }

  let search: @Sendable (String) async -> String

  func call(arguments: Arguments) async throws -> String {
    await search(arguments.query)
  }
}
#endif

final class WaypackAssistant: NSObject, FlutterStreamHandler {
  private var methods: FlutterMethodChannel?
  private var sink: FlutterEventSink?
  private var tasks: [String: Task<Void, Never>] = [:]
  private static var shared: WaypackAssistant?

  static func register(messenger: FlutterBinaryMessenger) {
    let me = WaypackAssistant()
    shared = me
    let methods = FlutterMethodChannel(name: "waypack/assistant", binaryMessenger: messenger)
    me.methods = methods
    methods.setMethodCallHandler { call, result in me.handle(call, result) }
    FlutterEventChannel(name: "waypack/assistant/events", binaryMessenger: messenger).setStreamHandler(me)
  }

  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    sink = events
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    sink = nil
    return nil
  }

  private func send(_ event: [String: Any]) {
    DispatchQueue.main.async { self.sink?(event) }
  }

  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "status":
      result(status())
    case "generate":
      guard let id = args["id"] as? String, let prompt = args["prompt"] as? String else {
        result(FlutterError(code: "bad_args", message: "id and prompt are required", details: nil))
        return
      }
      generate(
        id: id,
        instructions: args["instructions"] as? String ?? "",
        prompt: prompt,
        temperature: args["temperature"] as? Double ?? 0.3,
        maxTokens: args["maxTokens"] as? Int ?? 350,
        tools: args["tools"] as? Bool ?? false)
      result(nil)
    case "cancel":
      if let id = args["id"] as? String {
        tasks[id]?.cancel()
        tasks[id] = nil
      }
      result(nil)
    case "download":
      // Apple manages its own model downloads (Settings > Apple Intelligence).
      send(["type": "download", "done": true])
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func status() -> [String: Any] {
    #if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      switch SystemLanguageModel.default.availability {
      case .available:
        return ["engine": "apple-foundation", "state": "available", "tools": true]
      case .unavailable(let reason):
        let why: String
        switch reason {
        case .deviceNotEligible: why = "deviceNotEligible"
        case .appleIntelligenceNotEnabled: why = "appleIntelligenceNotEnabled"
        case .modelNotReady: why = "modelNotReady"
        @unknown default: why = "unavailable"
        }
        return ["engine": "apple-foundation", "state": "unavailable", "reason": why]
      }
    }
    #endif
    return ["engine": "apple-foundation", "state": "unavailable", "reason": "osTooOld"]
  }

  /// Asks Dart to search the plan for the model (runs on the main thread, as channels require).
  private func search(id: String, query: String) async -> String {
    await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
      DispatchQueue.main.async {
        guard let methods = self.methods else { return cont.resume(returning: "") }
        methods.invokeMethod("search", arguments: ["id": id, "query": query]) { result in
          cont.resume(returning: (result as? String) ?? "Nothing found.")
        }
      }
    }
  }

  private func generate(id: String, instructions: String, prompt: String, temperature: Double, maxTokens: Int, tools: Bool) {
    #if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      tasks[id] = Task { [weak self] in
        guard let self else { return }
        let session = tools
          ? LanguageModelSession(
            tools: [SearchPlanTool(search: { [weak self] q in await self?.search(id: id, query: q) ?? "" })],
            instructions: instructions)
          : LanguageModelSession(instructions: instructions)
        let options = GenerationOptions(temperature: temperature, maximumResponseTokens: maxTokens)
        var last = ""
        do {
          for try await snapshot in session.streamResponse(to: prompt, options: options) {
            if Task.isCancelled { break }
            last = snapshot.content
            self.send(["id": id, "type": "text", "text": last])
          }
          self.send(["id": id, "type": "done", "text": last])
        } catch is CancellationError {
          self.send(["id": id, "type": "done", "text": last])
        } catch {
          // Classified by name so this compiles against both the iOS 26 and 27 error types.
          let d = String(describing: error)
          let code =
            d.contains("ontext") ? "context"
            : d.contains("guardrail") ? "guardrail"
            : d.contains("nsupportedLanguage") || d.contains("ocale") ? "locale"
            : d.contains("ateLimit") || d.contains("oncurrent") ? "busy"
            : d.contains("assetsUnavailable") ? "assets"
            : "failed"
          self.send(["id": id, "type": "error", "code": code, "message": error.localizedDescription, "detail": d])
        }
        self.tasks[id] = nil
      }
      return
    }
    #endif
    send(["id": id, "type": "error", "code": "unavailable", "message": "On-device AI needs iOS 26 or macOS 26 or later."])
  }
}
