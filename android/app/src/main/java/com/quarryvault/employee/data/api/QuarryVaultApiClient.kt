package com.quarryvault.employee.data.api

import com.quarryvault.employee.data.api.models.ApiErrorResponse
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.CreateQuarryRequest
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.TrashDocument
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

open class QuarryVaultApiClient(
    var baseUrl: String = DEFAULT_BASE_URL,
    private val client: OkHttpClient = defaultOkHttpClient()
) {
    companion object {
        const val DEFAULT_BASE_URL = "http://10.0.2.2:8000"

        val json = Json {
            ignoreUnknownKeys = true
            isLenient = true
            coerceInputValues = true
        }

        fun defaultOkHttpClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()
        }
    }

    private fun sanitizeUrl(path: String): String {
        val trimmedBase = baseUrl.trim().trimEnd('/')
        val trimmedPath = path.trim().trimStart('/')
        return "$trimmedBase/$trimmedPath"
    }

    suspend fun getHealth(): ApiResult<HealthResponse> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(sanitizeUrl("/health"))
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<HealthResponse>(body)
        }
    }

    suspend fun getMe(token: String): ApiResult<MeResponse> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/me"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<MeResponse>(body)
        }
    }

    suspend fun getQuarries(token: String): ApiResult<List<Quarry>> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/quarries"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<List<Quarry>>(body)
        }
    }

    suspend fun createQuarry(token: String, name: String): ApiResult<Quarry> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val payload = json.encodeToString(CreateQuarryRequest.serializer(), CreateQuarryRequest(name = name.trim()))
        val requestBody = payload.toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url(sanitizeUrl("/quarries"))
            .header("Authorization", "Bearer $cleanToken")
            .post(requestBody)
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<Quarry>(body)
        }
    }

    suspend fun getQuarryFolders(token: String, quarryId: String): ApiResult<List<Folder>> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/folders"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<List<Folder>>(body)
        }
    }

    suspend fun getQuarryDocuments(
        token: String,
        quarryId: String,
        folderId: String? = null,
        rootOnly: Boolean = false,
        limit: Int = 100,
        offset: Int = 0
    ): ApiResult<List<Document>> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val urlBuilder = sanitizeUrl("/quarries/$quarryId/documents").toHttpUrlOrNull()?.newBuilder()
            ?: return@withContext ApiResult.Error(400, "Invalid URL construction")

        urlBuilder.addQueryParameter("limit", limit.toString())
        urlBuilder.addQueryParameter("offset", offset.toString())

        if (!folderId.isNullOrBlank()) {
            urlBuilder.addQueryParameter("folder_id", folderId)
        } else if (rootOnly) {
            urlBuilder.addQueryParameter("root_only", "true")
        }

        val request = Request.Builder()
            .url(urlBuilder.build())
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<List<Document>>(body)
        }
    }

    suspend fun uploadDocument(
        token: String,
        quarryId: String,
        fileBytes: ByteArray,
        filename: String,
        mimeType: String,
        displayName: String? = null,
        folderId: String? = null,
        idempotencyKey: String = UUID.randomUUID().toString()
    ): ApiResult<Document> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val fileMediaType = mimeType.toMediaTypeOrNull() ?: "application/octet-stream".toMediaType()
        val requestFile = fileBytes.toRequestBody(fileMediaType)

        val multipartBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, requestFile)

        if (!displayName.isNullOrBlank()) {
            multipartBuilder.addFormDataPart("display_name", displayName.trim())
        }
        if (!folderId.isNullOrBlank()) {
            multipartBuilder.addFormDataPart("folder_id", folderId.trim())
        }

        val request = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/documents"))
            .header("Authorization", "Bearer $cleanToken")
            .header("Idempotency-Key", idempotencyKey)
            .post(multipartBuilder.build())
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<Document>(body)
        }
    }

    suspend fun downloadDocument(token: String, documentId: String): ApiResult<ByteArray> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/documents/$documentId/download"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val bytes = response.body?.bytes() ?: ByteArray(0)
                    ApiResult.Success(bytes)
                } else {
                    val bodyString = response.body?.string().orEmpty()
                    val errorDetail = parseErrorDetail(bodyString, response)
                    ApiResult.Error(
                        statusCode = response.code,
                        message = errorDetail.first,
                        code = errorDetail.second
                    )
                }
            }
        } catch (e: Exception) {
            ApiResult.NetworkError(e)
        }
    }

    suspend fun deleteDocument(
        token: String,
        quarryId: String,
        documentId: String,
        version: Int? = null
    ): ApiResult<Unit> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val builder = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/documents/$documentId"))
            .header("Authorization", "Bearer $cleanToken")
            .delete()

        if (version != null && version > 0) {
            builder.header("If-Match", "\"v$version\"")
        }

        try {
            client.newCall(builder.build()).execute().use { response ->
                if (response.isSuccessful || response.code == 204) {
                    ApiResult.Success(Unit)
                } else {
                    val bodyString = response.body?.string().orEmpty()
                    val errorDetail = parseErrorDetail(bodyString, response)
                    ApiResult.Error(
                        statusCode = response.code,
                        message = errorDetail.first,
                        code = errorDetail.second
                    )
                }
            }
        } catch (e: Exception) {
            ApiResult.NetworkError(e)
        }
    }

    suspend fun getTrashDocuments(
        token: String,
        quarryId: String
    ): ApiResult<List<TrashDocument>> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/trash"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<List<TrashDocument>>(body)
        }
    }

    suspend fun restoreDocument(
        token: String,
        quarryId: String,
        documentId: String,
        version: Int? = null
    ): ApiResult<Document> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val emptyBody = ByteArray(0).toRequestBody(null)
        val builder = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/documents/$documentId/restore"))
            .header("Authorization", "Bearer $cleanToken")
            .post(emptyBody)

        if (version != null && version > 0) {
            builder.header("If-Match", "\"v$version\"")
        }

        executeRequest(builder.build()) { body ->
            json.decodeFromString<Document>(body)
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
                            message = "Failed to parse response: ${e.message}"
                        )
                    }
                } else {
                    val errorDetail = parseErrorDetail(bodyString, response)
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

    private fun parseErrorDetail(body: String, response: Response): Pair<String, String?> {
        if (body.isBlank()) {
            return Pair("HTTP ${response.code}: ${response.message}", null)
        }
        return try {
            val errorObj = json.decodeFromString<ApiErrorResponse>(body)
            val msg = errorObj.detail ?: "HTTP ${response.code}: ${response.message}"
            Pair(msg, errorObj.code)
        } catch (_: Exception) {
            Pair("HTTP ${response.code}: $body", null)
        }
    }
}
