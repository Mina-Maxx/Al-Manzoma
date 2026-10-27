package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class UserOut(
    val id: String,
    val email: String? = null,
    @SerialName("full_name")
    val fullName: String? = null,
    val status: String
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
data class MeResponse(
    val user: UserOut,
    val company: CompanyOut,
    val role: String
)
