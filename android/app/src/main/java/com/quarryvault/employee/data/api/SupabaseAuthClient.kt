package com.quarryvault.employee.data.api

import com.quarryvault.employee.BuildConfig
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.SupabaseErrorResponse
import com.quarryvault.employee.data.api.models.SupabasePasswordLoginRequest
import com.quarryvault.employee.data.api.models.SupabaseRefreshTokenRequest
import com.quarryvault.employee.data.api.models.SupabaseTokenResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException

open class SupabaseAuthClient(
    var supabaseUrl: String = BuildConfig.DEFAULT_SUPABASE_URL,
    var anonKey: String = BuildConfig.DEFAULT_SUPABASE_ANON_KEY,
    private val client: OkHttpClient = QuarryVaultApiClient.defaultOkHttpClient()
) {
    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val json = QuarryVaultApiClient.json
    }

    private fun sanitizeUrl(path: String): String {
        val trimmedBase = supabaseUrl.trim().trimEnd('/')
        val trimmedPath = path.trim().trimStart('/')
        return "$trimmedBase/$trimmedPath"
    }

    suspend fun signInWithPassword(
        email: String,
        password: String
    ): ApiResult<SupabaseTokenResponse> = withContext(Dispatchers.IO) {
        val cleanEmail = email.trim()
        val requestBody = json.encodeToString(
            SupabasePasswordLoginRequest(email = cleanEmail, password = password)
        ).toRequestBody(JSON_MEDIA_TYPE)

        val cleanKey = anonKey.trim()
        val builder = Request.Builder()
            .url(sanitizeUrl("/auth/v1/token?grant_type=password"))
            .post(requestBody)

        if (cleanKey.isNotEmpty()) {
            builder.header("apikey", cleanKey)
            builder.header("Authorization", "Bearer $cleanKey")
        }

        executeRequest(builder.build()) { body ->
            json.decodeFromString<SupabaseTokenResponse>(body)
        }
    }

    suspend fun refreshToken(
        refreshToken: String
    ): ApiResult<SupabaseTokenResponse> = withContext(Dispatchers.IO) {
        val cleanToken = refreshToken.trim()
        val requestBody = json.encodeToString(
            SupabaseRefreshTokenRequest(refreshToken = cleanToken)
        ).toRequestBody(JSON_MEDIA_TYPE)

        val cleanKey = anonKey.trim()
        val builder = Request.Builder()
            .url(sanitizeUrl("/auth/v1/token?grant_type=refresh_token"))
            .post(requestBody)

        if (cleanKey.isNotEmpty()) {
            builder.header("apikey", cleanKey)
            builder.header("Authorization", "Bearer $cleanKey")
        }

        executeRequest(builder.build()) { body ->
            json.decodeFromString<SupabaseTokenResponse>(body)
        }
    }

    protected open fun <T> executeRequest(
        request: Request,
        parser: (String) -> T
    ): ApiResult<T> {
        return try {
            client.newCall(request).execute().use { response ->
                val bodyString = response.body?.string().orEmpty()
                if (response.isSuccessful) {
                    try {
                        val parsed = parser(bodyString)
                        ApiResult.Success(parsed)
                    } catch (e: Exception) {
                        ApiResult.Error(
                            statusCode = response.code,
                            message = "Failed to parse Supabase Auth response: ${e.message}"
                        )
                    }
                } else {
                    val errorDetail = parseSupabaseError(bodyString, response)
                    ApiResult.Error(
                        statusCode = response.code,
                        message = errorDetail.first,
                        code = errorDetail.second
                    )
                }
            }
        } catch (e: IOException) {
            ApiResult.NetworkError(e)
        } catch (e: Exception) {
            ApiResult.NetworkError(e)
        }
    }

    private fun parseSupabaseError(body: String, response: Response): Pair<String, String?> {
        if (body.isBlank()) {
            return Pair("Authentication failed (HTTP ${response.code})", null)
        }
        return try {
            val err = json.decodeFromString<SupabaseErrorResponse>(body)
            val msg = err.errorDescription ?: err.msg ?: err.message ?: err.error ?: body
            Pair(msg, err.error)
        } catch (_: Exception) {
            Pair("HTTP ${response.code}: $body", null)
        }
    }
}
