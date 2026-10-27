package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class QuarryPermission(
    @SerialName("can_view")
    val canView: Boolean = false,
    @SerialName("can_upload")
    val canUpload: Boolean = false,
    @SerialName("can_download")
    val canDownload: Boolean = false
)

@Serializable
data class Quarry(
    val id: String,
    val name: String,
    val status: String,
    val permissions: QuarryPermission = QuarryPermission()
)

@Serializable
data class Folder(
    val id: String,
    @SerialName("quarry_id")
    val quarryId: String,
    @SerialName("parent_id")
    val parentId: String? = null,
    val name: String,
    val version: Int = 1,
    @SerialName("created_at")
    val createdAt: String? = null,
    @SerialName("updated_at")
    val updatedAt: String? = null
)

@Serializable
data class Document(
    val id: String,
    @SerialName("quarry_id")
    val quarryId: String,
    @SerialName("folder_id")
    val folderId: String? = null,
    @SerialName("display_name")
    val displayName: String,
    @SerialName("original_filename")
    val originalFilename: String,
    @SerialName("mime_type")
    val mimeType: String,
    @SerialName("size_bytes")
    val sizeBytes: Long,
    val sha256: String? = null,
    val status: String,
    @SerialName("uploaded_by")
    val uploadedBy: String? = null,
    val version: Int = 1,
    @SerialName("created_at")
    val createdAt: String
)

@Serializable
data class CreateQuarryRequest(
    val name: String
)

@Serializable
data class TrashDocument(
    val id: String,
    @SerialName("quarry_id")
    val quarryId: String,
    @SerialName("folder_id")
    val folderId: String? = null,
    @SerialName("display_name")
    val displayName: String,
    @SerialName("original_filename")
    val originalFilename: String,
    @SerialName("mime_type")
    val mimeType: String,
    @SerialName("size_bytes")
    val sizeBytes: Long,
    val version: Int = 1,
    @SerialName("created_at")
    val createdAt: String,
    @SerialName("deleted_at")
    val deletedAt: String,
    @SerialName("deleted_by")
    val deletedBy: String? = null,
    @SerialName("can_restore")
    val canRestore: Boolean = true,
    @SerialName("retention_expires_at")
    val retentionExpiresAt: String
)
