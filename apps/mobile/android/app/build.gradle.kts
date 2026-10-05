plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.hejitech.waypack"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications needs java.time on older Android.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        applicationId = "com.hejitech.waypack"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // 26: ML Kit's GenAI Prompt API (Gemini Nano, the offline assistant) needs Android 8.0+.
        minSdk = maxOf(flutter.minSdkVersion, 26)
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    // Offline trip assistant: Gemini Nano through AICore (MainActivity.kt, DECISIONS #49).
    implementation("com.google.mlkit:genai-prompt:1.0.0-beta4")
    // Phones without Gemini Nano: Qwen3-1.7B on LiteRT-LM (WaypackLocalModel.kt, DECISIONS #53).
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.17.1")
    // 1.11: litertlm-android is built against it (its POM has claimed older versions before).
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}
