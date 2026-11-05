package com.quarryvault.employee.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import com.quarryvault.employee.data.api.models.ServerConfig
import com.quarryvault.employee.data.updates.UpdateManager
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.DownloadedDocumentPayload
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.TrashDocument
import com.quarryvault.employee.data.api.models.CompanyEmployee
import com.quarryvault.employee.data.api.models.CompanyQuarry
import com.quarryvault.employee.data.api.models.CreateEmployeeRequest
import com.quarryvault.employee.data.api.models.QuarryInitialPermissionRequest
import com.quarryvault.employee.data.repository.DefaultEmployeeRepository
import com.quarryvault.employee.data.repository.EmployeeRepository
import com.quarryvault.employee.data.scanner.DocumentCorners
import com.quarryvault.employee.data.scanner.EdgeDetector
import com.quarryvault.employee.data.scanner.ImageProcessor
import com.quarryvault.employee.data.scanner.PdfDocumentGenerator
import com.quarryvault.employee.data.scanner.ScanFilterMode
import com.quarryvault.employee.data.scanner.ScannedPage
import com.quarryvault.employee.data.util.AuthErrorMapper
import com.quarryvault.employee.data.util.LocalizedMessage
import com.quarryvault.employee.ui.components.AppNotification
import com.quarryvault.employee.ui.components.NotificationType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

private const val REFRESH_INDICATOR_MIN_VISIBLE_MILLIS = 17L

sealed class RequestState<out T> {
    object Idle : RequestState<Nothing>()
    object Loading : RequestState<Nothing>()
    data class Success<out T>(val data: T) : RequestState<T>()
    data class Error(val message: String, val code: String? = null) : RequestState<Nothing>()
}

enum class AppScreen {
    LOGIN,
    HOME,
    QUARRY_DETAIL,
    DOCUMENT_SCANNER,
    TRASH,
    PASSWORD_CHANGE,
    UPDATES,
    PROFILE,
    EMPLOYEE_MANAGEMENT
}

sealed interface UpdateStatus {
    object Idle : UpdateStatus
    object Checking : UpdateStatus
    data class Available(val manifest: AppUpdateManifest, val isRequired: Boolean) : UpdateStatus
    data class Downloading(
        val manifest: AppUpdateManifest,
        val progressPercent: Int,
        val bytesDownloaded: Long,
        val totalBytes: Long,
        val isRequired: Boolean
    ) : UpdateStatus
    data class ReadyToInstall(
        val manifest: AppUpdateManifest,
        val apkFile: File,
        val isRequired: Boolean
    ) : UpdateStatus
    data class Error(val message: LocalizedMessage, val isRequired: Boolean) : UpdateStatus
}

enum class ScannerStep {
    CAMERA,
    CROP,
    FILTER,
    REVIEW
}

data class EmployeeAppUiState(
    val currentScreen: AppScreen = AppScreen.LOGIN,
    val username: String = "",
    val email: String = "",
    val password: String = "",
    val backendBaseUrl: String = "",
    val isAuthenticated: Boolean = false,
    val isAuthenticating: Boolean = false,
    val isLoadingProfile: Boolean = false,
    val isValidatingSession: Boolean = false,
    val loginError: LocalizedMessage? = null,
    val profileError: LocalizedMessage? = null,
    val profile: MeResponse? = null,

    // Profile Screen & Edit Name (Requirement 6)
    val isUpdatingProfile: Boolean = false,
    val profileUpdateError: LocalizedMessage? = null,
    val profileUpdateSuccessMessage: LocalizedMessage? = null,

    // Folder Management (Requirement 4)
    val isCreateFolderDialogVisible: Boolean = false,
    val newFolderName: String = "",
    val isCreatingFolder: Boolean = false,
    val createFolderError: LocalizedMessage? = null,
    val createFolderSuccessMessage: LocalizedMessage? = null,
    val isDeletingFolder: Boolean = false,
    val deleteFolderError: LocalizedMessage? = null,
    val deleteFolderSuccessMessage: LocalizedMessage? = null,
    val isArabic: Boolean = true,

    // Password Change (Phase 11)
    val newPassword: String = "",
    val confirmPassword: String = "",
    val isChangingPassword: Boolean = false,
    val passwordChangeError: LocalizedMessage? = null,

    // Quarries list
    val quarries: List<Quarry> = emptyList(),
    val isLoadingQuarries: Boolean = false,
    val quarriesError: LocalizedMessage? = null,
    val quarrySearchQuery: String = "",

    // Quarry Creation
    val isCreateQuarryDialogVisible: Boolean = false,
    val newQuarryName: String = "",
    val newQuarryNumber: String = "",
    val newQuarryType: String = "",
    val isCreatingQuarry: Boolean = false,
    val createQuarryError: LocalizedMessage? = null,
    val createQuarrySuccessMessage: LocalizedMessage? = null,

    // Employee Management (Requirement: Company Admin Employee Management)
    val employees: List<CompanyEmployee> = emptyList(),
    val isLoadingEmployees: Boolean = false,
    val employeesError: LocalizedMessage? = null,
    val isCreateEmployeeDialogVisible: Boolean = false,
    val isCreatingEmployee: Boolean = false,
    val createEmployeeError: LocalizedMessage? = null,
    val createEmployeeSuccessMessage: LocalizedMessage? = null,
    val isReviewEmployeeDialogVisible: Boolean = false,
    val newEmployeeUsername: String = "",
    val newEmployeePassword: String = "",
    val newEmployeeFullName: String = "",
    val newEmployeeEmail: String = "",
    val selectedEmployeeQuarries: Map<String, QuarryInitialPermissionRequest> = emptyMap(),
    val newEmployeeCanView: Boolean = true,
    val newEmployeeCanUpload: Boolean = true,
    val newEmployeeCanDownload: Boolean = true,
    val newEmployeeCanDelete: Boolean = false,
    val newEmployeeHiddenQuarries: Set<String> = emptySet(),

    // Selected Quarry & Content
    val selectedQuarry: Quarry? = null,
    val folders: List<Folder> = emptyList(),
    val currentFolderId: String? = null,
    val documents: List<Document> = emptyList(),
    val isLoadingContent: Boolean = false,
    val contentError: LocalizedMessage? = null,
    val documentSearchQuery: String = "",

    // Document Upload
    val isUploadDialogVisible: Boolean = false,
    val isUploading: Boolean = false,
    val uploadError: LocalizedMessage? = null,
    val uploadSuccessMessage: LocalizedMessage? = null,

    // Document Download / View
    val isDownloading: Boolean = false,
    val downloadingDocumentId: String? = null,
    val downloadError: LocalizedMessage? = null,
    val downloadSuccessMessage: LocalizedMessage? = null,
    val downloadedDocumentData: Pair<Document, ByteArray>? = null,
    val pendingOpenDocumentData: Pair<Document, ByteArray>? = null,
    val pendingPrintDocumentData: Pair<Document, ByteArray>? = null,
    val pendingShareDocumentData: Pair<Document, ByteArray>? = null,

    // Document Rename
    val isRenamingDocument: Boolean = false,
    val renameDocumentError: LocalizedMessage? = null,
    val renameSuccessMessage: LocalizedMessage? = null,

    // Trash & Document Recovery
    val trashDocuments: List<TrashDocument> = emptyList(),
    val isLoadingTrash: Boolean = false,
    val trashError: LocalizedMessage? = null,
    val isDeletingDocument: Boolean = false,
    val deleteDocumentError: LocalizedMessage? = null,
    val deleteSuccessMessage: LocalizedMessage? = null,
    val isRestoringDocument: Boolean = false,
    val restoreError: LocalizedMessage? = null,
    val restoreSuccessMessage: LocalizedMessage? = null,

    // Document Scanner Feature
    val scannerStep: ScannerStep = ScannerStep.CAMERA,
    val scannedPages: List<ScannedPage> = emptyList(),
    val activeCapturedFile: File? = null,
    val activeDetectedCorners: DocumentCorners? = null,
    val activeWarpedBitmap: Bitmap? = null,
    val activeFilterMode: ScanFilterMode = ScanFilterMode.DOCUMENT_ENHANCED,
    val activeRotationDegrees: Int = 0,
    val scanDocumentName: String = "",
    val targetUploadQuarry: Quarry? = null,
    val selectedScanFolderId: String? = null,
    val generatedPdfFile: File? = null,
    val isGeneratingPdf: Boolean = false,
    val isUploadingScan: Boolean = false,
    val scanUploadError: LocalizedMessage? = null,
    val scanUploadSuccessMessage: LocalizedMessage? = null,
    val scanIdempotencyKey: String = UUID.randomUUID().toString(),
    val activeNotification: AppNotification? = null,
    val isRefreshingQuarries: Boolean = false,
    val isRefreshingContent: Boolean = false,
    val isRefreshingTrash: Boolean = false,
    val updateStatus: UpdateStatus = UpdateStatus.Idle,
    val serverConfig: ServerConfig? = null,
    val isUpToDate: Boolean = false,
    val isNoReleaseAvailable: Boolean = false,
    val lastUpdateCheckTime: String? = null,
    val latestManifest: AppUpdateManifest? = null,
    val updateErrorMessage: LocalizedMessage? = null,
    val installedVersionCode: Int = com.quarryvault.employee.BuildConfig.VERSION_CODE,
    val installedVersionName: String = com.quarryvault.employee.BuildConfig.VERSION_NAME
)

