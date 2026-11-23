package com.quarryvault.employee.data.api

import com.quarryvault.employee.data.api.models.ApiErrorResponse
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import com.quarryvault.employee.data.api.models.ServerConfig
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.LoginRequest
import com.quarryvault.employee.data.api.models.AuthTokenResponse
import com.quarryvault.employee.data.api.models.TokenRefreshRequest
import com.quarryvault.employee.data.api.models.TokenRefreshResponse
import com.quarryvault.employee.data.api.models.ChangePasswordRequest
import com.quarryvault.employee.data.api.models.ChangePasswordResponse
import com.quarryvault.employee.data.api.models.CreateQuarryRequest
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.TrashDocument
import com.quarryvault.employee.data.api.models.UserOut
import com.quarryvault.employee.data.api.models.CreateFolderRequest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import com.quarryvault.employee.data.api.models.CompanyEmployee
import com.quarryvault.employee.data.api.models.CompanyQuarry
import com.quarryvault.employee.data.api.models.CreateEmployeeRequest
import com.quarryvault.employee.data.api.models.DownloadedDocumentPayload
import com.quarryvault.employee.data.api.models.RenameDocumentRequest
import com.quarryvault.employee.data.api.models.QuarryInitialPermissionRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
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

@Serializable
private data class UpdateProfileRequest(
    @SerialName("full_name")
    val fullName: String
)

@Serializable
private data class UpdateProfileResponse(
    val user: UserOut,
    val message: String? = null
)

