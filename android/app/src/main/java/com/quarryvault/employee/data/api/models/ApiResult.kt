package com.quarryvault.employee.data.api.models

import kotlinx.serialization.Serializable

@Serializable
data class ApiErrorResponse(
    val detail: String? = null,
    val code: String? = null
)

sealed class ApiResult<out T> {
    data class Success<out T>(val data: T) : ApiResult<T>()
    data class Error(
        val statusCode: Int,
        val message: String,
        val code: String? = null,
        val sessionId: String? = null
    ) : ApiResult<Nothing>()
    data class NetworkError(val throwable: Throwable) : ApiResult<Nothing>()
}
