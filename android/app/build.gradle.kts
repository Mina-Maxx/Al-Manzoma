import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

data class AppVersion(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val code: Int,
    val name: String
)

fun isApkBuildRequested(taskNames: List<String>): Boolean {
    if (taskNames.isEmpty()) return false
    val apkTriggers = listOf("assemble", "package", "bundle", "install", "build")
    return taskNames.any { raw ->
        val task = raw.lowercase()
        val hasApkTrigger = apkTriggers.any { task.contains(it) }
        val isUnitTest = task.contains("unittest") || task.contains("androidtest") ||
                         task.startsWith("test") || task.endsWith("test")
        hasApkTrigger && !isUnitTest
    }
}

fun resolveAppVersion(): AppVersion {
    val sessionKey = "QUARRYVAULT_APP_VERSION_RESOLVED"
    val extra = rootProject.extensions.extraProperties
    if (extra.has(sessionKey)) {
        return extra.get(sessionKey) as AppVersion
    }

    val versionFile = rootProject.file("version.properties")
    val lockFile = rootProject.file(".gradle/version.lock")
    if (!lockFile.parentFile.exists()) {
        lockFile.parentFile.mkdirs()
    }

    val taskNames = gradle.startParameter.taskNames
    val shouldIncrement = isApkBuildRequested(taskNames)
    val maxVersionCode = 2_100_000_000

    val raf = RandomAccessFile(lockFile, "rw")
    var lock: FileLock? = null
    val resolved = try {
        lock = raf.channel.lock()

        val props = Properties()
        if (versionFile.exists()) {
            versionFile.inputStream().use { props.load(it) }
        }

        val major = (props.getProperty("version.major") ?: "1").toIntOrNull() ?: 1
        val minor = (props.getProperty("version.minor") ?: "0").toIntOrNull() ?: 0
        val patch = (props.getProperty("version.patch") ?: "0").toIntOrNull() ?: 0
        var currentCode = (props.getProperty("version.code") ?: "1").toIntOrNull() ?: 1
        if (currentCode < 1) currentCode = 1

        val newCode = if (shouldIncrement) {
            if (currentCode >= maxVersionCode) {
                throw IllegalStateException("Maximum Android versionCode limit ($maxVersionCode) reached.")
            }
            currentCode + 1
        } else {
            currentCode
        }

        val customName = props.getProperty("version.name")?.trim()
        val versionName = if (!customName.isNullOrEmpty()) {
            if (customName.contains("{code}")) {
                customName.replace("{code}", newCode.toString())
            } else {
                customName
            }
        } else {
            "$major.$minor.$newCode"
        }

        if (shouldIncrement) {
            props.setProperty("version.major", major.toString())
            props.setProperty("version.minor", minor.toString())
            props.setProperty("version.patch", patch.toString())
            props.setProperty("version.code", newCode.toString())
            versionFile.outputStream().use {
                props.store(it, "Auto-incremented on actual APK build")
            }
            println("[QuarryVault Versioning] Auto-incremented versionCode to $newCode (versionName: $versionName) for tasks: $taskNames")
        } else {
            println("[QuarryVault Versioning] Non-APK task ($taskNames). Preserving versionCode at $newCode (versionName: $versionName)")
        }

        AppVersion(major, minor, patch, newCode, versionName)
    } finally {
        try { lock?.release() } catch (_: Exception) {}
        try { raf.close() } catch (_: Exception) {}
    }

    extra.set(sessionKey, resolved)
    return resolved
}

val currentAppVersion = resolveAppVersion()

val localProperties = Properties().apply {
    val localFile = rootProject.file("local.properties")
    if (localFile.exists()) {
        localFile.inputStream().use { load(it) }
    }
}
val configuredDebugBackendUrl = localProperties.getProperty("backend.base.url")
    ?: System.getenv("BACKEND_BASE_URL")
    ?: "http://192.168.1.8:8000"

android {
    namespace = "com.quarryvault.employee"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.quarryvault.employee"
        minSdk = 26
        targetSdk = 35
        versionCode = currentAppVersion.code
        versionName = currentAppVersion.name

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            // Debug allows local development URL from local.properties/env (defaulting to http://192.168.1.8:8000)
            buildConfigField("String", "DEFAULT_BACKEND_URL", "\"$configuredDebugBackendUrl\"")
        }
        release {
            isMinifyEnabled = true
            // Release uses strict production HTTPS URL; never cleartext HTTP, never 192.168.1.8
            buildConfigField("String", "DEFAULT_BACKEND_URL", "\"https://api.quarryvault.com\"")
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
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.all {
            it.maxHeapSize = "2048m"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)

    // CameraX
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)

    // Networking & Serialization
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)

    // Unit Testing
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)

    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))

    debugImplementation(libs.androidx.ui.tooling)
}
