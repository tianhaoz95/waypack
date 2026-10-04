package com.hejitech.waypack

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    private var assistant: WaypackAssistant? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        assistant = WaypackAssistant(flutterEngine.dartExecutor.binaryMessenger)
    }

    override fun onDestroy() {
        assistant?.close()
        super.onDestroy()
    }
}
