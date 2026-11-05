package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class GeneralPermissionsPayload(
    @SerialName("can_view") val canView: Boolean = true,
    @SerialName("can_upload") val canUpload: Boolean = true,
    @SerialName("can_download") val canDownload: Boolean = true,
    @SerialName("can_delete") val canDelete: Boolean = false
)

@Serializable
data class CompanyEmployee(
    val id: String,
    val username: String? = null,
    val email: String? = null,
    @SerialName("full_name")
    val fullName: String? = null,
    val status: String,
    val role: String,
    @SerialName("must_change_password")
    val mustChangePassword: Boolean = false,
    val permissions: GeneralPermissionsPayload? = null,
    @SerialName("hidden_quarries")
    val hiddenQuarries: List<String> = emptyList()
)

@Serializable
data class QuarryInitialPermissionRequest(
    @SerialName("quarry_id")
    val quarryId: String,
    @SerialName("can_view")
    val canView: Boolean = true,
    @SerialName("can_upload")
    val canUpload: Boolean = false,
    @SerialName("can_download")
    val canDownload: Boolean = false,
    @SerialName("can_delete")
    val canDelete: Boolean = false
)

@Serializable
data class CreateEmployeeRequest(
    val username: String? = null,
    val password: String,
    @SerialName("full_name")
    val fullName: String? = null,
    val email: String? = null,
    @SerialName("company_id")
    val companyId: String? = null,
    val permissions: GeneralPermissionsPayload? = null,
    @SerialName("hidden_quarries")
    val hiddenQuarries: List<String> = emptyList(),
    @SerialName("quarry_permissions")
    val quarryPermissions: List<QuarryInitialPermissionRequest> = emptyList(),
    @SerialName("default_access_all_quarries")
    val defaultAccessAllQuarries: Boolean = false,
    @SerialName("default_can_view")
    val defaultCanView: Boolean = true,
    @SerialName("default_can_upload")
    val defaultCanUpload: Boolean = false,
    @SerialName("default_can_download")
    val defaultCanDownload: Boolean = false,
    @SerialName("default_can_delete")
    val defaultCanDelete: Boolean = false
)

@Serializable
data class CompanyQuarry(
    val id: String,
    val name: String,
    val status: String = "active"
)
