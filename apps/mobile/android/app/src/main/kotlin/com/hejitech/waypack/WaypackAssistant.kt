package com.hejitech.waypack

// The offline trip assistant's model bridge on Android: Gemini Nano via ML Kit's GenAI Prompt API
// (AICore), DECISIONS #49. Same channel protocol as iOS/macOS (WaypackAssistant.swift):
//   waypack/assistant         status | download | generate {id, instructions, prompt, temperature, maxTokens} | cancel {id}
//   waypack/assistant/events  {id, type: text|done|error, text?, code?, message?} and {type: download, bytes?, total?, done?, error?}

import android.os.Handler
import android.os.Looper
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class WaypackAssistant(messenger: BinaryMessenger) : EventChannel.StreamHandler {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val main = Handler(Looper.getMainLooper())
    private var sink: EventChannel.EventSink? = null
    private val jobs = mutableMapOf<String, Job>()
    private var model: GenerativeModel? = null
    private var totalBytes = 0L

    init {
        MethodChannel(messenger, "waypack/assistant").setMethodCallHandler { call, result ->
            val args = (call.arguments as? Map<*, *>) ?: emptyMap<String, Any>()
            when (call.method) {
                "status" -> scope.launch {
                    val status = status()
                    main.post { result.success(status) }
                }
                "download" -> {
                    download()
                    result.success(null)
                }
                "generate" -> {
                    val id = args["id"] as? String
                    val prompt = args["prompt"] as? String
                    if (id == null || prompt == null) {
                        result.error("bad_args", "id and prompt are required", null)
                    } else {
                        generate(
                            id,
                            args["instructions"] as? String ?: "",
                            prompt,
                            (args["temperature"] as? Number)?.toFloat() ?: 0.3f,
                            (args["maxTokens"] as? Number)?.toInt() ?: 350,
                        )
                        result.success(null)
                    }
                }
                "cancel" -> {
                    (args["id"] as? String)?.let { jobs.remove(it)?.cancel() }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        EventChannel(messenger, "waypack/assistant/events").setStreamHandler(this)
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) { sink = events }
    override fun onCancel(arguments: Any?) { sink = null }

    private fun send(event: Map<String, Any?>) = main.post { sink?.success(event) }

    private fun client(): GenerativeModel = model ?: Generation.getClient().also { model = it }

    private suspend fun status(): Map<String, Any?> = try {
        when (client().checkStatus()) {
            // No tool calling in the Prompt API: Dart pre-fills search results instead.
            FeatureStatus.AVAILABLE -> mapOf("engine" to "gemini-nano", "state" to "available", "tools" to false)
            FeatureStatus.DOWNLOADABLE -> mapOf("engine" to "gemini-nano", "state" to "downloadable")
            FeatureStatus.DOWNLOADING -> mapOf("engine" to "gemini-nano", "state" to "downloading")
            else -> mapOf("engine" to "gemini-nano", "state" to "unavailable", "reason" to "unsupportedDevice")
        }
    } catch (e: Exception) {
        // No AICore / unsupported device / unlocked bootloader.
        mapOf("engine" to "gemini-nano", "state" to "unavailable", "reason" to "aicoreUnavailable")
    }

    private fun download() {
        scope.launch {
            try {
                client().download().collect { s ->
                    when (s) {
                        is DownloadStatus.DownloadStarted -> {
                            totalBytes = s.bytesToDownload
                            send(mapOf("type" to "download", "bytes" to 0L, "total" to totalBytes))
                        }
                        is DownloadStatus.DownloadProgress ->
                            send(mapOf("type" to "download", "bytes" to s.totalBytesDownloaded, "total" to totalBytes))
                        is DownloadStatus.DownloadFailed ->
                            send(mapOf("type" to "download", "error" to (s.e.message ?: "download failed")))
                        else -> send(mapOf("type" to "download", "done" to true, "bytes" to totalBytes, "total" to totalBytes))
                    }
                }
            } catch (e: Exception) {
                send(mapOf("type" to "download", "error" to (e.message ?: "download failed")))
            }
        }
    }

    private fun generate(id: String, instructions: String, prompt: String, temperature: Float, maxTokens: Int) {
        jobs[id] = scope.launch {
            var text = ""
            try {
                val m = client()
                // System instructions need Gemini Nano v3+; older models get them at the top of the prompt.
                val system = instructions.isNotBlank() && runCatching { m.isSystemPromptAvailable() }.getOrDefault(false)
                val body = if (system || instructions.isBlank()) prompt else "$instructions\n\n$prompt"
                val request = if (system) {
                    generateContentRequest(SystemInstruction(instructions), TextPart(body)) {
                        this.temperature = temperature
                        this.maxOutputTokens = maxTokens
                    }
                } else {
                    generateContentRequest(TextPart(body)) {
                        this.temperature = temperature
                        this.maxOutputTokens = maxTokens
                    }
                }
                m.generateContentStream(request).collect { chunk ->
                    val piece = chunk.candidates.firstOrNull()?.text ?: return@collect
                    // Chunks are deltas; tolerate a model that resends the whole text.
                    text = if (text.isNotEmpty() && piece.startsWith(text)) piece else text + piece
                    send(mapOf("id" to id, "type" to "text", "text" to text))
                }
                send(mapOf("id" to id, "type" to "done", "text" to text))
            } catch (e: CancellationException) {
                send(mapOf("id" to id, "type" to "done", "text" to text))
            } catch (e: Exception) {
                val d = (e.message ?: e.toString()).lowercase()
                val code = when {
                    "token" in d || "too long" in d || "context" in d -> "context"
                    "busy" in d || "quota" in d || "background" in d -> "busy"
                    "safety" in d || "blocked" in d -> "guardrail"
                    else -> "failed"
                }
                send(mapOf("id" to id, "type" to "error", "code" to code, "message" to (e.message ?: "The assistant stopped.")))
            } finally {
                jobs.remove(id)
            }
        }
    }

    fun close() {
        scope.cancel()
        model?.close()
    }
}