open class QuarryVaultApiClient(
    var baseUrl: String = DEFAULT_BASE_URL,
    private val client: OkHttpClient = defaultOkHttpClient(),
    var clientVersionCode: Int = 1
) {
    var currentSessionId: String? = null
    companion object {
        const val DEFAULT_BASE_URL = "https://al-manzoma.onrender.com"

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

    suspend fun login(username: String, password: String): ApiResult<AuthTokenResponse> = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            LoginRequest.serializer(),
            LoginRequest(username = username.trim(), password = password, clientApplication = "android")
        )
        val body = payload.toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder()
            .url(sanitizeUrl("/auth/login"))
            .post(body)
            .build()

        executeRequest(request) { resBody ->
            json.decodeFromString<AuthTokenResponse>(resBody)
        }
    }

    suspend fun refreshAuthToken(refreshToken: String): ApiResult<TokenRefreshResponse> = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            TokenRefreshRequest.serializer(),
            TokenRefreshRequest(refreshToken = refreshToken.trim())
        )
        val body = payload.toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder()
            .url(sanitizeUrl("/auth/refresh"))
            .post(body)
            .build()

        executeRequest(request) { resBody ->
            json.decodeFromString<TokenRefreshResponse>(resBody)
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

        suspend fun updateProfile(token: String, fullName: String): ApiResult<UserOut> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val payload = json.encodeToString(
            UpdateProfileRequest.serializer(),
            UpdateProfileRequest(fullName = fullName.trim())
        )
        val requestBody = payload.toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url(sanitizeUrl("/me"))
            .header("Authorization", "Bearer $cleanToken")
            .patch(requestBody)
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<UpdateProfileResponse>(body).user
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

    suspend fun createQuarry(
        token: String,
        name: String,
        quarryNumber: String = "",
        quarryType: String = ""
    ): ApiResult<Quarry> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val payload = json.encodeToString(
            CreateQuarryRequest.serializer(),
            CreateQuarryRequest(name = name.trim(), quarryNumber = quarryNumber.trim(), quarryType = quarryType.trim())
        )
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

        suspend fun createFolder(
        token: String,
        quarryId: String,
        name: String,
        parentId: String? = null
    ): ApiResult<Folder> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val payload = json.encodeToString(
            CreateFolderRequest.serializer(),
            CreateFolderRequest(name = name.trim(), parentId = parentId?.trim()?.ifBlank { null })
        )
        val body = payload.toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/folders"))
            .header("Authorization", "Bearer $cleanToken")
            .post(body)
            .build()

        executeRequest(request) { res ->
            json.decodeFromString<Folder>(res)
        }
    }

    suspend fun deleteFolder(
        token: String,
        quarryId: String,
        folderId: String
    ): ApiResult<Unit> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/folders/$folderId"))
            .header("Authorization", "Bearer $cleanToken")
            .delete()
            .build()

        executeRequest(request) { }
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
            builder.header("If-Match", "\"$version\"")
        }

        val reqWithHeaders = enrichRequest(builder.build())

        try {
            client.newCall(reqWithHeaders).execute().use { response ->
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
            builder.header("If-Match", "\"$version\"")
        }

        executeRequest(builder.build()) { body ->
            json.decodeFromString<Document>(body)
        }
    }

    suspend fun changePassword(
        token: String,
        newPassword: String,
        confirmPassword: String,
        currentPassword: String? = null
    ): ApiResult<ChangePasswordResponse> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val payload = json.encodeToString(
            ChangePasswordRequest.serializer(),
            ChangePasswordRequest(
                newPassword = newPassword,
                confirmPassword = confirmPassword,
                currentPassword = currentPassword
            )
        )
        val requestBody = payload.toRequestBody("application/json".toMediaType())
        val req = Request.Builder()
            .url(sanitizeUrl("/auth/change-password"))
            .header("Authorization", "Bearer $cleanToken")
            .post(requestBody)
            .build()

        executeRequest(req) { body ->
            json.decodeFromString<ChangePasswordResponse>(body)
        }
    }


    suspend fun getLatestUpdateManifest(
        currentVersionCode: Int? = null
    ): ApiResult<AppUpdateManifest> = withContext(Dispatchers.IO) {
        val codeToPass = currentVersionCode ?: clientVersionCode
        val url = sanitizeUrl("/app/updates/latest?current_version_code=$codeToPass")
        val request = Request.Builder()
            .url(url)
            .header("X-App-Version-Code", codeToPass.toString())
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<AppUpdateManifest>(body)
        }
    }

    suspend fun getServerConfig(): ApiResult<ServerConfig> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(sanitizeUrl("/app/config"))
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<ServerConfig>(body)
        }
    }

    suspend fun downloadApkWithProgress(
        url: String,
        targetFile: java.io.File,
        onProgress: ((bytesRead: Long, totalBytes: Long) -> Unit)? = null
    ): ApiResult<java.io.File> = withContext(Dispatchers.IO) {
        val parentDir = targetFile.parentFile ?: java.io.File(".")
        val tempFile = java.io.File(parentDir, "${targetFile.name}.part")
        var totalRead: Long = 0
        var contentLength: Long = -1
        try {
            if (targetFile.isDirectory) {
                throw java.io.IOException("Target file cannot be a directory: ${targetFile.absolutePath}")
            }
            parentDir.mkdirs()
            if (tempFile.exists()) {
                tempFile.delete()
            }

            val resolvedUrl = if (url.startsWith("http://") || url.startsWith("https://")) {
                url
            } else {
                sanitizeUrl(url)
            }

            val request = Request.Builder()
                .url(resolvedUrl)
                .get()
                .build()

            val readTimeoutMs = if (client.readTimeoutMillis in 1..9999) {
                client.readTimeoutMillis.toLong()
            } else {
                60_000L
            }
            val downloadClient = client.newBuilder()
                .callTimeout(0, TimeUnit.MILLISECONDS)
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(60, TimeUnit.SECONDS)
                .build()

            val reqWithHeaders = enrichRequest(request)
            downloadClient.newCall(reqWithHeaders).execute().use { response ->
                if (!response.isSuccessful) {
                    val bodyString = response.body?.string().orEmpty()
                    val errorDetail = parseErrorDetail(bodyString, response)
                    return@withContext ApiResult.Error(
                        statusCode = response.code,
                        message = errorDetail.first,
                        code = errorDetail.second
                    )
                }

                val body = response.body ?: return@withContext ApiResult.Error(
                    statusCode = response.code,
                    message = "Empty response body"
                )

                contentLength = body.contentLength()
                val inputStream = body.byteStream()
                val outputStream = java.io.BufferedOutputStream(java.io.FileOutputStream(tempFile), 65536)

                outputStream.use { out ->
                    val buffer = ByteArray(65536)
                    var bytesRead: Int

                    while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                        kotlinx.coroutines.currentCoroutineContext().ensureActive()
                        out.write(buffer, 0, bytesRead)
                        totalRead += bytesRead
                        onProgress?.invoke(totalRead, contentLength)
                    }
                    out.flush()

                    if (contentLength > 0 && totalRead < contentLength) {
                        throw java.net.ProtocolException(
                            "Premature EOF: received $totalRead bytes, expected $contentLength bytes"
                        )
                    }
                }

                if (targetFile.exists()) {
                    targetFile.delete()
                }
                if (!tempFile.renameTo(targetFile)) {
                    tempFile.copyTo(targetFile, overwrite = true)
                    tempFile.delete()
                }

                ApiResult.Success(targetFile)
            }
        } catch (e: CancellationException) {
            if (tempFile.exists()) {
                tempFile.delete()
            }
            throw e
        } catch (e: java.net.SocketTimeoutException) {
            if (tempFile.exists()) {
                tempFile.delete()
            }
            val isConnect = e.message?.contains("connect", ignoreCase = true) == true
            val detail = if (isConnect) {
                "connect timed out"
            } else if (totalRead > 0) {
                "Read timed out after receiving $totalRead bytes" +
                    if (contentLength > 0) " of $contentLength bytes" else ""
            } else {
                e.message ?: "Read timed out"
            }
            val enhanced = java.net.SocketTimeoutException(detail).apply { initCause(e) }
            ApiResult.NetworkError(enhanced)
        } catch (e: java.net.ProtocolException) {
            if (tempFile.exists()) {
                tempFile.delete()
            }
            ApiResult.NetworkError(e)
        } catch (e: IOException) {
            if (tempFile.exists()) {
                tempFile.delete()
            }
            ApiResult.NetworkError(e)
        } catch (e: Exception) {
            if (tempFile.exists()) {
                tempFile.delete()
            }
            ApiResult.NetworkError(e)
        }
    }


    private suspend fun getDocumentPayload(
        token: String,
        documentId: String,
        access: String
    ): ApiResult<DownloadedDocumentPayload> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/documents/$documentId/$access"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        val reqWithHeaders = enrichRequest(request)

        try {
            client.newCall(reqWithHeaders).execute().use { response ->
                if (response.isSuccessful) {
                    val rawBody = response.body?.bytes() ?: ByteArray(0)
                    val mime = response.header("Content-Type") ?: "application/octet-stream"
                    val contentDisposition = response.header("Content-Disposition")
                    val filename = com.quarryvault.employee.data.util.ContentDispositionParser.extractFilename(contentDisposition)
                        ?: "document_$documentId"
                    ApiResult.Success(
                        DownloadedDocumentPayload(
                            bytes = rawBody,
                            filename = filename,
                            contentType = mime,
                            contentLength = response.body?.contentLength() ?: rawBody.size.toLong()
                        )
                    )
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

    suspend fun downloadDocumentPayload(token: String, documentId: String): ApiResult<DownloadedDocumentPayload> =
        getDocumentPayload(token, documentId, "download")

    suspend fun viewDocumentPayload(token: String, documentId: String): ApiResult<DownloadedDocumentPayload> =
        getDocumentPayload(token, documentId, "view")

    suspend fun downloadDocument(token: String, documentId: String): ApiResult<ByteArray> {
        return when (val res = downloadDocumentPayload(token, documentId)) {
            is ApiResult.Success -> ApiResult.Success(res.data.bytes)
            is ApiResult.Error -> ApiResult.Error(res.statusCode, res.message, res.code, res.sessionId)
            is ApiResult.NetworkError -> ApiResult.NetworkError(res.throwable)
        }
    }

    suspend fun renameDocument(
        token: String,
        quarryId: String,
        documentId: String,
        newName: String
    ): ApiResult<Document> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val payload = json.encodeToString(
            RenameDocumentRequest.serializer(),
            RenameDocumentRequest(name = newName.trim())
        )
        val requestBody = payload.toRequestBody("application/json".toMediaType())
        val builder = Request.Builder()
            .url(sanitizeUrl("/quarries/$quarryId/documents/$documentId/rename"))
            .header("Authorization", "Bearer $cleanToken")
            .patch(requestBody)

        val sid = currentSessionId
        if (!sid.isNullOrBlank()) {
            builder.header("X-Session-Id", sid)
        }
        val request = builder.build()

        executeRequest(request) { body ->
            json.decodeFromString<Document>(body)
        }
    }

    suspend fun permanentlyDeleteDocument(
        token: String,
        quarryId: String,
        documentId: String
    ): ApiResult<Unit> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val url = if (quarryId.isNotBlank()) {
            sanitizeUrl("/quarries/$quarryId/documents/$documentId/permanent")
        } else {
            sanitizeUrl("/company/trash/$documentId/permanent")
        }
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $cleanToken")
            .delete()

        val req = enrichRequest(builder.build())

        try {
            client.newCall(req).execute().use { response ->
                if (response.isSuccessful || response.code == 204) {
                    ApiResult.Success(Unit)
                } else {
                    val bodyString = response.body?.string().orEmpty()
                    val errorDetail = parseErrorDetail(bodyString, response)
                    ApiResult.Error(
                        statusCode = response.code,
                        message = errorDetail.first,
                        code = errorDetail.second,
                        sessionId = req.header("X-Session-Id")
                    )
                }
            }
        } catch (e: Exception) {
            ApiResult.NetworkError(e)
        }
    }

    suspend fun getCompanyTrash(token: String): ApiResult<List<TrashDocument>> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/company/trash"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<List<TrashDocument>>(body)
        }
    }

    suspend fun restoreCompanyTrashDocument(
        token: String,
        documentId: String,
        version: Int? = null
    ): ApiResult<Document> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val emptyBody = ByteArray(0).toRequestBody(null)
        val builder = Request.Builder()
            .url(sanitizeUrl("/company/trash/$documentId/restore"))
            .header("Authorization", "Bearer $cleanToken")
            .post(emptyBody)

        if (version != null && version > 0) {
            builder.header("If-Match", "\"v$version\"")
        }

        executeRequest(builder.build()) { body ->
            json.decodeFromString<Document>(body)
        }
    }

    suspend fun logout(token: String): ApiResult<Unit> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(sanitizeUrl("/auth/logout"))
            .header("Authorization", "Bearer ${token.trim()}")
            .post("{}".toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()

        executeRequest(request) { }
    }

    suspend fun getCompanyEmployees(token: String): ApiResult<List<CompanyEmployee>> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/company/employees"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<List<CompanyEmployee>>(body)
        }
    }

    suspend fun createCompanyEmployee(
        token: String,
        req: CreateEmployeeRequest
    ): ApiResult<CompanyEmployee> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val payload = json.encodeToString(CreateEmployeeRequest.serializer(), req)
        val body = payload.toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder()
            .url(sanitizeUrl("/company/employees"))
            .header("Authorization", "Bearer $cleanToken")
            .post(body)
            .build()

        executeRequest(request) { res ->
            json.decodeFromString<CompanyEmployee>(res)
        }
    }

    suspend fun getCompanyQuarries(token: String): ApiResult<List<CompanyQuarry>> = withContext(Dispatchers.IO) {
        val cleanToken = token.trim()
        val request = Request.Builder()
            .url(sanitizeUrl("/company/quarries"))
            .header("Authorization", "Bearer $cleanToken")
            .get()
            .build()

        executeRequest(request) { body ->
            json.decodeFromString<List<CompanyQuarry>>(body)
        }
    }

    protected fun enrichRequest(request: Request): Request {
        val builder = request.newBuilder()
        if (request.header("X-Client-Application") == null) {
            builder.header("X-Client-Application", "android")
        }
        if (request.header("X-App-Version-Code") == null && clientVersionCode > 0) {
            builder.header("X-App-Version-Code", clientVersionCode.toString())
        }
        val sid = currentSessionId
        if (!sid.isNullOrBlank() && request.header("X-Session-Id") == null) {
            builder.header("X-Session-Id", sid)
        }
        return builder.build()
    }

    protected open fun <T> executeRequest(
        request: Request,
        parser: (String) -> T
    ): ApiResult<T> {
        val reqWithHeaders = enrichRequest(request)
        return try {
            client.newCall(reqWithHeaders).execute().use { response ->
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
        val sessionHeader = response.header("X-Session-Status")
        if (response.code == 401 && sessionHeader == "invalidated") {
            return Pair("session_terminated_by_new_login", "SESSION_INVALIDATED")
        }
        if (body.isBlank()) {
            return Pair("HTTP ${response.code}: ${response.message}", null)
        }
        return try {
            val jsonElement = json.parseToJsonElement(body)
            if (jsonElement is JsonObject) {
                val detailElem = jsonElement["detail"]
                if (detailElem is JsonObject) {
                    val msg = (detailElem["message"] as? JsonPrimitive)?.content
                        ?: (detailElem["detail"] as? JsonPrimitive)?.content
                        ?: "HTTP ${response.code}: Upgrade Required"
                    val code = (detailElem["code"] as? JsonPrimitive)?.content
                        ?: (jsonElement["code"] as? JsonPrimitive)?.content
                    return Pair(msg, code)
                }
            }
            val errorObj = json.decodeFromString<ApiErrorResponse>(body)
            val msg = errorObj.detail ?: "HTTP ${response.code}: ${response.message}"
            Pair(msg, errorObj.code)
        } catch (_: Exception) {
            Pair("HTTP ${response.code}: $body", null)
        }
    }
}
