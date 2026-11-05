package com.quarryvault.employee.data.repository

import com.quarryvault.employee.data.api.QuarryVaultApiClient
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.AuthTokenResponse
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import com.quarryvault.employee.data.api.models.ServerConfig
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.DownloadedDocumentPayload
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.UserOut
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.TrashDocument
import com.quarryvault.employee.data.api.models.CompanyEmployee
import com.quarryvault.employee.data.api.models.CompanyQuarry
import com.quarryvault.employee.data.api.models.CreateEmployeeRequest
import com.quarryvault.employee.data.session.InMemorySessionStorage
import com.quarryvault.employee.data.session.SessionStorage
import com.quarryvault.employee.data.session.SessionStorageException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

interface EmployeeRepository {
    val backendBaseUrl: String
    val sessionStorage: SessionStorage

    suspend fun checkHealth(): ApiResult<HealthResponse>
    suspend fun login(username: String, password: String): ApiResult<AuthTokenResponse>
    fun getStoredUsername(): String? = sessionStorage.getUsername() ?: getStoredEmail()
    suspend fun getProfile(token: String? = null): ApiResult<MeResponse>
    suspend fun updateProfile(fullName: String, token: String? = null): ApiResult<UserOut>
    suspend fun logout()

    suspend fun getQuarries(token: String? = null): ApiResult<List<Quarry>>
    suspend fun createQuarry(name: String, quarryNumber: String = "", quarryType: String = "", token: String? = null): ApiResult<Quarry>
    suspend fun getFolders(quarryId: String, token: String? = null): ApiResult<List<Folder>>
    suspend fun createFolder(quarryId: String, name: String, parentId: String? = null, token: String? = null): ApiResult<Folder>
    suspend fun deleteFolder(quarryId: String, folderId: String, token: String? = null): ApiResult<Unit>
    suspend fun getDocuments(
        quarryId: String,
        folderId: String? = null,
        rootOnly: Boolean = false,
        token: String? = null
    ): ApiResult<List<Document>>

    suspend fun uploadDocument(
        quarryId: String,
        fileBytes: ByteArray,
        filename: String,
        mimeType: String,
        displayName: String? = null,
        folderId: String? = null,
        token: String? = null,
        idempotencyKey: String? = null
    ): ApiResult<Document>

    suspend fun downloadDocument(documentId: String, token: String? = null): ApiResult<ByteArray>
    suspend fun downloadDocumentPayload(documentId: String, token: String? = null): ApiResult<DownloadedDocumentPayload>
    suspend fun viewDocumentPayload(documentId: String, token: String? = null): ApiResult<DownloadedDocumentPayload> =
        downloadDocumentPayload(documentId, token)
    suspend fun renameDocument(quarryId: String, documentId: String, newName: String, token: String? = null): ApiResult<Document>
    suspend fun deleteDocument(quarryId: String, documentId: String, version: Int? = null, token: String? = null): ApiResult<Unit>
    suspend fun permanentlyDeleteDocument(quarryId: String, documentId: String, token: String? = null): ApiResult<Unit>
    suspend fun getTrashDocuments(quarryId: String, token: String? = null): ApiResult<List<TrashDocument>>
    suspend fun getCompanyTrash(token: String? = null): ApiResult<List<TrashDocument>>
    suspend fun restoreDocument(quarryId: String, documentId: String, version: Int? = null, token: String? = null): ApiResult<Document>
    suspend fun restoreCompanyTrashDocument(documentId: String, version: Int? = null, token: String? = null): ApiResult<Document>
    suspend fun changePassword(
        newPassword: String,
        confirmPassword: String,
        currentPassword: String?,
        token: String? = null
    ): ApiResult<Unit>
    suspend fun getLatestUpdateManifest(): ApiResult<AppUpdateManifest>
    suspend fun getServerConfig(): ApiResult<ServerConfig>
    suspend fun downloadApk(url: String, targetFile: java.io.File, onProgress: ((bytesRead: Long, totalBytes: Long) -> Unit)? = null): ApiResult<java.io.File>

    suspend fun getCompanyEmployees(token: String? = null): ApiResult<List<CompanyEmployee>>
    suspend fun createCompanyEmployee(request: CreateEmployeeRequest, token: String? = null): ApiResult<CompanyEmployee>
    suspend fun getCompanyQuarries(token: String? = null): ApiResult<List<CompanyQuarry>>

