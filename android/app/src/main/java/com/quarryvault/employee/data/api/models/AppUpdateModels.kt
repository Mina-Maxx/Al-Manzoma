package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class AppUpdateManifest(
    @SerialName("version_code")
    val versionCode: Int,
    @SerialName("version_name")
    val versionName: String,
    @SerialName("release_notes")
    val releaseNotes: String? = null,
    @SerialName("minimum_supported_version_code")
    val minimumSupportedVersionCode: Int = 1,
    @SerialName("update_required")
    val updateRequired: Boolean = false,
    @SerialName("update_policy")
    val updatePolicy: String? = null,
    @SerialName("apk_url")
    val apkUrl: String,
    @SerialName("apk_size_bytes")
    val apkSizeBytes: Long,
    val sha256: String,
    @SerialName("published_at")
    val publishedAt: String
)

@Serializable
data class ServerConfig(
    @SerialName("config_version")
    val configVersion: String,
    @SerialName("server_time")
    val serverTime: String,
    @SerialName("minimum_supported_version_code")
    val minimumSupportedVersionCode: Int = 1,
    @SerialName("latest_version_code")
    val latestVersionCode: Int? = null,
    @SerialName("maintenance_mode")
    val maintenanceMode: Boolean = false,
    @SerialName("maintenance_message")
    val maintenanceMessage: String? = null,
    val features: Map<String, Boolean> = emptyMap(),
    val limits: Map<String, Long> = emptyMap()
)
