package com.quarryvault.employee.data.api.models

import kotlinx.serialization.Serializable

@Serializable
data class HealthResponse(
    val status: String
)
