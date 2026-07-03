import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Firebase Cloud Messaging is wired through the google-services plugin, but the
// plugin hard-fails the build if app/google-services.json is missing. Apply it
// only when the file is present so a clean checkout (or a CI box without the
// FCM project config) still produces a working assembleDebug — the app degrades to
// a no-op FCM path in that case (see FcmService / PushRegistrar).
val hasGoogleServices = file("google-services.json").exists()
if (hasGoogleServices) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "com.jarvis.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.jarvis.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 46
        versionName = "0.14.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }

        // Surfaced to the app so the FCM path can no-op cleanly when Firebase
        // config is absent, and so the device-WS default port lives in one place.
        buildConfigField("boolean", "FCM_ENABLED", hasGoogleServices.toString())
        buildConfigField("int", "DEVICE_PORT", "8796")

        // The vendored Agent Phone code (com.agentphone.*) uses sherpa-onnx for
        // on-device TTS; that AAR ships native libs per-ABI (~14MB each). The phone
        // is arm64, so restrict to arm64-v8a to keep the APK lean.
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // --- Vendored Agent Phone (com.agentphone.*) deps, verbatim from agent-phone ---
    // On-device TTS engine (Piper/VITS via sherpa-onnx); AAR kept out of git
    // (see android/app/libs/ + .gitignore — re-fetch from the sherpa-onnx release).
    implementation(files("libs/sherpa-onnx-1.13.2.aar"))
    // WorkManager: AgentPhoneReconnectWorker reconnects the phone WS after kills.
    implementation("androidx.work:work-runtime:2.9.1")
    // Compose animation-graphics (animated vectors) used by some phone screens.
    implementation("androidx.compose.animation:animation-graphics")

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.fragment.ktx)
    implementation(libs.androidx.navigation.compose)

    // Compose BOM aligns all compose artifact versions.
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.compose.foundation)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // Contract C device WebSocket on :8796 + coroutine glue.
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.play.services)

    // Encrypted handle/secret storage + Ed25519 device identity (Tink).
    implementation(libs.androidx.security.crypto)
    implementation(libs.gson)
    implementation(libs.tink.android)

    // Pairing: CameraX preview + ML Kit barcode (QR) scanning.
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)

    // Biometric gate for 'biometric'-tier approvals / take-over.
    implementation(libs.androidx.biometric)

    // Image loading for chat photo attachments / previews.
    implementation(libs.coil.compose)

    // FCM push (project "the FCM project"). Resolved regardless; the google-services
    // plugin is only applied when google-services.json is present.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
}
