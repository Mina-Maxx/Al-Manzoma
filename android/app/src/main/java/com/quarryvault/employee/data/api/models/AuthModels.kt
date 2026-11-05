package com.quarryvault.employee.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(
    val username: String,
    val password: String,
    @SerialName("client_application") val clientApplication: String
)

@Serializable
data class AuthTokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "bearer",
    @SerialName("expires_in") val expiresIn: Long = 3600,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("session_id") val sessionId: String? = null,
    val user: UserOut
)

@Serializable
data class TokenRefreshRequest(
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("session_id") val sessionId: String? = null
)

@Serializable
data class TokenRefreshResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "bearer",
    @SerialName("expires_in") val expiresIn: Long = 3600,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("session_id") val sessionId: String? = null
)

@Serializable
data class ChangePasswordResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("session_id") val sessionId: String? = null
)
