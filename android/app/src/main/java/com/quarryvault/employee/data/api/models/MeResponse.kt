package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class UserOut(
    val id: String,
    val username: String? = null,
    val email: String? = null,
    @SerialName("full_name")
    val fullName: String? = null,
    val status: String,
    val role: String = "employee",
    @SerialName("must_change_password")
    val mustChangePassword: Boolean = false
)

@Serializable
data class CompanyOut(
    val id: String,
    val name: String,
    val status: String,
    @SerialName("quota_bytes")
    val quotaBytes: Long,
    @SerialName("max_users")
    val maxUsers: Int,
    @SerialName("used_bytes")
    val usedBytes: Long
)

@Serializable
data class EffectivePermissions(
    @SerialName("can_view")
    val canView: Boolean = true,
    @SerialName("can_upload")
    val canUpload: Boolean = true,
    @SerialName("can_download")
    val canDownload: Boolean = true,
    @SerialName("can_delete")
    val canDelete: Boolean = false
)

@Serializable
data class MeResponse(
    val user: UserOut,
    val company: CompanyOut,
    val role: String,
    val permissions: EffectivePermissions? = null
)

@Serializable
data class UpdateProfileResponse(
    val user: UserOut,
    val message: String? = null
)