    fun hasStoredSession(): Boolean
    fun getStoredToken(): String?
    fun getStoredEmail(): String?
    fun getStoredSessionId(): String? = sessionStorage.getSessionId()
    fun clearStoredSession() = sessionStorage.clearSession()
}

class DefaultEmployeeRepository(
    private val apiClient: QuarryVaultApiClient = QuarryVaultApiClient(
        baseUrl = com.quarryvault.employee.BuildConfig.DEFAULT_BACKEND_URL,
        clientVersionCode = com.quarryvault.employee.BuildConfig.VERSION_CODE
    ),
    override val sessionStorage: SessionStorage = InMemorySessionStorage()
) : EmployeeRepository {

    @Volatile
    private var sessionStorageUnavailable = false

    private fun readSessionValue(read: () -> String?): String? {
        if (sessionStorageUnavailable) return null
        return try {
            read()
        } catch (_: Exception) {
            sessionStorageUnavailable = true
            apiClient.currentSessionId = null
            null
        }
    }

    private fun clearStoredSessionSafely() {
        try {
            sessionStorage.clearSession()
            sessionStorageUnavailable = false
        } catch (_: Exception) {
            sessionStorageUnavailable = true
        } finally {
            apiClient.currentSessionId = null
        }
    }

    init {
        apiClient.currentSessionId = readSessionValue { sessionStorage.getSessionId() }
    }

    override val backendBaseUrl: String
        get() = apiClient.baseUrl

    override suspend fun checkHealth(): ApiResult<HealthResponse> {
        return apiClient.getHealth()
    }

    override suspend fun login(username: String, password: String): ApiResult<AuthTokenResponse> {
        val result = apiClient.login(username, password)
        if (result is ApiResult.Success) {
            if (result.data.user.role == "platform_admin") {
                clearStoredSessionSafely()
                return ApiResult.Error(
                    statusCode = 403,
                    message = "Platform Admin accounts can only sign in to the Platform Admin Dashboard.",
                    code = "PLATFORM_ADMIN_NOT_ALLOWED"
                )
            }
            try {
                sessionStorage.saveSession(
                    accessToken = result.data.accessToken,
                    refreshToken = result.data.refreshToken,
                    email = result.data.user.username ?: result.data.user.email ?: username,
                    sessionId = result.data.sessionId
                )
                sessionStorageUnavailable = false
                apiClient.currentSessionId = result.data.sessionId
            } catch (_: SessionStorageException) {
                clearStoredSessionSafely()
                return ApiResult.Error(500, "Secure session storage is unavailable. Please sign in again after it is restored.")
            }
        }
        return result
    }

    override fun getStoredUsername(): String? = readSessionValue { sessionStorage.getUsername() }
        ?: readSessionValue { sessionStorage.getEmail() }

    private val refreshMutex = Mutex()

    private fun resolveToken(token: String?): String? {
        return token?.trim()?.takeIf { it.isNotEmpty() }
            ?: readSessionValue { sessionStorage.getAccessToken() }
    }

    private suspend fun <T> executeWithTokenRenewal(
        explicitToken: String?,
        action: suspend (token: String) -> ApiResult<T>
    ): ApiResult<T> {
        val initialToken = resolveToken(explicitToken)
            ?: return ApiResult.Error(401, "No authentication token available")

        val firstAttempt = action(initialToken)
        if (firstAttempt !is ApiResult.Error || firstAttempt.statusCode != 401) {
            return firstAttempt
        }

        // If caller passed an explicit one-off token, do not attempt automatic session refresh
        if (!explicitToken.isNullOrBlank()) {
            return firstAttempt
        }

        val storedRefreshToken = readSessionValue { sessionStorage.getRefreshToken() }
        if (storedRefreshToken.isNullOrBlank()) {
            clearStoredSessionSafely()
            return firstAttempt
        }

        // Synchronize token renewal using a Mutex to prevent refresh storms from concurrent requests
        val renewedToken = refreshMutex.withLock {
            val currentAccessToken = readSessionValue { sessionStorage.getAccessToken() }
            if (!currentAccessToken.isNullOrBlank() && currentAccessToken != initialToken) {
                // Already renewed by another concurrent request
                currentAccessToken
            } else {
                val refreshResult = apiClient.refreshAuthToken(storedRefreshToken)
                if (refreshResult is ApiResult.Success) {
                    val newAccess = refreshResult.data.accessToken
                    val newRefresh = refreshResult.data.refreshToken ?: storedRefreshToken
                    val sessionId = refreshResult.data.sessionId
                        ?: readSessionValue { sessionStorage.getSessionId() }
                    try {
                        sessionStorage.saveSession(
                            accessToken = newAccess,
                            refreshToken = newRefresh,
                            email = readSessionValue { sessionStorage.getEmail() },
                            sessionId = sessionId
                        )
                        sessionStorageUnavailable = false
                        if (sessionId != null) {
                            apiClient.currentSessionId = sessionId
                        }
                        newAccess
                    } catch (_: SessionStorageException) {
                        clearStoredSessionSafely()
                        null
                    }
                } else {
                    if (refreshResult is ApiResult.Error && (refreshResult.statusCode == 400 || refreshResult.statusCode == 401)) {
                        // Refresh token expired, revoked, or invalid
                        clearStoredSessionSafely()
                    }
                    null
                }
            }
        }

        if (renewedToken.isNullOrBlank()) {
            return firstAttempt
        }

        // Retry original request exactly once with the renewed access token
        val retryResult = action(renewedToken)
        if (retryResult is ApiResult.Error && retryResult.statusCode == 401) {
            clearStoredSessionSafely()
        }
        return retryResult
    }

    override suspend fun getProfile(token: String?): ApiResult<MeResponse> {
        val result = executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getMe(effectiveToken)
        }
        if (result is ApiResult.Success &&
            (result.data.role == "platform_admin" || result.data.user.role == "platform_admin")) {
            clearStoredSessionSafely()
            return ApiResult.Error(
                statusCode = 403,
                message = "Platform Admin accounts can only sign in to the Platform Admin Dashboard.",
                code = "PLATFORM_ADMIN_NOT_ALLOWED"
            )
        }
        if (result is ApiResult.Error && (result.statusCode == 401 || result.statusCode == 403)) {
            clearStoredSessionSafely()
        }
        return result
    }

    override suspend fun updateProfile(fullName: String, token: String?): ApiResult<UserOut> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.updateProfile(effectiveToken, fullName)
        }
    }

    override suspend fun getQuarries(token: String?): ApiResult<List<Quarry>> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getQuarries(effectiveToken)
        }
    }

    override suspend fun createQuarry(name: String, quarryNumber: String, quarryType: String, token: String?): ApiResult<Quarry> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.createQuarry(effectiveToken, name, quarryNumber, quarryType)
        }
    }

    override suspend fun getFolders(quarryId: String, token: String?): ApiResult<List<Folder>> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getQuarryFolders(effectiveToken, quarryId)
        }
    }

    override suspend fun createFolder(
        quarryId: String,
        name: String,
        parentId: String?,
        token: String?
    ): ApiResult<Folder> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.createFolder(effectiveToken, quarryId, name, parentId)
        }
    }

    override suspend fun deleteFolder(
        quarryId: String,
        folderId: String,
        token: String?
    ): ApiResult<Unit> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.deleteFolder(effectiveToken, quarryId, folderId)
        }
    }

    override suspend fun getDocuments(
        quarryId: String,
        folderId: String?,
        rootOnly: Boolean,
        token: String?
    ): ApiResult<List<Document>> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getQuarryDocuments(
                token = effectiveToken,
                quarryId = quarryId,
                folderId = folderId,
                rootOnly = rootOnly
            )
        }
    }

    override suspend fun uploadDocument(
        quarryId: String,
        fileBytes: ByteArray,
        filename: String,
        mimeType: String,
        displayName: String?,
        folderId: String?,
        token: String?,
        idempotencyKey: String?
    ): ApiResult<Document> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.uploadDocument(
                token = effectiveToken,
                quarryId = quarryId,
                fileBytes = fileBytes,
                filename = filename,
                mimeType = mimeType,
                displayName = displayName,
                folderId = folderId,
                idempotencyKey = idempotencyKey ?: java.util.UUID.randomUUID().toString()
            )
        }
    }

    override suspend fun downloadDocument(documentId: String, token: String?): ApiResult<ByteArray> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.downloadDocument(effectiveToken, documentId)
        }
    }

    override suspend fun downloadDocumentPayload(documentId: String, token: String?): ApiResult<DownloadedDocumentPayload> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.downloadDocumentPayload(effectiveToken, documentId)
        }
    }

    override suspend fun viewDocumentPayload(documentId: String, token: String?): ApiResult<DownloadedDocumentPayload> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.viewDocumentPayload(effectiveToken, documentId)
        }
    }

    override suspend fun renameDocument(
        quarryId: String,
        documentId: String,
        newName: String,
        token: String?
    ): ApiResult<Document> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.renameDocument(effectiveToken, quarryId, documentId, newName)
        }
    }

    override suspend fun deleteDocument(
        quarryId: String,
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Unit> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.deleteDocument(effectiveToken, quarryId, documentId, version)
        }
    }

    override suspend fun permanentlyDeleteDocument(
        quarryId: String,
        documentId: String,
        token: String?
    ): ApiResult<Unit> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.permanentlyDeleteDocument(effectiveToken, quarryId, documentId)
        }
    }

    override suspend fun getTrashDocuments(
        quarryId: String,
        token: String?
    ): ApiResult<List<TrashDocument>> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getTrashDocuments(effectiveToken, quarryId)
        }
    }

    override suspend fun getCompanyTrash(token: String?): ApiResult<List<TrashDocument>> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getCompanyTrash(effectiveToken)
        }
    }

    override suspend fun restoreDocument(
        quarryId: String,
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Document> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.restoreDocument(effectiveToken, quarryId, documentId, version)
        }
    }

    override suspend fun restoreCompanyTrashDocument(
        documentId: String,
        version: Int?,
        token: String?
    ): ApiResult<Document> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.restoreCompanyTrashDocument(effectiveToken, documentId, version)
        }
    }

    override suspend fun changePassword(
        newPassword: String,
        confirmPassword: String,
        currentPassword: String?,
        token: String?
    ): ApiResult<Unit> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            when (val result = apiClient.changePassword(effectiveToken, newPassword, confirmPassword, currentPassword)) {
                is ApiResult.Success -> {
                    val rotated = result.data
                    val identity = getStoredUsername() ?: getStoredEmail()
                    if (rotated.accessToken.isBlank() || rotated.refreshToken.isBlank() || identity.isNullOrBlank()) {
                        clearStoredSessionSafely()
                        ApiResult.Error(500, "Secure session rotation returned incomplete credentials. Please sign in again.")
                    } else {
                        try {
                            sessionStorage.saveSession(
                                accessToken = rotated.accessToken,
                                refreshToken = rotated.refreshToken,
                                email = identity,
                                sessionId = rotated.sessionId
                            )
                            sessionStorageUnavailable = false
                            apiClient.currentSessionId = rotated.sessionId
                            ApiResult.Success(Unit)
                        } catch (_: Exception) {
                            clearStoredSessionSafely()
                            ApiResult.Error(500, "Secure session storage is unavailable. Please sign in again after it is restored.")
                        }
                    }
                }
                is ApiResult.Error -> result
                is ApiResult.NetworkError -> result
            }
        }
    }

    override suspend fun getLatestUpdateManifest(): ApiResult<AppUpdateManifest> {
        return apiClient.getLatestUpdateManifest()
    }

    override suspend fun getServerConfig(): ApiResult<ServerConfig> {
        return apiClient.getServerConfig()
    }

    override suspend fun downloadApk(
        url: String,
        targetFile: java.io.File,
        onProgress: ((bytesRead: Long, totalBytes: Long) -> Unit)?
    ): ApiResult<java.io.File> {
        return apiClient.downloadApkWithProgress(url, targetFile, onProgress)
    }

    override suspend fun logout() {
        val token = getStoredToken()
        if (!token.isNullOrBlank()) {
            try {
                apiClient.logout(token)
            } catch (_: Exception) {}
        }
        clearStoredSession()
    }

    override suspend fun getCompanyEmployees(token: String?): ApiResult<List<CompanyEmployee>> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getCompanyEmployees(effectiveToken)
        }
    }

    override suspend fun createCompanyEmployee(
        request: CreateEmployeeRequest,
        token: String?
    ): ApiResult<CompanyEmployee> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.createCompanyEmployee(effectiveToken, request)
        }
    }

    override suspend fun getCompanyQuarries(token: String?): ApiResult<List<CompanyQuarry>> {
        return executeWithTokenRenewal(token) { effectiveToken ->
            apiClient.getCompanyQuarries(effectiveToken)
        }
    }

    override fun hasStoredSession(): Boolean = !readSessionValue { sessionStorage.getAccessToken() }.isNullOrBlank()

    override fun getStoredToken(): String? = readSessionValue { sessionStorage.getAccessToken() }

    override fun getStoredEmail(): String? = readSessionValue { sessionStorage.getEmail() }

    override fun getStoredSessionId(): String? = readSessionValue { sessionStorage.getSessionId() }

    override fun clearStoredSession() = clearStoredSessionSafely()
}
