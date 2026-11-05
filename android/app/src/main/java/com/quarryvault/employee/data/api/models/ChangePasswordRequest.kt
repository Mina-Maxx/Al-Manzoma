package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ChangePasswordRequest(
    @SerialName("new_password")
    val newPassword: String,
    @SerialName("confirm_password")
    val confirmPassword: String,
    @SerialName("current_password")
    val currentPassword: String? = null
)