class EmployeeAppViewModel(
    private val repository: EmployeeRepository = DefaultEmployeeRepository(),
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val defaultDispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val updateManager: UpdateManager = UpdateManager()
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        EmployeeAppUiState(
            email = repository.getStoredEmail().orEmpty(),
            backendBaseUrl = repository.backendBaseUrl,
            isAuthenticated = false
        )
    )
    val uiState: StateFlow<EmployeeAppUiState> = _uiState.asStateFlow()
    private var createQuarryJob: Job? = null

    private fun handleAuthFailure(error: ApiResult.Error): Boolean {
        if (error.statusCode == 401 || error.code == "SESSION_INVALIDATED") {
            val currentSessionId = repository.getStoredSessionId()
            if (error.sessionId != null && currentSessionId != null && error.sessionId != currentSessionId) {
                // Delayed response from an older session that has already been superseded by a new session
                return false
            }
            repository.clearStoredSession()
            viewModelScope.launch {
                repository.logout()
            }
            val mapped = if (error.code == "SESSION_INVALIDATED" || error.message.contains("session_terminated_by_new_login", ignoreCase = true)) {
                LocalizedMessage(
                    english = "Logged in from another device.",
                    arabic = "تم تسجيل الدخول من جهاز آخر"
                )
            } else {
                AuthErrorMapper.mapBackendError(error.statusCode, error.message, error.code)
            }
            _uiState.update {
                it.copy(
                    isAuthenticated = false,
                    currentScreen = AppScreen.LOGIN,
                    loginError = mapped,
                    isLoadingProfile = false,
                    isLoadingQuarries = false,
                    isLoadingContent = false,
                    isLoadingEmployees = false,
                    isCreatingEmployee = false
                )
            }
            return true
        }
        return false
    }

    private var notificationDismissJob: Job? = null

    fun showNotification(
        message: LocalizedMessage,
        type: NotificationType = NotificationType.INFO,
        durationMs: Long = 3000L
    ) {
        val sanitized = sanitizeMessage(message)
        val notification = AppNotification(
            message = sanitized,
            type = type,
            durationMs = durationMs
        )
        notificationDismissJob?.cancel()
        _uiState.update { it.copy(activeNotification = notification) }
        notificationDismissJob = viewModelScope.launch {
            delay(durationMs)
            dismissNotification(notification.id)
        }
    }

    fun dismissNotification(id: String? = null) {
        if (id == null || _uiState.value.activeNotification?.id == id) {
            notificationDismissJob?.cancel()
            notificationDismissJob = null
            _uiState.update { it.copy(activeNotification = null) }
        }
    }


    fun navigateToUpdates() {
        _uiState.update {
            it.copy(currentScreen = AppScreen.UPDATES)
        }
    }

    fun navigateBackFromUpdates() {
        _uiState.update {
            it.copy(currentScreen = AppScreen.HOME)
        }
    }

    fun checkForUpdates(
        forceRequired: Boolean = false,
        currentVersionCode: Int = com.quarryvault.employee.BuildConfig.VERSION_CODE,
        isManualCheck: Boolean = false
    ) {
        viewModelScope.launch(ioDispatcher) {
            _uiState.update {
                it.copy(
                    updateStatus = UpdateStatus.Checking,
                    updateErrorMessage = null,
                    isUpToDate = false,
                    isNoReleaseAvailable = false
                )
            }
            val result = repository.getLatestUpdateManifest()
            val nowStr = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
            when (result) {
                is ApiResult.Success -> {
                    val manifest = result.data
                    val available = updateManager.isUpdateAvailable(manifest, currentVersionCode)
                    val required = forceRequired || updateManager.isUpdateRequired(manifest, currentVersionCode)
                    if (available || required) {
                        val shouldSuppressModal = !required && !isManualCheck && manifest.versionCode == dismissedOptionalVersionCode
                        _uiState.update {
                            it.copy(
                                updateStatus = if (shouldSuppressModal) UpdateStatus.Idle else UpdateStatus.Available(manifest, required),
                                latestManifest = manifest,
                                lastUpdateCheckTime = nowStr,
                                isUpToDate = false,
                                isNoReleaseAvailable = false,
                                updateErrorMessage = null
                            )
                        }
                    } else {
                        _uiState.update {
                            it.copy(
                                updateStatus = UpdateStatus.Idle,
                                latestManifest = manifest,
                                lastUpdateCheckTime = nowStr,
                                isUpToDate = true,
                                isNoReleaseAvailable = false,
                                updateErrorMessage = null
                            )
                        }
                    }
                }
                is ApiResult.Error -> {
                    val is404 = result.statusCode == 404 || result.code == "404" ||
                            result.message.contains("404") ||
                            result.message.contains("Not Found", ignoreCase = true) ||
                            result.message.contains("No releases", ignoreCase = true) ||
                            result.message.contains("No app releases available", ignoreCase = true)
                    if (is404) {
                        _uiState.update {
                            it.copy(
                                updateStatus = UpdateStatus.Idle,
                                isNoReleaseAvailable = true,
                                isUpToDate = false,
                                lastUpdateCheckTime = nowStr,
                                updateErrorMessage = null
                            )
                        }
                    } else if (forceRequired) {
                        val errMsg = LocalizedMessage(
                            english = "App update required, but failed to fetch update info: ${result.message}",
                            arabic = "التحديث إلزامي، ولكن تعذر جلب معلومات التحديث. يرجى المحاولة لاحقاً."
                        )
                        _uiState.update {
                            it.copy(
                                updateStatus = UpdateStatus.Error(
                                    message = errMsg,
                                    isRequired = true
                                ),
                                updateErrorMessage = errMsg,
                                lastUpdateCheckTime = nowStr,
                                isUpToDate = false,
                                isNoReleaseAvailable = false
                            )
                        }
                    } else {
                        val errMsg = sanitizeMessage(LocalizedMessage(
                            english = "Failed to check for updates: ${result.message}",
                            arabic = "تعذر التحقق من وجود تحديثات. يرجى المحاولة مرة أخرى."
                        ))
                        _uiState.update {
                            it.copy(
                                updateStatus = UpdateStatus.Error(
                                    message = errMsg,
                                    isRequired = false
                                ),
                                updateErrorMessage = errMsg,
                                lastUpdateCheckTime = nowStr,
                                isUpToDate = false,
                                isNoReleaseAvailable = false
                            )
                        }
                    }
                }
                is ApiResult.NetworkError -> {
                    val errMsg = LocalizedMessage(
                        english = "Network connection failed. Could not check for updates.",
                        arabic = "فشل الاتصال بالشبكة. تعذر التحقق من وجود تحديثات."
                    )
                    _uiState.update {
                        it.copy(
                            updateStatus = UpdateStatus.Error(
                                message = errMsg,
                                isRequired = forceRequired
                            ),
                            updateErrorMessage = errMsg,
                            lastUpdateCheckTime = nowStr,
                            isUpToDate = false,
                            isNoReleaseAvailable = false
                        )
                    }
                }
            }
        }
    }

    fun fetchServerConfig() {
        viewModelScope.launch(ioDispatcher) {
            val result = repository.getServerConfig()
            if (result is ApiResult.Success) {
                _uiState.update { it.copy(serverConfig = result.data) }
                val currentVersion = com.quarryvault.employee.BuildConfig.VERSION_CODE
                if (result.data.minimumSupportedVersionCode > 1 && currentVersion < result.data.minimumSupportedVersionCode) {
                    checkForUpdates(forceRequired = true)
                }
            }
        }
    }

    private var downloadJob: Job? = null

    fun cancelDownloadUpdate() {
        downloadJob?.cancel()
        downloadJob = null
        _uiState.update {
            val status = it.updateStatus
            if (status is UpdateStatus.Downloading) {
                it.copy(updateStatus = UpdateStatus.Idle)
            } else it
        }
    }

    fun downloadUpdate(manifest: AppUpdateManifest, targetDir: File, isRequired: Boolean) {
        downloadJob?.cancel()
        downloadJob = viewModelScope.launch(ioDispatcher) {
            _uiState.update {
                it.copy(
                    updateStatus = UpdateStatus.Downloading(
                        manifest = manifest,
                        progressPercent = 0,
                        bytesDownloaded = 0,
                        totalBytes = manifest.apkSizeBytes,
                        isRequired = isRequired
                    )
                )
            }

            val targetFile = File(targetDir, "quarryvault-v${manifest.versionCode}.apk")
            var lastReportedPercent = -1
            var lastReportedBytes = 0L

            val dlResult = repository.downloadApk(manifest.apkUrl, targetFile) { bytesRead, totalBytes ->
                val percent = if (totalBytes > 0) ((bytesRead * 100) / totalBytes).toInt().coerceIn(0, 100) else 0
                val shouldUpdate = percent != lastReportedPercent ||
                        (bytesRead - lastReportedBytes) >= (256 * 1024) ||
                        bytesRead == totalBytes
                if (shouldUpdate) {
                    lastReportedPercent = percent
                    lastReportedBytes = bytesRead
                    _uiState.update { state ->
                        if (state.updateStatus is UpdateStatus.Downloading) {
                            state.copy(
                                updateStatus = state.updateStatus.copy(
                                    progressPercent = percent,
                                    bytesDownloaded = bytesRead,
                                    totalBytes = totalBytes
                                )
                            )
                        } else state
                    }
                }
            }

            when (dlResult) {
                is ApiResult.Success -> {
                    val isValid = updateManager.verifyChecksum(targetFile, manifest.sha256)
                    if (isValid) {
                        _uiState.update {
                            it.copy(updateStatus = UpdateStatus.ReadyToInstall(manifest, targetFile, isRequired))
                        }
                    } else {
                        if (targetFile.exists()) {
                            targetFile.delete()
                        }
                        val errMsg = LocalizedMessage(
                            english = "Downloaded APK verification failed: SHA-256 checksum mismatch",
                            arabic = "فشل التحقق من ملف التحديث: عدم تطابق البصمة الرقمية SHA-256"
                        )
                        _uiState.update {
                            it.copy(
                                updateStatus = UpdateStatus.Error(
                                    message = errMsg,
                                    isRequired = isRequired
                                ),
                                updateErrorMessage = errMsg
                            )
                        }
                    }
                }
                is ApiResult.Error -> {
                    val errMsg = sanitizeMessage(LocalizedMessage(
                        english = "Download failed: ${dlResult.message}",
                        arabic = "تعذر تنزيل التحديث. يرجى المحاولة مرة أخرى."
                    ))
                    _uiState.update {
                        it.copy(
                            updateStatus = UpdateStatus.Error(
                                message = errMsg,
                                isRequired = isRequired
                            ),
                            updateErrorMessage = errMsg
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val t = dlResult.throwable
                    System.err.println("QuarryVaultUpdates: APK download failed [bytes=$lastReportedBytes, percent=$lastReportedPercent%]")

                    val msgText = t.message.orEmpty()
                    val isConnectTimeout = t is java.net.SocketTimeoutException && msgText.contains("connect", ignoreCase = true)
                    val isReadTimeout = t is java.net.SocketTimeoutException && !isConnectTimeout
                    val isPrematureEof = t is java.net.ProtocolException || msgText.contains("Premature EOF", ignoreCase = true)

                    val errMsg = when {
                        isConnectTimeout -> LocalizedMessage(
                            english = "Connection timed out connecting to server. Please check your network and retry.",
                            arabic = "انتهت مهلة الاتصال بالخادم. يرجى التحقق من اتصال الشبكة وإعادة المحاولة."
                        )
                        isReadTimeout -> {
                            val detail = if (lastReportedBytes > 0) {
                                "Download stalled: read timed out after receiving ${lastReportedBytes / 1024} KB ($lastReportedPercent%). Please check your connection and retry."
                            } else {
                                "Download timed out waiting for server data. Please check your connection and retry."
                            }
                            val detailAr = if (lastReportedBytes > 0) {
                                "توقف التحميل: انتهت المهلة بعد استلام ${lastReportedBytes / 1024} ك.ب ($lastReportedPercent%). يرجى التحقق من الاتصال وإعادة المحاولة."
                            } else {
                                "انتهت مهلة استلام بيانات التحديث من الخادم. يرجى التحقق من الاتصال وإعادة المحاولة."
                            }
                            LocalizedMessage(english = detail, arabic = detailAr)
                        }
                        isPrematureEof -> {
                            val detail = if (msgText.contains("Premature EOF")) {
                                "Download interrupted: $msgText. Please retry."
                            } else {
                                "Download interrupted: incomplete file received. Please retry."
                            }
                            val detailAr = "انقطع التحميل: تم استلام ملف غير مكتمل. يرجى إعادة المحاولة."
                            LocalizedMessage(english = detail, arabic = detailAr)
                        }
                        t is java.net.UnknownHostException -> LocalizedMessage(
                            english = "Cannot reach server. Please check the backend address.",
                            arabic = "تعذر الوصول إلى الخادم. يرجى التحقق من عنوان الخادم."
                        )
                        t is java.net.ConnectException -> LocalizedMessage(
                            english = "Connection refused by server. Ensure QuarryVault is running.",
                            arabic = "تم رفض الاتصال بالخادم. تأكد من تشغيل QuarryVault."
                        )
                        else -> LocalizedMessage(
                            english = "The update download failed. Please check your connection and try again.",
                            arabic = "تعذر تنزيل التحديث. يرجى التحقق من الاتصال والمحاولة مرة أخرى."
                        )
                    }
                    val sanitized = sanitizeMessage(errMsg)
                    _uiState.update {
                        it.copy(
                            updateStatus = UpdateStatus.Error(
                                message = sanitized,
                                isRequired = isRequired
                            ),
                            updateErrorMessage = sanitized
                        )
                    }
                }
            }
        }
    }
    private var dismissedOptionalVersionCode: Int? = null

    fun dismissOptionalUpdate() {
        _uiState.update {
            val status = it.updateStatus
            if ((status is UpdateStatus.Available && !status.isRequired) ||
                (status is UpdateStatus.ReadyToInstall && !status.isRequired)) {
                val vCode = when (status) {
                    is UpdateStatus.Available -> status.manifest.versionCode
                    is UpdateStatus.ReadyToInstall -> status.manifest.versionCode
                    else -> null
                }
                dismissedOptionalVersionCode = vCode
                it.copy(updateStatus = UpdateStatus.Idle)
            } else it
        }
    }

    private fun sanitizeMessage(msg: LocalizedMessage): LocalizedMessage {
        val sensitivePatterns = listOf(
            Regex("(?i)\\bbearer\\s+[A-Za-z0-9._~+/=-]{12,}"),
            Regex("(?i)\\b(?:password|access[_ -]?token|refresh[_ -]?token|token)\\b\\s*[:=]\\s*\\S+"),
            Regex("(?is)\\b(?:select\\b.+\\bfrom\\b|insert\\b.+\\binto\\b|update\\b.+\\bset\\b|delete\\b.+\\bfrom\\b)"),
            Regex("(?i)\\b(?:traceback|stack trace|psycopg|sqlstate|exception)\\b")
        )
        return if (sensitivePatterns.any { it.containsMatchIn(msg.english) || it.containsMatchIn(msg.arabic) }) {
            LocalizedMessage(
                english = "An unexpected error occurred. Please try again.",
                arabic = "حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى."
            )
        } else {
            msg
        }
    }

    fun refreshQuarries() {
        if (_uiState.value.isRefreshingQuarries) return
        viewModelScope.launch {
            _uiState.update { it.copy(isRefreshingQuarries = true) }
            try {
                // Let Compose render the active state before an immediate result can clear it.
                delay(REFRESH_INDICATOR_MIN_VISIBLE_MILLIS)
                when (val result = repository.getQuarries()) {
                    is ApiResult.Success -> {
                        _uiState.update {
                            it.copy(
                                quarries = result.data,
                                quarriesError = null
                            )
                        }
                        showNotification(
                            LocalizedMessage(
                                english = "Quarry list updated.",
                                arabic = "تم تحديث قائمة المحاجر."
                            ),
                            NotificationType.SUCCESS
                        )
                    }
                    is ApiResult.Error -> {
                        val detail = if (result.message.isNotBlank()) " (${result.message})" else ""
                        val err = LocalizedMessage(
                            english = "Could not refresh the quarry list. Please try again.$detail",
                            arabic = "تعذر تحديث قائمة المحاجر. يرجى المحاولة مرة أخرى."
                        )
                        if (result.statusCode == 401) {
                            _uiState.update { it.copy(isAuthenticated = false) }
                        }
                        showNotification(err, NotificationType.ERROR)
                    }
                    is ApiResult.NetworkError -> {
                        val err = AuthErrorMapper.mapNetworkError(result.throwable)
                        showNotification(err, NotificationType.ERROR)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                showNotification(
                    LocalizedMessage(
                        english = "Failed to refresh quarries. Please try again.",
                        arabic = "تعذر تحديث المحاجر. يرجى المحاولة مرة أخرى."
                    ),
                    NotificationType.ERROR
                )
            } finally {
                _uiState.update { it.copy(isRefreshingQuarries = false) }
            }
        }
    }

    fun refreshQuarryContent(quarryId: String, folderId: String? = null) {
        if (_uiState.value.isRefreshingContent) return
        viewModelScope.launch {
            _uiState.update { it.copy(isRefreshingContent = true) }
            try {
                delay(REFRESH_INDICATOR_MIN_VISIBLE_MILLIS)
                val foldersResult = repository.getFolders(quarryId = quarryId)
                val documentsResult = repository.getDocuments(
                    quarryId = quarryId,
                    folderId = folderId,
                    rootOnly = (folderId == null)
                )

                var newFolders = _uiState.value.folders
                var newDocuments = _uiState.value.documents
                var errorOccurred: LocalizedMessage? = null

                when (foldersResult) {
                    is ApiResult.Success -> newFolders = foldersResult.data
                    is ApiResult.Error -> {
                        errorOccurred = AuthErrorMapper.mapBackendError(
                            foldersResult.statusCode,
                            foldersResult.message,
                            foldersResult.code
                        )
                        if (foldersResult.statusCode == 401) {
                            _uiState.update { it.copy(isAuthenticated = false) }
                        }
                    }
                    is ApiResult.NetworkError -> {
                        errorOccurred = AuthErrorMapper.mapNetworkError(foldersResult.throwable)
                    }
                }

                when (documentsResult) {
                    is ApiResult.Success -> newDocuments = documentsResult.data
                    is ApiResult.Error -> if (errorOccurred == null) {
                        errorOccurred = AuthErrorMapper.mapBackendError(
                            documentsResult.statusCode,
                            documentsResult.message,
                            documentsResult.code
                        )
                        if (documentsResult.statusCode == 401) {
                            _uiState.update { it.copy(isAuthenticated = false) }
                        }
                    }
                    is ApiResult.NetworkError -> if (errorOccurred == null) {
                        errorOccurred = AuthErrorMapper.mapNetworkError(documentsResult.throwable)
                    }
                }

                _uiState.update {
                    it.copy(
                        folders = newFolders,
                        documents = newDocuments
                    )
                }

                if (errorOccurred != null) {
                    showNotification(errorOccurred, NotificationType.ERROR)
                } else {
                    showNotification(
                        LocalizedMessage(
                            english = "Content updated.",
                            arabic = "تم تحديث محتويات المحجر."
                        ),
                        NotificationType.SUCCESS
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                showNotification(
                    LocalizedMessage(
                        english = "Failed to refresh quarry contents. Please try again.",
                        arabic = "تعذر تحديث محتويات المحجر. يرجى المحاولة مرة أخرى."
                    ),
                    NotificationType.ERROR
                )
            } finally {
                _uiState.update { it.copy(isRefreshingContent = false) }
            }
        }
    }

    fun refreshTrash(quarryId: String? = null) {
        if (_uiState.value.isRefreshingTrash) return
        val targetQuarryId = quarryId ?: _uiState.value.selectedQuarry?.id
        viewModelScope.launch {
            _uiState.update { it.copy(isRefreshingTrash = true) }
            try {
                delay(REFRESH_INDICATOR_MIN_VISIBLE_MILLIS)
                val result = if (targetQuarryId != null) {
                    repository.getTrashDocuments(targetQuarryId)
                } else {
                    repository.getCompanyTrash()
                }
                when (result) {
                    is ApiResult.Success -> {
                        _uiState.update {
                            it.copy(
                                trashDocuments = result.data,
                                trashError = null
                            )
                        }
                        showNotification(
                            LocalizedMessage(
                                english = "Trash updated.",
                                arabic = "تم تحديث سلة المهملات."
                            ),
                            NotificationType.SUCCESS
                        )
                    }
                    is ApiResult.Error -> {
                        val err = AuthErrorMapper.mapBackendError(result.statusCode, result.message, result.code)
                        if (result.statusCode == 401) {
                            _uiState.update { it.copy(isAuthenticated = false) }
                        }
                        showNotification(err, NotificationType.ERROR)
                    }
                    is ApiResult.NetworkError -> {
                        val err = AuthErrorMapper.mapNetworkError(result.throwable)
                        showNotification(err, NotificationType.ERROR)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                showNotification(
                    LocalizedMessage(
                        english = "Failed to refresh trash. Please try again.",
                        arabic = "تعذر تحديث سلة المهملات. يرجى المحاولة مرة أخرى."
                    ),
                    NotificationType.ERROR
                )
            } finally {
                _uiState.update { it.copy(isRefreshingTrash = false) }
            }
        }
    }

    init {
        // If an active session exists in storage, attempt to load profile automatically
        fetchServerConfig()
        checkForUpdates()
        if (repository.hasStoredSession()) {
            val token = repository.getStoredToken()
            if (!token.isNullOrBlank()) {
                _uiState.update { it.copy(isValidatingSession = true) }
                fetchProfile(token)
            }
        }
    }

    fun onEmailChanged(newEmail: String) {
        _uiState.update { it.copy(email = newEmail, username = newEmail, loginError = null) }
    }

    fun onUsernameChanged(newUsername: String) {
        _uiState.update { it.copy(username = newUsername, email = newUsername, loginError = null) }
    }

    fun onPasswordChanged(newPassword: String) {
        _uiState.update { it.copy(password = newPassword, loginError = null) }
    }

    fun login() {
        val username = _uiState.value.username.ifBlank { _uiState.value.email }.trim()
        val password = _uiState.value.password

        if (username.isBlank()) {
            _uiState.update {
                it.copy(
                    loginError = LocalizedMessage(
                        english = "Please enter your employee username or email address.",
                        arabic = "يرجى إدخال اسم المستخدم أو البريد الإلكتروني للموظف."
                    )
                )
            }
            return
        }

        if (password.isBlank()) {
            _uiState.update {
                it.copy(
                    loginError = LocalizedMessage(
                        english = "Please enter your password.",
                        arabic = "يرجى إدخال كلمة المرور."
                    )
                )
            }
            return
        }

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isAuthenticating = true,
                    loginError = null,
                    profileError = null
                )
            }

            when (val authResult = repository.login(username, password)) {
                is ApiResult.Success -> {
                    val token = authResult.data.accessToken
                    val user = authResult.data.user
                    _uiState.update {
                        it.copy(
                            isAuthenticating = false
                        )
                    }
                    if (user.mustChangePassword) {
                        _uiState.update {
                            it.copy(
                                isAuthenticated = true,
                                isLoadingProfile = false,
                                currentScreen = AppScreen.PASSWORD_CHANGE
                            )
                        }
                    } else {
                        // Next, load employee profile from backend to enforce authorization
                        fetchProfile(token)
                    }
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapLoginError(
                        authResult.statusCode,
                        authResult.message,
                        authResult.code
                    )
                    _uiState.update {
                        it.copy(
                            isAuthenticating = false,
                            loginError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(authResult.throwable)
                    _uiState.update {
                        it.copy(
                            isAuthenticating = false,
                            loginError = mapped
                        )
                    }
                }
            }
        }
    }

    fun fetchProfile(tokenOverride: String? = null) {
        val effectiveToken = tokenOverride?.trim()?.takeIf { it.isNotEmpty() }
            ?: repository.getStoredToken()

        if (effectiveToken.isNullOrBlank()) {
            _uiState.update {
                it.copy(
                    isValidatingSession = false,
                    profileError = LocalizedMessage(
                        english = "No authentication token available. Please sign in.",
                        arabic = "لا يوجد رمز مصادقة متاح. يرجى تسجيل الدخول."
                    )
                )
            }
            return
        }

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoadingProfile = true,
                    profileError = null
                )
            }

            when (val profileResult = repository.getProfile(effectiveToken)) {
                is ApiResult.Success -> {
                    val me = profileResult.data
                    if (me.user.mustChangePassword) {
                        _uiState.update {
                            it.copy(
                                isAuthenticated = true,
                                isLoadingProfile = false,
                                isValidatingSession = false,
                                profile = me,
                                profileError = null,
                                loginError = null,
                                currentScreen = AppScreen.PASSWORD_CHANGE
                            )
                        }
                    } else {
                        _uiState.update {
                            it.copy(
                                isAuthenticated = true,
                                isLoadingProfile = false,
                                isValidatingSession = false,
                                profile = me,
                                profileError = null,
                                loginError = null,
                                currentScreen = AppScreen.HOME
                            )
                        }
                        loadQuarries()
                    }
                }
                is ApiResult.Error -> {
                    if (handleAuthFailure(profileResult)) return@launch
                    val isAuthError = profileResult.statusCode == 401 || profileResult.statusCode == 403
                    if (isAuthError) {
                        repository.logout()
                    }
                    val mapped = AuthErrorMapper.mapBackendError(
                        profileResult.statusCode,
                        profileResult.message,
                        profileResult.code
                    )
                    _uiState.update {
                        it.copy(
                            isAuthenticated = false,
                            isLoadingProfile = false,
                            isValidatingSession = false,
                            profile = null,
                            loginError = mapped,
                            profileError = mapped,
                            currentScreen = AppScreen.LOGIN
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(profileResult.throwable)
                    _uiState.update {
                        it.copy(
                            isLoadingProfile = false,
                            isValidatingSession = false,
                            profileError = mapped
                        )
                    }
                }
            }
        }
    }

    fun retrySessionValidation() {
        val token = repository.getStoredToken()
        if (!token.isNullOrBlank()) {
            _uiState.update { it.copy(isValidatingSession = true, profileError = null) }
            fetchProfile(token)
        } else {
            _uiState.update { it.copy(isValidatingSession = false, currentScreen = AppScreen.LOGIN) }
        }
    }

    fun clearSessionAndGoToLogin() {
        viewModelScope.launch {
            repository.logout()
            _uiState.update {
                it.copy(
                    isAuthenticated = false,
                    isValidatingSession = false,
                    isLoadingProfile = false,
                    profile = null,
                    profileError = null,
                    loginError = null,
                    currentScreen = AppScreen.LOGIN
                )
            }
        }
    }

    fun navigateToProfile() {
        _uiState.update {
            it.copy(
                currentScreen = AppScreen.PROFILE,
                profileUpdateError = null,
                profileUpdateSuccessMessage = null
            )
        }
    }

    fun navigateBackFromProfile() {
        _uiState.update {
            it.copy(
                currentScreen = AppScreen.HOME,
                profileUpdateError = null,
                profileUpdateSuccessMessage = null
            )
        }
    }

    fun updateFullName(newName: String) {
        val trimmed = newName.trim()
        if (trimmed.length < 2 || trimmed.length > 100) {
            _uiState.update {
                it.copy(
                    profileUpdateError = LocalizedMessage(
                        english = "Name must be between 2 and 100 characters.",
                        arabic = "يجب أن يكون الاسم بين حرفين و 100 حرف."
                    )
                )
            }
            return
        }

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isUpdatingProfile = true,
                    profileUpdateError = null,
                    profileUpdateSuccessMessage = null
                )
            }
            val token = repository.getStoredToken().orEmpty()
            when (val result = repository.updateProfile(fullName = trimmed, token = token)) {
                is ApiResult.Success -> {
                    val updatedUser = result.data
                    _uiState.update { state ->
                        val updatedProfile = state.profile?.let { p ->
                            p.copy(
                                user = p.user.copy(
                                    fullName = updatedUser.fullName
                                )
                            )
                        }
                        state.copy(
                            isUpdatingProfile = false,
                            profile = updatedProfile,
                            profileUpdateError = null,
                            profileUpdateSuccessMessage = LocalizedMessage(
                                english = "Name updated successfully.",
                                arabic = "تم تحديث الاسم بنجاح."
                            )
                        )
                    }
                    showNotification(
                        LocalizedMessage(
                            english = "Name updated successfully.",
                            arabic = "تم تحديث الاسم بنجاح."
                        ),
                        NotificationType.SUCCESS
                    )
                }
                is ApiResult.Error -> {
                    if (handleAuthFailure(result)) return@launch
                    val mapped = AuthErrorMapper.mapBackendError(
                        result.statusCode,
                        result.message,
                        result.code
                    )
                    _uiState.update {
                        it.copy(
                            isUpdatingProfile = false,
                            profileUpdateError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isUpdatingProfile = false,
                            profileUpdateError = mapped
                        )
                    }
                }
            }
        }
    }

    fun loadQuarries() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingQuarries = true, quarriesError = null) }
            when (val result = repository.getQuarries()) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            isLoadingQuarries = false,
                            quarries = result.data,
                            quarriesError = null
                        )
                    }
                }
                is ApiResult.Error -> {
                    if (handleAuthFailure(result)) return@launch
                    val mapped = AuthErrorMapper.mapBackendError(
                        result.statusCode,
                        result.message,
                        result.code
                    )
                    _uiState.update {
                        it.copy(
                            isLoadingQuarries = false,
                            quarriesError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isLoadingQuarries = false,
                            quarriesError = mapped
                        )
                    }
                }
            }
        }
    }

    fun onQuarrySearchQueryChanged(query: String) {
        _uiState.update { it.copy(quarrySearchQuery = query) }
    }

    fun openCreateQuarryDialog() {
        _uiState.update {
            it.copy(
                isCreateQuarryDialogVisible = true,
                newQuarryName = "",
                newQuarryNumber = "",
                newQuarryType = "",
                isCreatingQuarry = createQuarryJob?.isActive == true,
                createQuarryError = null
            )
        }
    }

    fun dismissCreateQuarryDialog() {
        if (_uiState.value.isCreatingQuarry || createQuarryJob?.isActive == true) return
        _uiState.update {
            it.copy(
                isCreateQuarryDialogVisible = false,
                createQuarryError = null
            )
        }
    }

    fun onNewQuarryNameChanged(name: String) {
        _uiState.update { it.copy(newQuarryName = name, createQuarryError = null) }
    }

    fun onNewQuarryNumberChanged(number: String) {
        _uiState.update { it.copy(newQuarryNumber = number, createQuarryError = null) }
    }

    fun onNewQuarryTypeChanged(type: String) {
        _uiState.update { it.copy(newQuarryType = type, createQuarryError = null) }
    }

    fun clearCreateQuarrySuccessMessage() {
        _uiState.update { it.copy(createQuarrySuccessMessage = null) }
    }

    fun createQuarry() {
        if (_uiState.value.isCreatingQuarry || createQuarryJob?.isActive == true) return
        val name = _uiState.value.newQuarryName.trim()
        val quarryNumber = _uiState.value.newQuarryNumber.trim()
        val quarryType = _uiState.value.newQuarryType.trim()
        if (name.isBlank() || quarryNumber.isBlank() || quarryType.isBlank()) {
            _uiState.update {
                it.copy(
                    createQuarryError = LocalizedMessage(
                        arabic = "يرجى إدخال جميع البيانات المطلوبة: اسم المحجر، رقم المحجر، ونوع المحجر",
                        english = "Please fill in all required fields: Quarry Name, Number, and Type"
                    )
                )
            }
            return
        }

        _uiState.update { it.copy(isCreatingQuarry = true, createQuarryError = null) }
        createQuarryJob = viewModelScope.launch {
            try {
                when (val result = repository.createQuarry(name, quarryNumber, quarryType)) {
                is ApiResult.Success -> {
                    val created = result.data
                    _uiState.update {
                        it.copy(
                            isCreateQuarryDialogVisible = false,
                            newQuarryName = "",
                            newQuarryNumber = "",
                            newQuarryType = "",
                            createQuarrySuccessMessage = LocalizedMessage(
                                arabic = "تم إنشاء المحجر \"${created.displayNameFormatted}\" بنجاح",
                                english = "Quarry \"${created.displayNameFormatted}\" created successfully"
                            )
                        )
                    }
                    loadQuarries()
                }
                is ApiResult.Error -> {
                    val msg = when {
                        result.statusCode == 409 && result.message.contains("رقم المحجر", ignoreCase = true) -> {
                            LocalizedMessage(
                                arabic = "رقم المحجر مسجل بالفعل لهذه الشركة",
                                english = "Quarry number is already registered for this company"
                            )
                        }
                        result.statusCode == 409 || result.message.contains("already exists", ignoreCase = true) -> {
                            LocalizedMessage(
                                arabic = "اسم المحجر مسجل بالفعل لهذه الشركة",
                                english = "A quarry with this name already exists in your company"
                            )
                        }
                        result.statusCode == 400 || result.message.contains("required", ignoreCase = true) -> {
                            LocalizedMessage(
                                arabic = "اسم المحجر غير صالح أو فارغ",
                                english = "Quarry name is invalid or empty"
                            )
                        }
                        result.statusCode == 403 -> {
                            LocalizedMessage(
                                arabic = "ليس لديك الصلاحية لإنشاء محجر أو حسابك غير نشط",
                                english = "You do not have permission to create quarries or your account is inactive"
                            )
                        }
                        else -> {
                            LocalizedMessage(
                                arabic = "تعذر إنشاء المحجر. يرجى المحاولة مرة أخرى.",
                                english = "Could not create the quarry. Please try again."
                            )
                        }
                    }
                    _uiState.update {
                        it.copy(
                            createQuarryError = msg
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            createQuarryError = mapped
                        )
                    }
                }
            }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _uiState.update {
                    it.copy(
                        createQuarryError = LocalizedMessage(
                            arabic = "فشل إنشاء المحجر. يرجى المحاولة مرة أخرى.",
                            english = "Failed to create the quarry. Please try again."
                        )
                    )
                }
            } finally {
                _uiState.update { it.copy(isCreatingQuarry = false) }
                createQuarryJob = null
            }
        }
    }

    fun selectQuarry(quarry: Quarry) {
        _uiState.update {
            it.copy(
                selectedQuarry = quarry,
                currentFolderId = null,
                currentScreen = AppScreen.QUARRY_DETAIL,
                documentSearchQuery = "",
                contentError = null,
                uploadError = null,
                downloadError = null,
                isDownloading = false,
                downloadingDocumentId = null,
                downloadedDocumentData = null,
                pendingOpenDocumentData = null,
                pendingPrintDocumentData = null,
                pendingShareDocumentData = null
            )
        }
        loadQuarryContent(quarry.id, folderId = null)
    }

    fun navigateBackToHome() {
        _uiState.update {
            it.copy(
                currentScreen = AppScreen.HOME,
                selectedQuarry = null,
                currentFolderId = null,
                folders = emptyList(),
                documents = emptyList(),
                contentError = null,
                documentSearchQuery = "",
                isDownloading = false,
                downloadingDocumentId = null,
                downloadedDocumentData = null,
                pendingOpenDocumentData = null,
                pendingPrintDocumentData = null,
                pendingShareDocumentData = null
            )
        }
        loadQuarries()
    }

    fun navigateUpFolder() {
        val currentFolderId = _uiState.value.currentFolderId
        if (currentFolderId == null) {
            navigateBackToHome()
            return
        }
        val currentFolder = _uiState.value.folders.find { it.id == currentFolderId }
        val parentId = currentFolder?.parentId
        selectFolder(parentId)
    }

    fun navigateToTrash(quarryId: String? = null) {
        val targetQuarry = quarryId?.let { id -> _uiState.value.quarries.find { it.id == id } }
            ?: _uiState.value.selectedQuarry
        _uiState.update {
            it.copy(
                currentScreen = AppScreen.TRASH,
                selectedQuarry = targetQuarry,
                trashError = null,
                isDownloading = false,
                downloadingDocumentId = null,
                downloadedDocumentData = null,
                pendingOpenDocumentData = null,
                pendingPrintDocumentData = null,
                pendingShareDocumentData = null
            )
        }
        if (targetQuarry != null) {
            loadTrash(targetQuarry.id)
        } else {
            loadCompanyTrash()
        }
    }

    fun navigateBackFromTrash() {
        val quarry = _uiState.value.selectedQuarry
        if (quarry != null) {
            _uiState.update {
                it.copy(
                    currentScreen = AppScreen.QUARRY_DETAIL,
                    trashError = null,
                    isDownloading = false,
                    downloadingDocumentId = null,
                    downloadedDocumentData = null,
                    pendingOpenDocumentData = null,
                    pendingPrintDocumentData = null,
                    pendingShareDocumentData = null
                )
            }
            loadQuarryContent(quarry.id, _uiState.value.currentFolderId)
        } else {
            navigateBackToHome()
        }
    }

    fun selectFolder(folderId: String?) {
        val quarry = _uiState.value.selectedQuarry ?: return
        _uiState.update {
            it.copy(
                currentFolderId = folderId,
                contentError = null,
                isDownloading = false,
                downloadingDocumentId = null,
                downloadedDocumentData = null,
                pendingOpenDocumentData = null,
                pendingPrintDocumentData = null,
                pendingShareDocumentData = null
            )
        }
        loadQuarryContent(quarry.id, folderId = folderId)
    }

    fun loadQuarryContent(quarryId: String, folderId: String?) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingContent = true, contentError = null) }

            // Fetch folders list
            val foldersResult = repository.getFolders(quarryId)
            val foldersList = if (foldersResult is ApiResult.Success) {
                foldersResult.data
            } else {
                emptyList()
            }

            // Fetch documents in folder (or root documents if folderId == null)
            val docsResult = repository.getDocuments(
                quarryId = quarryId,
                folderId = folderId,
                rootOnly = (folderId == null)
            )

            when (docsResult) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            isLoadingContent = false,
                            folders = foldersList,
                            documents = docsResult.data,
                            contentError = null
                        )
                    }
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapBackendError(
                        docsResult.statusCode,
                        docsResult.message,
                        docsResult.code
                    )
                    _uiState.update {
                        it.copy(
                            isLoadingContent = false,
                            folders = foldersList,
                            contentError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(docsResult.throwable)
                    _uiState.update {
                        it.copy(
                            isLoadingContent = false,
                            folders = foldersList,
                            contentError = mapped
                        )
                    }
                }
            }
        }
    }

    fun openCreateFolderDialog() {
        _uiState.update {
            it.copy(
                isCreateFolderDialogVisible = true,
                newFolderName = "",
                createFolderError = null,
                createFolderSuccessMessage = null
            )
        }
    }

    fun dismissCreateFolderDialog() {
        _uiState.update {
            it.copy(
                isCreateFolderDialogVisible = false,
                newFolderName = "",
                createFolderError = null,
                createFolderSuccessMessage = null
            )
        }
    }

    fun onNewFolderNameChanged(name: String) {
        _uiState.update { it.copy(newFolderName = name, createFolderError = null) }
    }

    fun createFolder(quarryId: String, name: String, parentId: String? = null) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            _uiState.update {
                it.copy(
                    createFolderError = LocalizedMessage(
                        english = "Folder name cannot be empty.",
                        arabic = "لا يمكن أن يكون اسم المجلد فارغاً."
                    )
                )
            }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(isCreatingFolder = true, createFolderError = null) }
            val token = repository.getStoredToken().orEmpty()
            when (val result = repository.createFolder(quarryId = quarryId, name = trimmed, parentId = parentId, token = token)) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            isCreatingFolder = false,
                            isCreateFolderDialogVisible = false,
                            newFolderName = "",
                            folders = it.folders + result.data,
                            createFolderSuccessMessage = LocalizedMessage(
                                english = "Folder created successfully.",
                                arabic = "تم إنشاء المجلد بنجاح."
                            )
                        )
                    }
                    showNotification(
                        LocalizedMessage(
                            english = "Folder created successfully.",
                            arabic = "تم إنشاء المجلد بنجاح."
                        ),
                        NotificationType.SUCCESS
                    )
                    loadQuarryContent(quarryId, parentId)
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapBackendError(result.statusCode, result.message, result.code)
                    _uiState.update {
                        it.copy(
                            isCreatingFolder = false,
                            createFolderError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isCreatingFolder = false,
                            createFolderError = mapped
                        )
                    }
                }
            }
        }
    }

    fun deleteFolder(quarryId: String, folderId: String) {
        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        if (quarry != null && !isCompanyAdmin && !quarry.permissions.canDelete) {
            val denied = LocalizedMessage(
                english = "You do not have permission to delete folders in this quarry.",
                arabic = "ليس لديك صلاحية حذف المجلدات في هذا المحجر."
            )
            _uiState.update { it.copy(deleteFolderError = denied) }
            showNotification(denied, NotificationType.ERROR)
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isDeletingFolder = true, deleteFolderError = null) }
            val token = repository.getStoredToken().orEmpty()
            when (val result = repository.deleteFolder(quarryId = quarryId, folderId = folderId, token = token)) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            isDeletingFolder = false,
                            folders = it.folders.filter { f -> f.id != folderId },
                            deleteFolderSuccessMessage = LocalizedMessage(
                                english = "Folder deleted successfully.",
                                arabic = "تم حذف المجلد بنجاح."
                            )
                        )
                    }
                    showNotification(
                        LocalizedMessage(
                            english = "Folder deleted successfully.",
                            arabic = "تم حذف المجلد بنجاح."
                        ),
                        NotificationType.SUCCESS
                    )
                    loadQuarryContent(quarryId, _uiState.value.currentFolderId)
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapBackendError(result.statusCode, result.message, result.code)
                    _uiState.update {
                        it.copy(
                            isDeletingFolder = false,
                            deleteFolderError = mapped
                        )
                    }
                    showNotification(mapped, NotificationType.ERROR)
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isDeletingFolder = false,
                            deleteFolderError = mapped
                        )
                    }
                    showNotification(mapped, NotificationType.ERROR)
                }
            }
        }
    }

    fun onDocumentSearchQueryChanged(query: String) {
        _uiState.update { it.copy(documentSearchQuery = query) }
    }

    fun openUploadDialog() {
        _uiState.update {
            it.copy(
                isUploadDialogVisible = true,
                uploadError = null,
                uploadSuccessMessage = null
            )
        }
    }

    fun dismissUploadDialog() {
        _uiState.update {
            it.copy(
                isUploadDialogVisible = false,
                uploadError = null
            )
        }
    }

    fun uploadDocument(
        fileBytes: ByteArray,
        filename: String,
        mimeType: String,
        displayName: String?
    ) {
        val quarry = _uiState.value.selectedQuarry ?: return
        val currentFolder = _uiState.value.currentFolderId

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isUploading = true,
                    uploadError = null,
                    uploadSuccessMessage = null
                )
            }

            val result = repository.uploadDocument(
                quarryId = quarry.id,
                fileBytes = fileBytes,
                filename = filename,
                mimeType = mimeType,
                displayName = displayName?.takeIf { it.isNotBlank() },
                folderId = currentFolder
            )

            when (result) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            isUploading = false,
                            isUploadDialogVisible = false,
                            uploadSuccessMessage = LocalizedMessage(
                                english = "Document '${result.data.displayName}' uploaded successfully.",
                                arabic = "تم رفع المستند '${result.data.displayName}' بنجاح."
                            )
                        )
                    }
                    // Refresh documents in current folder
                    loadQuarryContent(quarry.id, currentFolder)
                }
                is ApiResult.Error -> {
                    if (handleAuthFailure(result)) return@launch
                    val mapped = AuthErrorMapper.mapBackendError(
                        result.statusCode,
                        result.message,
                        result.code
                    )
                    _uiState.update {
                        it.copy(
                            isUploading = false,
                            uploadError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isUploading = false,
                            uploadError = mapped
                        )
                    }
                }
            }
        }
    }

    private fun isDocumentDownloadAllowed(document: Document): Boolean {
        val quarry = _uiState.value.selectedQuarry ?: return false
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        return document.status.equals("available", ignoreCase = true) &&
                quarry.id == document.quarryId &&
                (isCompanyAdmin || quarry.permissions.canDownload)
    }

    private fun isDocumentViewAllowed(document: Document): Boolean {
        val quarry = _uiState.value.selectedQuarry ?: return false
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        return document.status.equals("available", ignoreCase = true) &&
                quarry.id == document.quarryId &&
                (isCompanyAdmin || quarry.permissions.canView)
    }

    private fun showDocumentViewDenied() {
        showNotification(
            LocalizedMessage(
                english = "You do not have permission to view documents in this quarry.",
                arabic = "ليس لديك صلاحية عرض المستندات في هذا المحجر."
            ),
            NotificationType.ERROR
        )
    }

    private fun showDownloadDenied() {
        showNotification(
            LocalizedMessage(
                english = "You do not have permission to download this document.",
                arabic = "ليس لديك صلاحية تنزيل هذا المستند."
            ),
            NotificationType.ERROR
        )
    }

    fun downloadDocument(document: Document) {
        val state = _uiState.value
        if (state.isDownloading || state.downloadedDocumentData != null || state.pendingShareDocumentData != null) return
        if (!isDocumentDownloadAllowed(document)) {
            showDownloadDenied()
            return
        }
        _uiState.update {
            it.copy(
                isDownloading = true,
                downloadingDocumentId = document.id,
                downloadError = null,
                downloadSuccessMessage = null,
                downloadedDocumentData = null
            )
        }
        viewModelScope.launch {
            try {
                val result = repository.downloadDocumentPayload(document.id)
                when (result) {
                    is ApiResult.Success -> {
                        val effectiveDoc = if (result.data.filename.isNotBlank()) {
                            document.copy(originalFilename = result.data.filename)
                        } else {
                            document
                        }
                        val currentState = _uiState.value
                        if (currentState.isDownloading && currentState.downloadingDocumentId == document.id &&
                            currentState.selectedQuarry?.id == document.quarryId) {
                            _uiState.update {
                                it.copy(
                                    downloadedDocumentData = Pair(effectiveDoc, result.data.bytes),
                                    downloadSuccessMessage = LocalizedMessage(
                                        english = "Downloaded '${effectiveDoc.displayName}' (${result.data.bytes.size} bytes).",
                                        arabic = "تم تنزيل '${effectiveDoc.displayName}' (${result.data.bytes.size} بايت)."
                                    )
                                )
                            }
                        }
                    }
                    is ApiResult.Error -> {
                        if (handleAuthFailure(result)) return@launch
                        val mapped = AuthErrorMapper.mapBackendError(
                            result.statusCode,
                            result.message,
                            result.code
                        )
                        _uiState.update {
                            it.copy(
                                downloadError = mapped
                            )
                        }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                    is ApiResult.NetworkError -> {
                        val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                        _uiState.update {
                            it.copy(
                                downloadError = mapped
                            )
                        }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                }
            } finally {
                _uiState.update {
                    it.copy(
                        isDownloading = false,
                        downloadingDocumentId = null
                    )
                }
            }
        }
    }

    fun shareDocument(document: Document) {
        val state = _uiState.value
        if (state.isDownloading || state.pendingShareDocumentData != null || state.downloadedDocumentData != null) return
        if (!isDocumentDownloadAllowed(document)) {
            showDownloadDenied()
            return
        }

        _uiState.update {
            it.copy(
                isDownloading = true,
                downloadingDocumentId = document.id,
                downloadError = null,
                pendingShareDocumentData = null
            )
        }
        showNotification(
            LocalizedMessage(
                english = "Preparing document for sharing…",
                arabic = "جارٍ تجهيز المستند للمشاركة…"
            ),
            NotificationType.INFO
        )

        viewModelScope.launch {
            try {
                when (val result = repository.downloadDocumentPayload(document.id)) {
                    is ApiResult.Success -> {
                        val effectiveDoc = if (result.data.filename.isNotBlank()) {
                            document.copy(originalFilename = result.data.filename)
                        } else {
                            document
                        }
                        val currentState = _uiState.value
                        if (currentState.isDownloading && currentState.downloadingDocumentId == document.id &&
                            currentState.selectedQuarry?.id == document.quarryId) {
                            _uiState.update {
                                it.copy(pendingShareDocumentData = Pair(effectiveDoc, result.data.bytes))
                            }
                        }
                    }
                    is ApiResult.Error -> {
                        if (handleAuthFailure(result)) return@launch
                        val mapped = AuthErrorMapper.mapBackendError(result.statusCode, result.message, result.code)
                        _uiState.update { it.copy(downloadError = mapped) }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                    is ApiResult.NetworkError -> {
                        val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                        _uiState.update { it.copy(downloadError = mapped) }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                val mapped = LocalizedMessage(
                    english = "Could not prepare the document for sharing. Please try again.",
                    arabic = "تعذر تجهيز المستند للمشاركة. يرجى المحاولة مرة أخرى."
                )
                _uiState.update { it.copy(downloadError = mapped) }
                showNotification(mapped, NotificationType.ERROR)
            } finally {
                _uiState.update { state ->
                    if (state.pendingShareDocumentData == null) {
                        state.copy(isDownloading = false, downloadingDocumentId = null)
                    } else {
                        state
                    }
                }
            }
        }
    }

    fun clearPendingShareDocument() {
        _uiState.update { state ->
            if (state.pendingShareDocumentData != null) {
                state.copy(
                    pendingShareDocumentData = null,
                    isDownloading = false,
                    downloadingDocumentId = null
                )
            } else {
                state
            }
        }
    }

    fun viewDocument(document: Document) {
        if (_uiState.value.isDownloading) return
        if (!isDocumentViewAllowed(document)) {
            showDocumentViewDenied()
            return
        }
        _uiState.update {
            it.copy(
                isDownloading = true,
                downloadingDocumentId = document.id,
                downloadError = null,
                downloadSuccessMessage = null,
                pendingOpenDocumentData = null
            )
        }
        viewModelScope.launch {
            try {
                val result = repository.viewDocumentPayload(document.id)
                when (result) {
                    is ApiResult.Success -> {
                        val effectiveDoc = if (result.data.filename.isNotBlank()) {
                            document.copy(originalFilename = result.data.filename)
                        } else {
                            document
                        }
                        _uiState.update {
                            it.copy(
                                pendingOpenDocumentData = Pair(effectiveDoc, result.data.bytes)
                            )
                        }
                    }
                    is ApiResult.Error -> {
                        if (handleAuthFailure(result)) return@launch
                        val mapped = AuthErrorMapper.mapBackendError(
                            result.statusCode,
                            result.message,
                            result.code
                        )
                        _uiState.update {
                            it.copy(
                                downloadError = mapped
                            )
                        }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                    is ApiResult.NetworkError -> {
                        val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                        _uiState.update {
                            it.copy(
                                downloadError = mapped
                            )
                        }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                }
            } finally {
                _uiState.update {
                    it.copy(
                        isDownloading = false,
                        downloadingDocumentId = null
                    )
                }
            }
        }
    }

    fun printDocument(document: Document) {
        if (_uiState.value.isDownloading) return
        if (!isDocumentDownloadAllowed(document)) {
            showDownloadDenied()
            return
        }
        _uiState.update {
            it.copy(
                isDownloading = true,
                downloadingDocumentId = document.id,
                downloadError = null,
                downloadSuccessMessage = null,
                pendingPrintDocumentData = null
            )
        }
        viewModelScope.launch {
            try {
                val result = repository.downloadDocumentPayload(document.id)
                when (result) {
                    is ApiResult.Success -> {
                        val effectiveDoc = if (result.data.filename.isNotBlank()) {
                            document.copy(originalFilename = result.data.filename)
                        } else {
                            document
                        }
                        _uiState.update {
                            it.copy(
                                pendingPrintDocumentData = Pair(effectiveDoc, result.data.bytes)
                            )
                        }
                    }
                    is ApiResult.Error -> {
                        if (handleAuthFailure(result)) return@launch
                        val mapped = AuthErrorMapper.mapBackendError(
                            result.statusCode,
                            result.message,
                            result.code
                        )
                        _uiState.update {
                            it.copy(
                                downloadError = mapped
                            )
                        }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                    is ApiResult.NetworkError -> {
                        val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                        _uiState.update {
                            it.copy(
                                downloadError = mapped
                            )
                        }
                        showNotification(mapped, NotificationType.ERROR)
                    }
                }
            } finally {
                _uiState.update {
                    it.copy(
                        isDownloading = false,
                        downloadingDocumentId = null
                    )
                }
            }
        }
    }

    fun renameDocument(quarryId: String, documentId: String, newName: String) {
        if (_uiState.value.isRenamingDocument) return
        val trimmed = newName.trim()
        if (trimmed.isBlank()) {
            val emptyMsg = LocalizedMessage(
                english = "Filename cannot be empty.",
                arabic = "لا يمكن أن يكون اسم الملف فارغاً."
            )
            _uiState.update { it.copy(renameDocumentError = emptyMsg) }
            showNotification(emptyMsg, NotificationType.ERROR)
            return
        }

        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        if (quarry != null && !isCompanyAdmin && !quarry.permissions.canView) {
            val deniedMsg = LocalizedMessage(
                english = "You do not have permission to view or rename documents in this quarry.",
                arabic = "ليس لديك صلاحية عرض أو إعادة تسمية المستندات في هذا المحجر."
            )
            _uiState.update { it.copy(renameDocumentError = deniedMsg) }
            showNotification(deniedMsg, NotificationType.ERROR)
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(isRenamingDocument = true, renameDocumentError = null, renameSuccessMessage = null) }
            val result = repository.renameDocument(quarryId, documentId, trimmed)
            when (result) {
                is ApiResult.Success -> {
                    val updatedDoc = result.data
                    val renameMsg = LocalizedMessage(
                        english = "Document renamed successfully.",
                        arabic = "تمت إعادة تسمية المستند بنجاح."
                    )
                    _uiState.update { state ->
                        val updatedList = state.documents.map { doc ->
                            if (doc.id == documentId) updatedDoc else doc
                        }
                        state.copy(
                            isRenamingDocument = false,
                            documents = updatedList,
                            renameSuccessMessage = renameMsg
                        )
                    }
                    showNotification(renameMsg, NotificationType.SUCCESS)
                }
                is ApiResult.Error -> {
                    val isPermissionDenied = result.statusCode == 403 || result.message.contains("permission", ignoreCase = true)
                    val isConflict = result.statusCode == 409
                    val err = if (isPermissionDenied) {
                        LocalizedMessage(
                            english = "You do not have permission to rename documents in this quarry.",
                            arabic = "ليس لديك صلاحية إعادة تسمية المستندات في هذا المحجر."
                        )
                    } else if (isConflict) {
                        LocalizedMessage(
                            english = "A document with this name already exists in this folder.",
                            arabic = "يوجد مستند بهذا الاسم بالفعل في هذا المجلد."
                        )
                    } else {
                        LocalizedMessage(
                            english = "Could not rename the document. Please try again.",
                            arabic = "تعذر إعادة تسمية المستند. يرجى المحاولة مرة أخرى."
                        )
                    }
                    _uiState.update {
                        it.copy(
                            isRenamingDocument = false,
                            renameDocumentError = err
                        )
                    }
                    showNotification(err, NotificationType.ERROR)
                }
                is ApiResult.NetworkError -> {
                    val netErr = LocalizedMessage(
                        english = "Network error while renaming document",
                        arabic = "خطأ في الاتصال أثناء إعادة تسمية المستند."
                    )
                    _uiState.update {
                        it.copy(
                            isRenamingDocument = false,
                            renameDocumentError = netErr
                        )
                    }
                    showNotification(netErr, NotificationType.ERROR)
                }
            }
        }
    }

    fun clearMessages() {
        _uiState.update {
            it.copy(
                uploadSuccessMessage = null,
                uploadError = null,
                downloadSuccessMessage = null,
                downloadError = null,
                deleteSuccessMessage = null,
                deleteDocumentError = null,
                restoreSuccessMessage = null,
                restoreError = null
            )
        }
    }

    fun clearPendingOpenDocument() {
        _uiState.update { it.copy(pendingOpenDocumentData = null) }
    }

    fun clearPendingPrintDocument() {
        _uiState.update { it.copy(pendingPrintDocumentData = null) }
    }

    fun clearDownloadedDocumentData() {
        _uiState.update {
            it.copy(
                downloadedDocumentData = null,
                isDownloading = false,
                downloadingDocumentId = null
            )
        }
    }

    fun loadTrash(quarryId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingTrash = true, trashError = null) }
            val result = repository.getTrashDocuments(quarryId)
            _uiState.update { state ->
                when (result) {
                    is ApiResult.Success -> state.copy(
                        trashDocuments = result.data,
                        isLoadingTrash = false
                    )
                    is ApiResult.Error -> state.copy(
                        isLoadingTrash = false,
                        trashError = LocalizedMessage(
                            english = "Could not load the trash. Please try again.",
                            arabic = "تعذر تحميل سلة المهملات. يرجى المحاولة مرة أخرى."
                        )
                    )
                    is ApiResult.NetworkError -> state.copy(
                        isLoadingTrash = false,
                        trashError = LocalizedMessage(
                            english = "Network connection failed",
                            arabic = "تعذر الاتصال بالخادم. يرجى التحقق من الشبكة."
                        )
                    )
                }
            }
        }
    }

    fun loadCompanyTrash() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingTrash = true, trashError = null) }
            val result = repository.getCompanyTrash()
            _uiState.update { state ->
                when (result) {
                    is ApiResult.Success -> state.copy(
                        trashDocuments = result.data,
                        isLoadingTrash = false
                    )
                    is ApiResult.Error -> state.copy(
                        isLoadingTrash = false,
                        trashError = LocalizedMessage(
                            english = "Could not load company trash. Please try again.",
                            arabic = "تعذر تحميل سلة مهملات الشركة. يرجى المحاولة مرة أخرى."
                        )
                    )
                    is ApiResult.NetworkError -> state.copy(
                        isLoadingTrash = false,
                        trashError = LocalizedMessage(
                            english = "Network connection failed",
                            arabic = "تعذر الاتصال بالخادم. يرجى التحقق من الشبكة."
                        )
                    )
                }
            }
        }
    }

    fun deleteDocument(quarryId: String, documentId: String, version: Int? = null) {
        if (_uiState.value.isDeletingDocument) return
        val quarry = _uiState.value.quarries.find { it.id == quarryId } ?: _uiState.value.selectedQuarry
        val isCompanyAdmin = _uiState.value.profile?.role == "company_admin"
        if (quarry != null && !isCompanyAdmin && !quarry.permissions.canDelete) {
            val deniedMsg = LocalizedMessage(
                english = "You do not have permission to delete documents in this quarry.",
                arabic = "ليس لديك صلاحية حذف المستندات في هذا المحجر."
            )
            _uiState.update {
                it.copy(
                    deleteDocumentError = deniedMsg
                )
            }
            showNotification(deniedMsg, NotificationType.ERROR)
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(isDeletingDocument = true, deleteDocumentError = null, deleteSuccessMessage = null) }
            val result = repository.deleteDocument(quarryId, documentId, version)
            val currentFolder = _uiState.value.currentFolderId
            when (result) {
                is ApiResult.Success -> {
                    val delMsg = LocalizedMessage(
                        english = "Document moved to trash.",
                        arabic = "تم نقل المستند إلى سلة المهملات بنجاح."
                    )
                    _uiState.update {
                        it.copy(
                            isDeletingDocument = false,
                            deleteSuccessMessage = delMsg
                        )
                    }
                    loadQuarryContent(quarryId, currentFolder)
                    showNotification(delMsg, NotificationType.SUCCESS)
                }
                is ApiResult.Error -> {
                    val isPermissionDenied = result.statusCode == 403 || result.message.contains("permission", ignoreCase = true)
                    val err = if (isPermissionDenied) {
                        LocalizedMessage(
                            english = "You do not have permission to delete documents in this quarry.",
                            arabic = "ليس لديك صلاحية حذف المستندات في هذا المحجر."
                        )
                    } else {
                        LocalizedMessage(
                            english = "Could not move the document to trash. Please try again.",
                            arabic = "تعذر نقل المستند إلى سلة المهملات. يرجى المحاولة مرة أخرى."
                        )
                    }
                    _uiState.update {
                        it.copy(
                            isDeletingDocument = false,
                            deleteDocumentError = err
                        )
                    }
                    showNotification(err, NotificationType.ERROR)
                }
                is ApiResult.NetworkError -> {
                    val netErr = LocalizedMessage(
                        english = "Network error while deleting document",
                        arabic = "خطأ في الاتصال أثناء حذف المستند."
                    )
                    _uiState.update {
                        it.copy(
                            isDeletingDocument = false,
                            deleteDocumentError = netErr
                        )
                    }
                    showNotification(netErr, NotificationType.ERROR)
                }
            }
        }
    }

    fun permanentlyDeleteDocument(quarryId: String, documentId: String) {
        viewModelScope.launch {
            val result = repository.permanentlyDeleteDocument(quarryId, documentId)
            when (result) {
                is ApiResult.Success -> {
                    val msg = LocalizedMessage(
                        english = "Document permanently deleted successfully.",
                        arabic = "تم حذف المستند نهائياً بنجاح."
                    )
                    _uiState.update {
                        it.copy(
                            trashDocuments = it.trashDocuments.filter { doc -> doc.id != documentId }
                        )
                    }
                    if (quarryId.isNotBlank()) {
                        loadTrash(quarryId)
                    }
                    loadCompanyTrash()
                    showNotification(msg, NotificationType.SUCCESS)
                }
                is ApiResult.Error -> {
                    val err = LocalizedMessage(
                        english = "Could not permanently delete the document. Please try again.",
                        arabic = "تعذر حذف المستند نهائياً. يرجى المحاولة مرة أخرى."
                    )
                    showNotification(err, NotificationType.ERROR)
                }
                is ApiResult.NetworkError -> {
                    val netErr = LocalizedMessage(
                        english = "Network error while deleting document",
                        arabic = "خطأ في الاتصال أثناء حذف المستند."
                    )
                    showNotification(netErr, NotificationType.ERROR)
                }
            }
        }
    }

    fun restoreDocument(quarryId: String, documentId: String, version: Int? = null) {
        if (_uiState.value.isRestoringDocument) return
        viewModelScope.launch {
            _uiState.update { it.copy(isRestoringDocument = true, restoreError = null, restoreSuccessMessage = null) }
            val result = if (quarryId.isNotBlank()) {
                repository.restoreDocument(quarryId, documentId, version)
            } else {
                repository.restoreCompanyTrashDocument(documentId, version)
            }
            when (result) {
                is ApiResult.Success -> {
                    val resMsg = LocalizedMessage(
                        english = "Document restored successfully to its original location.",
                        arabic = "تمت استعادة المستند بنجاح إلى مكانه الأصلي."
                    )
                    _uiState.update {
                        it.copy(
                            isRestoringDocument = false,
                            restoreSuccessMessage = resMsg
                        )
                    }
                    if (quarryId.isNotBlank()) {
                        loadTrash(quarryId)
                    }
                    loadCompanyTrash()
                    showNotification(resMsg, NotificationType.SUCCESS)
                }
                is ApiResult.Error -> {
                    val isConflict = result.statusCode == 409 || result.message.contains("يوجد ملف بنفس الاسم", ignoreCase = true)
                    val err = if (isConflict) {
                        LocalizedMessage(
                            english = "A file with the same name already exists in the destination folder.",
                            arabic = "يوجد ملف نشط بنفس الاسم بالفعل في هذا المجلد. يرجى تغيير الاسم لتجنب التعارض."
                        )
                    } else {
                        LocalizedMessage(
                            english = "Could not restore the document. Please try again.",
                            arabic = "تعذر استعادة المستند. يرجى المحاولة مرة أخرى."
                        )
                    }
                    _uiState.update {
                        it.copy(
                            isRestoringDocument = false,
                            restoreError = err
                        )
                    }
                    showNotification(err, NotificationType.ERROR)
                }
                is ApiResult.NetworkError -> {
                    val netErr = LocalizedMessage(
                        english = "Network error while restoring document",
                        arabic = "خطأ في الاتصال أثناء استعادة المستند."
                    )
                    _uiState.update {
                        it.copy(
                            isRestoringDocument = false,
                            restoreError = netErr
                        )
                    }
                    showNotification(netErr, NotificationType.ERROR)
                }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            repository.logout()
            _uiState.update {
                it.copy(
                    isAuthenticated = false,
                    password = "",
                    profile = null,
                    loginError = null,
                    profileError = null,
                    currentScreen = AppScreen.LOGIN,
                    quarries = emptyList(),
                    selectedQuarry = null,
                    folders = emptyList(),
                    documents = emptyList()
                )
            }
        }
    }

    // =========================================================================
    // Document Scanner Implementation
    // =========================================================================

    var customCacheDir: File? = null

    private fun getScansCacheDir(): File {
        val base = customCacheDir ?: File(System.getProperty("java.io.tmpdir"), "quarryvault_scans")
        return File(base, "quarryvault_scans").apply { mkdirs() }
    }

    private fun generateDefaultScanName(): String {
        val timeStamp = SimpleDateFormat("yyyyMMdd_HHmm", Locale.US).format(Date())
        return "Scan_$timeStamp"
    }

    fun startScanning(quarry: Quarry? = null, folderId: String? = null) {
        val targetQuarry = quarry ?: _uiState.value.selectedQuarry
        val targetFolder = folderId ?: _uiState.value.currentFolderId

        _uiState.update {
            it.copy(
                currentScreen = AppScreen.DOCUMENT_SCANNER,
                scannerStep = ScannerStep.CAMERA,
                targetUploadQuarry = targetQuarry,
                selectedScanFolderId = targetFolder,
                scannedPages = emptyList(),
                activeCapturedFile = null,
                activeDetectedCorners = null,
                activeWarpedBitmap = null,
                activeFilterMode = ScanFilterMode.DOCUMENT_ENHANCED,
                activeRotationDegrees = 0,
                scanDocumentName = generateDefaultScanName(),
                scanIdempotencyKey = UUID.randomUUID().toString(),
                generatedPdfFile = null,
                isGeneratingPdf = false,
                isUploadingScan = false,
                scanUploadError = null,
                scanUploadSuccessMessage = null
            )
        }
    }

    fun onPageCaptured(rawFile: File) {
        _uiState.update {
            it.copy(
                activeCapturedFile = rawFile,
                scannerStep = ScannerStep.CROP
            )
        }
        viewModelScope.launch(defaultDispatcher) {
            val bitmap = BitmapFactory.decodeFile(rawFile.absolutePath)
            val detected = bitmap?.let { EdgeDetector.detectCorners(it) } ?: DocumentCorners.defaultCorners()
            _uiState.update {
                it.copy(activeDetectedCorners = detected)
            }
        }
    }

    fun onCornersAdjusted(bitmap: Bitmap, corners: DocumentCorners) {
        viewModelScope.launch(defaultDispatcher) {
            val warped = ImageProcessor.warpPerspective(bitmap, corners)
            _uiState.update {
                it.copy(
                    activeWarpedBitmap = warped,
                    activeFilterMode = ScanFilterMode.DOCUMENT_ENHANCED,
                    activeRotationDegrees = 0,
                    scannerStep = ScannerStep.FILTER
                )
            }
        }
    }

    fun commitActivePage(
        finalBitmap: Bitmap,
        filter: ScanFilterMode,
        rotation: Int,
        addAnotherPage: Boolean
    ) {
        viewModelScope.launch(ioDispatcher) {
            val pageId = UUID.randomUUID().toString()
            val pageFile = File(getScansCacheDir(), "PAGE_${pageId}.jpg")
            ImageProcessor.saveBitmap(finalBitmap, pageFile)

            val page = ScannedPage(
                id = pageId,
                imageFile = pageFile,
                rotationDegrees = 0,
                filterMode = filter,
                width = finalBitmap.width,
                height = finalBitmap.height
            )

            val updatedPages = _uiState.value.scannedPages + page

            _uiState.update {
                it.copy(
                    scannedPages = updatedPages,
                    activeCapturedFile = null,
                    activeWarpedBitmap = null,
                    scannerStep = if (addAnotherPage) ScannerStep.CAMERA else ScannerStep.REVIEW
                )
            }

            if (!addAnotherPage) {
                generatePdfFromPages(updatedPages)
            }
        }
    }

    fun generatePdfFromPages(pages: List<ScannedPage>) {
        if (pages.isEmpty()) return
        viewModelScope.launch(ioDispatcher) {
            _uiState.update { it.copy(isGeneratingPdf = true, scanUploadError = null) }
            val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
            val pdfFile = File(getScansCacheDir(), "DOC_${timeStamp}.pdf")

            val result = PdfDocumentGenerator.generatePdf(pages, pdfFile)
            if (result.isSuccess) {
                _uiState.update {
                    it.copy(
                        generatedPdfFile = result.getOrNull(),
                        isGeneratingPdf = false
                    )
                }
            } else {
                _uiState.update {
                    it.copy(
                        isGeneratingPdf = false,
                        scanUploadError = LocalizedMessage(
                            english = "Could not generate the PDF. Please try again.",
                            arabic = "تعذر إنشاء ملف PDF. يرجى المحاولة مرة أخرى."
                        )
                    )
                }
            }
        }
    }

    fun reorderScannedPages(fromIndex: Int, toIndex: Int) {
        val currentList = _uiState.value.scannedPages.toMutableList()
        if (fromIndex in currentList.indices && toIndex in currentList.indices && fromIndex != toIndex) {
            val item = currentList.removeAt(fromIndex)
            currentList.add(toIndex, item)
            _uiState.update { it.copy(scannedPages = currentList) }
            generatePdfFromPages(currentList)
        }
    }

    fun deleteScannedPage(pageId: String) {
        val currentList = _uiState.value.scannedPages.toMutableList()
        val pageToDelete = currentList.firstOrNull { it.id == pageId }
        if (pageToDelete != null) {
            currentList.remove(pageToDelete)
            try {
                pageToDelete.imageFile.delete()
            } catch (_: Exception) {}

            _uiState.update { it.copy(scannedPages = currentList) }
            if (currentList.isNotEmpty()) {
                generatePdfFromPages(currentList)
            } else {
                _uiState.update { it.copy(scannerStep = ScannerStep.CAMERA, generatedPdfFile = null) }
            }
        }
    }

    fun resumeCameraScanning() {
        _uiState.update { it.copy(scannerStep = ScannerStep.CAMERA) }
    }

    fun openScannerReview() {
        _uiState.update { it.copy(scannerStep = ScannerStep.REVIEW) }
        if (_uiState.value.generatedPdfFile == null && _uiState.value.scannedPages.isNotEmpty()) {
            generatePdfFromPages(_uiState.value.scannedPages)
        }
    }

    fun retakeActiveCapture() {
        try {
            _uiState.value.activeCapturedFile?.delete()
        } catch (_: Exception) {}
        _uiState.update {
            it.copy(
                activeCapturedFile = null,
                activeWarpedBitmap = null,
                scannerStep = ScannerStep.CAMERA
            )
        }
    }

    fun onScanDocumentNameChanged(name: String) {
        _uiState.update { it.copy(scanDocumentName = name) }
    }

    fun onTargetQuarryChanged(quarry: Quarry) {
        _uiState.update { it.copy(targetUploadQuarry = quarry) }
    }

    fun onScanFolderSelected(folderId: String?) {
        _uiState.update { it.copy(selectedScanFolderId = folderId) }
    }

    fun uploadScannedDocument() {
        val state = _uiState.value
        val quarry = state.targetUploadQuarry ?: state.selectedQuarry ?: return
        val pages = state.scannedPages
        if (pages.isEmpty()) return

        val cleanName = state.scanDocumentName.trim().ifBlank { generateDefaultScanName() }
        val filename = if (cleanName.endsWith(".pdf", ignoreCase = true)) cleanName else "$cleanName.pdf"

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isUploadingScan = true,
                    scanUploadError = null
                )
            }

            var pdfFile = state.generatedPdfFile
            if (pdfFile == null || !pdfFile.exists() || pdfFile.length() == 0L) {
                val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                val newPdfFile = File(getScansCacheDir(), "DOC_${timeStamp}.pdf")
                val genResult = PdfDocumentGenerator.generatePdf(pages, newPdfFile)
                if (genResult.isFailure) {
                    _uiState.update {
                        it.copy(
                            isUploadingScan = false,
                            scanUploadError = LocalizedMessage(
                                english = "Could not create the PDF before upload. Please try again.",
                                arabic = "تعذر إنشاء ملف PDF قبل الرفع. يرجى المحاولة مرة أخرى."
                            )
                        )
                    }
                    return@launch
                }
                pdfFile = newPdfFile
                _uiState.update { it.copy(generatedPdfFile = newPdfFile) }
            }

            val fileBytes = withContext(ioDispatcher) {
                try {
                    pdfFile.readBytes()
                } catch (e: Exception) {
                    null
                }
            }

            if (fileBytes == null || fileBytes.isEmpty()) {
                _uiState.update {
                    it.copy(
                        isUploadingScan = false,
                        scanUploadError = LocalizedMessage(
                            english = "Failed to read generated PDF bytes.",
                            arabic = "فشل في قراءة بيانات ملف PDF المنشأ."
                        )
                    )
                }
                return@launch
            }

            val result = repository.uploadDocument(
                quarryId = quarry.id,
                fileBytes = fileBytes,
                filename = filename,
                mimeType = "application/pdf",
                displayName = cleanName.removeSuffix(".pdf"),
                folderId = state.selectedScanFolderId,
                idempotencyKey = state.scanIdempotencyKey
            )

            when (result) {
                is ApiResult.Success -> {
                    // Clean up temporary files on successful upload
                    withContext(ioDispatcher) {
                        try {
                            pdfFile.delete()
                            for (p in pages) {
                                p.imageFile.delete()
                            }
                        } catch (_: Exception) {}
                    }

                    val scanMsg = LocalizedMessage(
                        english = "Scanned document '${result.data.displayName}' uploaded successfully.",
                        arabic = "تم رفع المستند الممسوح ضوئيًا '${result.data.displayName}' بنجاح."
                    )
                    _uiState.update {
                        it.copy(
                            isUploadingScan = false,
                            currentScreen = AppScreen.QUARRY_DETAIL,
                            selectedQuarry = quarry,
                            currentFolderId = state.selectedScanFolderId,
                            scannedPages = emptyList(),
                            generatedPdfFile = null,
                            uploadSuccessMessage = scanMsg
                        )
                    }
                    showNotification(scanMsg, NotificationType.SUCCESS)

                    // Reload target quarry content
                    loadQuarryContent(quarry.id, state.selectedScanFolderId)
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapBackendError(
                        statusCode = result.statusCode,
                        detail = result.message,
                        code = result.code
                    )
                    _uiState.update {
                        it.copy(
                            isUploadingScan = false,
                            scanUploadError = mapped
                        )
                    }
                    showNotification(mapped, NotificationType.ERROR)
                }
                is ApiResult.NetworkError -> {
                    val networkError = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isUploadingScan = false,
                            scanUploadError = networkError
                        )
                    }
                }
            }
        }
    }

    fun cancelScanning() {
        val pages = _uiState.value.scannedPages
        val pdf = _uiState.value.generatedPdfFile
        val activeRaw = _uiState.value.activeCapturedFile

        viewModelScope.launch(ioDispatcher) {
            try {
                pdf?.delete()
                activeRaw?.delete()
                for (p in pages) {
                    p.imageFile.delete()
                }
            } catch (_: Exception) {}
        }

        _uiState.update {
            it.copy(
                currentScreen = if (it.selectedQuarry != null) AppScreen.QUARRY_DETAIL else AppScreen.HOME,
                scannerStep = ScannerStep.CAMERA,
                scannedPages = emptyList(),
                activeCapturedFile = null,
                activeDetectedCorners = null,
                activeWarpedBitmap = null,
                generatedPdfFile = null,
                scanUploadError = null,
                isGeneratingPdf = false,
                isUploadingScan = false
            )
        }
    }

    // ------------------------------------------------------------------------
    // Phase 11: Mandatory Password Change Workflow
    // ------------------------------------------------------------------------

    fun onNewPasswordChanged(value: String) {
        _uiState.update { it.copy(newPassword = value, passwordChangeError = null) }
    }

    fun onConfirmPasswordChanged(value: String) {
        _uiState.update { it.copy(confirmPassword = value, passwordChangeError = null) }
    }

    fun changePassword() {
        val state = _uiState.value
        val newPass = state.newPassword.trim()
        val confirmPass = state.confirmPassword.trim()

        if (newPass.length < 8) {
            val err = LocalizedMessage(
                english = "Password must be at least 8 characters long.",
                arabic = "يجب أن تتكون كلمة المرور من 8 أحرف على الأقل."
            )
            _uiState.update { it.copy(passwordChangeError = err) }
            showNotification(err, NotificationType.ERROR)
            return
        }

        if (newPass != confirmPass) {
            val err = LocalizedMessage(
                english = "Passwords do not match.",
                arabic = "كلمتا المرور غير متطابقتين."
            )
            _uiState.update { it.copy(passwordChangeError = err) }
            showNotification(err, NotificationType.ERROR)
            return
        }

        val effectiveToken = repository.getStoredToken()

        if (effectiveToken.isNullOrBlank()) {
            val err = LocalizedMessage(
                english = "No authentication token available. Please sign in.",
                arabic = "لا يوجد رمز مصادقة متاح. يرجى تسجيل الدخول."
            )
            _uiState.update { it.copy(passwordChangeError = err) }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(isChangingPassword = true, passwordChangeError = null) }

            when (val result = repository.changePassword(newPass, confirmPass, state.password, effectiveToken)) {
                is ApiResult.Success -> {
                    repository.logout()
                    _uiState.update {
                        it.copy(
                            isChangingPassword = false,
                            isAuthenticated = false,
                            currentScreen = AppScreen.LOGIN,
                            quarries = emptyList(),
                            selectedQuarry = null,
                            documents = emptyList(),
                            folders = emptyList(),
                            password = "",
                            newPassword = "",
                            confirmPassword = "",
                            passwordChangeError = null
                        )
                    }
                    showNotification(
                        message = LocalizedMessage(
                            english = "Password updated successfully. Your secure session has been refreshed.",
                            arabic = "تم تحديث كلمة المرور بنجاح وتجديد جلسة الدخول الآمنة."
                        ),
                        type = NotificationType.SUCCESS
                    )
                }
                is ApiResult.Error -> {
                    if (handleAuthFailure(result)) return@launch
                    val mapped = AuthErrorMapper.mapBackendError(
                        result.statusCode,
                        result.message,
                        result.code
                    )
                    _uiState.update {
                        it.copy(
                            isChangingPassword = false,
                            passwordChangeError = mapped
                        )
                    }
                    showNotification(mapped, NotificationType.ERROR)
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isChangingPassword = false,
                            passwordChangeError = mapped
                        )
                    }
                    showNotification(mapped, NotificationType.ERROR)
                }
            }
        }
    }

    fun logoutFromPasswordChange() {
        logout()
    }

    // -------------------------------------------------------------
    // Employee Management (Feature 2)
    // -------------------------------------------------------------

    fun navigateToEmployeeManagement() {
        if (_uiState.value.profile?.role == "company_admin") {
            _uiState.update { it.copy(currentScreen = AppScreen.EMPLOYEE_MANAGEMENT, employeesError = null) }
            loadCompanyEmployees()
        }
    }

    fun navigateBackFromEmployeeManagement() {
        _uiState.update { it.copy(currentScreen = AppScreen.HOME) }
    }

    fun loadCompanyEmployees() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingEmployees = true, employeesError = null) }
            when (val result = repository.getCompanyEmployees()) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            isLoadingEmployees = false,
                            employees = result.data,
                            employeesError = null
                        )
                    }
                }
                is ApiResult.Error -> {
                    if (handleAuthFailure(result)) return@launch
                    val mapped = AuthErrorMapper.mapBackendError(
                        result.statusCode,
                        result.message,
                        result.code
                    )
                    _uiState.update {
                        it.copy(
                            isLoadingEmployees = false,
                            employeesError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    _uiState.update {
                        it.copy(
                            isLoadingEmployees = false,
                            employeesError = AuthErrorMapper.mapNetworkError(result.throwable)
                        )
                    }
                }
            }
        }
    }

    fun openCreateEmployeeDialog() {
        _uiState.update {
            it.copy(
                isCreateEmployeeDialogVisible = true,
                isReviewEmployeeDialogVisible = false,
                createEmployeeError = null,
                createEmployeeSuccessMessage = null,
                newEmployeeUsername = "",
                newEmployeePassword = "",
                newEmployeeFullName = "",
                newEmployeeEmail = "",
                selectedEmployeeQuarries = emptyMap()
            )
        }
    }

    fun dismissCreateEmployeeDialog() {
        _uiState.update {
            it.copy(
                isCreateEmployeeDialogVisible = false,
                isReviewEmployeeDialogVisible = false,
                createEmployeeError = null
            )
        }
    }

    fun onNewEmployeeUsernameChanged(value: String) {
        _uiState.update { it.copy(newEmployeeUsername = value, createEmployeeError = null) }
    }

    fun onNewEmployeePasswordChanged(value: String) {
        _uiState.update { it.copy(newEmployeePassword = value, createEmployeeError = null) }
    }

    fun onNewEmployeeFullNameChanged(value: String) {
        _uiState.update { it.copy(newEmployeeFullName = value) }
    }

    fun onNewEmployeeEmailChanged(value: String) {
        _uiState.update { it.copy(newEmployeeEmail = value) }
    }

    fun toggleQuarryAssignment(quarryId: String) {
        _uiState.update { current ->
            val updated = current.selectedEmployeeQuarries.toMutableMap()
            if (updated.containsKey(quarryId)) {
                updated.remove(quarryId)
            } else {
                // Default permissions: canView=true, upload/download/delete=false
                updated[quarryId] = QuarryInitialPermissionRequest(
                    quarryId = quarryId,
                    canView = true,
                    canUpload = false,
                    canDownload = false,
                    canDelete = false
                )
            }
            current.copy(selectedEmployeeQuarries = updated)
        }
    }

    fun updateQuarryPermission(
        quarryId: String,
        canView: Boolean,
        canUpload: Boolean,
        canDownload: Boolean,
        canDelete: Boolean
    ) {
        _uiState.update { current ->
            val updated = current.selectedEmployeeQuarries.toMutableMap()
            updated[quarryId] = QuarryInitialPermissionRequest(
                quarryId = quarryId,
                canView = canView,
                canUpload = canUpload,
                canDownload = canDownload,
                canDelete = canDelete
            )
            current.copy(selectedEmployeeQuarries = updated)
        }
    }

    fun updateNewEmployeePermissions(
        canView: Boolean? = null,
        canUpload: Boolean? = null,
        canDownload: Boolean? = null,
        canDelete: Boolean? = null
    ) {
        _uiState.update {
            it.copy(
                newEmployeeCanView = canView ?: it.newEmployeeCanView,
                newEmployeeCanUpload = canUpload ?: it.newEmployeeCanUpload,
                newEmployeeCanDownload = canDownload ?: it.newEmployeeCanDownload,
                newEmployeeCanDelete = canDelete ?: it.newEmployeeCanDelete
            )
        }
    }

    fun toggleQuarryVisibilityForNewEmployee(quarryId: String) {
        _uiState.update { current ->
            val set = current.newEmployeeHiddenQuarries.toMutableSet()
            if (set.contains(quarryId)) {
                set.remove(quarryId)
            } else {
                set.add(quarryId)
            }
            current.copy(newEmployeeHiddenQuarries = set)
        }
    }

    fun openReviewDialog() {
        val state = _uiState.value
        val username = state.newEmployeeUsername.trim()
        val password = state.newEmployeePassword

        if (username.length < 3) {
            _uiState.update {
                it.copy(
                    createEmployeeError = LocalizedMessage(
                        english = "Username must be at least 3 characters.",
                        arabic = "اسم المستخدم يجب أن يتكون من 3 أحرف على الأقل."
                    )
                )
            }
            return
        }

        if (password.length < 8) {
            _uiState.update {
                it.copy(
                    createEmployeeError = LocalizedMessage(
                        english = "Password must be at least 8 characters.",
                        arabic = "كلمة المرور يجب ألا تقل عن 8 أحرف."
                    )
                )
            }
            return
        }

        _uiState.update {
            it.copy(isReviewEmployeeDialogVisible = true, createEmployeeError = null)
        }
    }

    fun dismissReviewDialog() {
        _uiState.update { it.copy(isReviewEmployeeDialogVisible = false) }
    }

    fun submitCreateEmployee() {
        val state = _uiState.value
        val username = state.newEmployeeUsername.trim()
        val password = state.newEmployeePassword
        val fullName = state.newEmployeeFullName.trim().takeIf { it.isNotEmpty() }
        val email = state.newEmployeeEmail.trim().takeIf { it.isNotEmpty() }

        val quarryPerms = state.selectedEmployeeQuarries.values.toList()

        val request = CreateEmployeeRequest(
            username = username,
            password = password,
            fullName = fullName,
            email = email,
            permissions = com.quarryvault.employee.data.api.models.GeneralPermissionsPayload(
                canView = state.newEmployeeCanView,
                canUpload = state.newEmployeeCanUpload,
                canDownload = state.newEmployeeCanDownload,
                canDelete = state.newEmployeeCanDelete
            ),
            hiddenQuarries = state.newEmployeeHiddenQuarries.toList(),
            quarryPermissions = quarryPerms,
            defaultAccessAllQuarries = false
        )

        viewModelScope.launch {
            _uiState.update { it.copy(isCreatingEmployee = true, createEmployeeError = null) }
            when (val result = repository.createCompanyEmployee(request)) {
                is ApiResult.Success -> {
                    val succMsg = LocalizedMessage(
                        english = "Employee account created successfully.",
                        arabic = "تم إنشاء حساب الموظف بنجاح."
                    )
                    _uiState.update {
                        it.copy(
                            isCreatingEmployee = false,
                            isCreateEmployeeDialogVisible = false,
                            isReviewEmployeeDialogVisible = false,
                            createEmployeeSuccessMessage = succMsg,
                            newEmployeeUsername = "",
                            newEmployeePassword = "",
                            newEmployeeFullName = "",
                            newEmployeeEmail = "",
                            newEmployeeCanView = true,
                            newEmployeeCanUpload = true,
                            newEmployeeCanDownload = true,
                            newEmployeeCanDelete = false,
                            newEmployeeHiddenQuarries = emptySet(),
                            selectedEmployeeQuarries = emptyMap()
                        )
                    }
                    showNotification(succMsg, NotificationType.SUCCESS)
                    loadCompanyEmployees()
                }
                is ApiResult.Error -> {
                    if (handleAuthFailure(result)) return@launch
                    val mapped = AuthErrorMapper.mapBackendError(
                        result.statusCode,
                        result.message,
                        result.code
                    )
                    _uiState.update {
                        it.copy(
                            isCreatingEmployee = false,
                            createEmployeeError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    _uiState.update {
                        it.copy(
                            isCreatingEmployee = false,
                            createEmployeeError = AuthErrorMapper.mapNetworkError(result.throwable)
                        )
                    }
                }
            }
        }
    }

    fun dismissEmployeeSuccessMessage() {
        _uiState.update { it.copy(createEmployeeSuccessMessage = null) }
    }
}
