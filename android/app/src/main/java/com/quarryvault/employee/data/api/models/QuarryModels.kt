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
    val canDownload: Boolean = false,
    @SerialName("can_delete")
    val canDelete: Boolean = false
)

@Serializable
data class Quarry(
    val id: String,
    val name: String,
    val status: String = "active",
    val permissions: QuarryPermission = QuarryPermission(),
    @SerialName("quarry_number")
    val quarryNumber: String? = null,
    @SerialName("quarry_type")
    val quarryType: String? = null,
    @SerialName("display_name")
    val displayName: String? = null
) {
    val displayNameFormatted: String
        get() = displayName ?: if (!quarryNumber.isNullOrBlank() && !quarryType.isNullOrBlank()) {
            "$name - رقم $quarryNumber ($quarryType)"
        } else if (!quarryNumber.isNullOrBlank()) {
            "$name - رقم $quarryNumber"
        } else {
            name
        }
}

@Serializable
data class Folder(
    val id: String,
    @SerialName("quarry_id")
    val quarryId: String,
    @SerialName("parent_id")
    val parentId: String? = null,
    val name: String,
    @SerialName("is_standard")
    val isStandard: Boolean = false,
    @SerialName("standard_order")
    val standardOrder: Int? = null,
    @SerialName("standard_key")
    val standardKey: String? = null,
    val version: Int = 1,
    @SerialName("created_at")
    val createdAt: String? = null,
    @SerialName("updated_at")
    val updatedAt: String? = null
)

@Serializable
data class CreateFolderRequest(
    val name: String,
    @SerialName("parent_id")
    val parentId: String? = null
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
    @SerialName("uploaded_by_name")
    val uploadedByName: String? = null,
    @SerialName("folder_name")
    val folderName: String? = null,
    @SerialName("quarry_name")
    val quarryName: String? = null,
    val version: Int = 1,
    @SerialName("created_at")
    val createdAt: String
)

@Serializable
data class RenameDocumentRequest(
    val name: String
)

@Serializable
data class CreateQuarryRequest(
    val name: String,
    @SerialName("quarry_number")
    val quarryNumber: String = "",
    @SerialName("quarry_type")
    val quarryType: String = ""
)

@Serializable
data class TrashDocument(
    val id: String,
    @SerialName("quarry_id")
    val quarryId: String,
    @SerialName("quarry_name")
    val quarryName: String? = null,
    @SerialName("folder_id")
    val folderId: String? = null,
    @SerialName("folder_name")
    val folderName: String? = null,
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
    @SerialName("deleted_by_name")
    val deletedByName: String? = null,
    @SerialName("can_restore")
    val canRestore: Boolean = true,
    @SerialName("retention_expires_at")
    val retentionExpiresAt: String
)

data class DownloadedDocumentPayload(
    val bytes: ByteArray,
    val filename: String,
    val contentType: String? = null,
    val contentLength: Long? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as DownloadedDocumentPayload
        if (!bytes.contentEquals(other.bytes)) return false
        if (filename != other.filename) return false
        if (contentType != other.contentType) return false
        if (contentLength != other.contentLength) return false
        return true
    }

    override fun hashCode(): Int {
        var result = bytes.contentHashCode()
        result = 31 * result + filename.hashCode()
        result = 31 * result + (contentType?.hashCode() ?: 0)
        result = 31 * result + (contentLength?.hashCode() ?: 0)
        return result
    }
}
