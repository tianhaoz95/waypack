package com.hejitech.waypack

// The offline assistant's downloadable model for Android phones without Gemini Nano: Qwen3-1.7B
// (int4) on LiteRT-LM, DECISIONS #53. Same channel protocol as WaypackAssistant.kt, on its own
// channels so Dart can try Gemini Nano first and fall back to this:
//   waypack/assistant/litert         status | download | generate {id, instructions, prompt, temperature, maxTokens} | cancel {id}
//   waypack/assistant/litert/events  {id, type: text|done|error, ...} and {type: download, bytes?, total?, done?, error?}

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class WaypackLocalModel(private val context: Context, messenger: BinaryMessenger) : EventChannel.StreamHandler {
    companion object {
        // Pinned to a Hugging Face commit so the file can't change under the hash (Apache 2.0).
        private const val URL_ =
            "https://huggingface.co/litert-community/Qwen3-1.7B/resolve/73fbc3fe8271c162a603ee66f6e7ed25b6211195/Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm"
        private const val SIZE = 977_184_032L
        private const val SHA256 = "2eeffef7b51bc3e1225ea69fe7aa5f417397934b56a5b6c20cc068d6fd2c918b"
        private const val FILE = "qwen3-1.7b-int4.litertlm"

        // The model takes ~1.5 GB of memory while answering; below this the system would kill apps.
        private const val MIN_RAM = 5_500_000_000L
        private const val IDLE_CLOSE_MS = 3 * 60_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val main = Handler(Looper.getMainLooper())
    private var sink: EventChannel.EventSink? = null
    private val jobs = mutableMapOf<String, Job>()
    private val conversations = mutableMapOf<String, Conversation>()
    private var downloadJob: Job? = null
    private var engine: Engine? = null
    private val engineLock = Mutex()
    private var idleClose: Job? = null

    private val dir get() = File(context.filesDir, "models").apply { mkdirs() }
    private val model get() = File(dir, FILE)
    private val partial get() = File(dir, "$FILE.part")

    init {
        MethodChannel(messenger, "waypack/assistant/litert").setMethodCallHandler { call, result ->
            val args = (call.arguments as? Map<*, *>) ?: emptyMap<String, Any>()
            when (call.method) {
                "status" -> result.success(status())
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
                            (args["temperature"] as? Number)?.toDouble() ?: 0.3,
                            (args["maxTokens"] as? Number)?.toInt() ?: 350,
                        )
                        result.success(null)
                    }
                }
                "cancel" -> {
                    (args["id"] as? String)?.let { id ->
                        conversations[id]?.let { runCatching { it.cancelProcess() } }
                        jobs.remove(id)?.cancel()
                    }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        EventChannel(messenger, "waypack/assistant/litert/events").setStreamHandler(this)
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) { sink = events }
    override fun onCancel(arguments: Any?) { sink = null }

    private fun send(event: Map<String, Any?>) = main.post { sink?.success(event) }

    private fun status(): Map<String, Any?> {
        val base = mapOf("engine" to "litert-qwen", "bytes" to SIZE)
        // The native runtime ships for arm64 (and x86_64 emulators); older 32-bit phones are too small anyway.
        val abi = Build.SUPPORTED_64_BIT_ABIS.any { it == "arm64-v8a" || it == "x86_64" }
        val mem = ActivityManager.MemoryInfo().also {
            (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it)
        }
        return when {
            model.length() == SIZE -> base + mapOf("state" to "available", "tools" to false)
            downloadJob?.isActive == true -> base + mapOf("state" to "downloading")
            !abi || mem.totalMem < MIN_RAM -> base + mapOf("state" to "unavailable", "reason" to "deviceTooSmall")
            else -> base + mapOf("state" to "downloadable")
        }
    }

    /** Resumable (HTTP Range), verified by SHA-256 before it's used. */
    private fun download() {
        if (downloadJob?.isActive == true || model.length() == SIZE) return
        downloadJob = scope.launch(Dispatchers.IO) {
            try {
                if (partial.length() > SIZE) partial.delete()
                val need = SIZE - partial.length() + 100_000_000L
                if (StatFs(dir.path).availableBytes < need) {
                    send(mapOf("type" to "download", "error" to "Not enough free space: the model needs about 1.1 GB."))
                    return@launch
                }
                var have = partial.length()
                if (have < SIZE) {
                    val c = URL(URL_).openConnection() as HttpURLConnection
                    c.connectTimeout = 20_000
                    c.readTimeout = 30_000
                    if (have > 0) c.setRequestProperty("Range", "bytes=$have-")
                    val code = c.responseCode
                    if (code !in listOf(200, 206)) throw IllegalStateException("HTTP $code")
                    if (code == 200) have = 0 // server ignored the range: start over
                    c.inputStream.use { input ->
                        FileOutputStream(partial, code == 206).use { out ->
                            val buf = ByteArray(1 shl 16)
                            var last = 0L
                            while (true) {
                                ensureActive()
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                have += n
                                if (have - last >= 4_000_000L) {
                                    last = have
                                    send(mapOf("type" to "download", "bytes" to have, "total" to SIZE))
                                }
                            }
                        }
                    }
                }
                if (partial.length() != SIZE || sha256(partial) != SHA256) {
                    partial.delete()
                    throw IllegalStateException("the downloaded model was damaged, try again")
                }
                partial.renameTo(model)
                send(mapOf("type" to "download", "done" to true, "bytes" to SIZE, "total" to SIZE))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The partial file stays, so the next try resumes.
                send(mapOf("type" to "download", "error" to (e.message ?: "download failed")))
            }
        }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(1 shl 20)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Loads the model once (several seconds); the GPU when the phone has one LiteRT can use, else the CPU. */
    private suspend fun engine(): Engine = engineLock.withLock {
        idleClose?.cancel()
        engine ?: run {
            fun make(backend: Backend) = Engine(
                EngineConfig(
                    modelPath = model.path,
                    backend = backend,
                    maxNumTokens = 4096,
                    cacheDir = context.cacheDir.path,
                ),
            ).also { it.initialize() }
            (runCatching { make(Backend.GPU()) }.getOrNull() ?: make(Backend.CPU())).also { engine = it }
        }
    }

    /** Frees the model's memory once the traveler has stopped asking for a while. */
    private fun scheduleIdleClose() {
        idleClose?.cancel()
        idleClose = scope.launch {
            delay(IDLE_CLOSE_MS)
            engineLock.withLock {
                if (jobs.isEmpty()) {
                    engine?.close()
                    engine = null
                }
            }
        }
    }

    private fun generate(id: String, instructions: String, prompt: String, temperature: Double, maxTokens: Int) {
        jobs[id] = scope.launch(Dispatchers.IO) {
            var text = ""
            try {
                if (model.length() != SIZE) throw IllegalStateException("model not downloaded")
                val conversation = engine().createConversation(
                    ConversationConfig(
                        samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = temperature, seed = 0),
                        maxOutputToken = maxTokens,
                        // Qwen3 thinks out loud by default: slow, and the traveler would see it.
                        thinkingConfig = ThinkingConfig(false),
                    ),
                )
                conversations[id] = conversation
                // This model's chat template rejects a separate system message, so the instructions
                // go first in the user's turn (the eval showed the same answers either way).
                val body = if (instructions.isBlank()) prompt else "$instructions\n\n$prompt"
                conversation.use { conv ->
                    conv.sendMessageAsync(body).collect { m: Message ->
                        val piece = m.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }
                        if (piece.isEmpty()) return@collect
                        text += piece
                        send(mapOf("id" to id, "type" to "text", "text" to clean(text)))
                    }
                }
                send(mapOf("id" to id, "type" to "done", "text" to clean(text)))
            } catch (e: CancellationException) {
                send(mapOf("id" to id, "type" to "done", "text" to clean(text)))
            } catch (e: Throwable) {
                val d = (e.message ?: e.toString()).lowercase()
                val code = when {
                    "token" in d || "too long" in d || "context" in d -> "context"
                    e is OutOfMemoryError || "memory" in d -> "busy"
                    else -> "failed"
                }
                send(
                    mapOf(
                        "id" to id, "type" to "error", "code" to code,
                        "message" to "The assistant stopped.", "detail" to (e.message ?: e.toString()),
                    ),
                )
            } finally {
                conversations.remove(id)
                jobs.remove(id)
                scheduleIdleClose()
            }
        }
    }

    /** Drops an empty or unfinished thinking block if the template lets one through. */
    private fun clean(s: String): String =
        s.replace(Regex("(?s)<think>.*?(</think>|$)"), "").trimStart()

    fun close() {
        scope.cancel()
        engine?.close()
        engine = null
    }
}
