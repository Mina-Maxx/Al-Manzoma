package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class SupabasePasswordLoginRequest(
    val email: String,
    val password: String
)

@Serializable
data class SupabaseRefreshTokenRequest(
    @SerialName("refresh_token") val refreshToken: String
)

@Serializable
data class SupabaseTokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "bearer",
    @SerialName("expires_in") val expiresIn: Long = 3600,
    @SerialName("expires_at") val expiresAt: Long? = null,
    @SerialName("refresh_token") val refreshToken: String? = null,
    val user: SupabaseUser? = null
)

@Serializable
data class SupabaseUser(
    val id: String,
    val email: String? = null,
    @SerialName("app_metadata") val appMetadata: JsonElement? = null,
    @SerialName("user_metadata") val userMetadata: JsonElement? = null
)

@Serializable
data class SupabaseErrorResponse(
    val error: String? = null,
    @SerialName("error_description") val errorDescription: String? = null,
    val msg: String? = null,
    val message: String? = null,
    val code: Int? = null
)
