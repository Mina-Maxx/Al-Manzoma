package com.quarryvault.employee.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.data.api.models.Folder
import com.quarryvault.employee.data.api.models.HealthResponse
import com.quarryvault.employee.data.api.models.MeResponse
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.TrashDocument
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
    TRASH
}

enum class ScannerStep {
    CAMERA,
    CROP,
    FILTER,
    REVIEW
}

data class EmployeeAppUiState(
    val currentScreen: AppScreen = AppScreen.LOGIN,
    val email: String = "",
    val password: String = "",
    val backendBaseUrl: String = "",
    val supabaseUrl: String = "",
    val supabaseAnonKey: String = "",
    val manualToken: String = "",
    val isAuthenticated: Boolean = false,
    val isAuthenticating: Boolean = false,
    val isLoadingProfile: Boolean = false,
    val loginError: LocalizedMessage? = null,
    val profileError: LocalizedMessage? = null,
    val profile: MeResponse? = null,
    val healthState: RequestState<HealthResponse> = RequestState.Idle,
    val isDiagnosticsExpanded: Boolean = false,
    val isArabic: Boolean = false,

    // Quarries list
    val quarries: List<Quarry> = emptyList(),
    val isLoadingQuarries: Boolean = false,
    val quarriesError: LocalizedMessage? = null,
    val quarrySearchQuery: String = "",

    // Quarry Creation
    val isCreateQuarryDialogVisible: Boolean = false,
    val newQuarryName: String = "",
    val isCreatingQuarry: Boolean = false,
    val createQuarryError: LocalizedMessage? = null,
    val createQuarrySuccessMessage: LocalizedMessage? = null,

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
    val scanIdempotencyKey: String = UUID.randomUUID().toString()
)

class EmployeeAppViewModel(
    private val repository: EmployeeRepository = DefaultEmployeeRepository(),
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val defaultDispatcher: CoroutineDispatcher = Dispatchers.Default
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        EmployeeAppUiState(
            email = repository.getStoredEmail().orEmpty(),
            backendBaseUrl = repository.backendBaseUrl,
            supabaseUrl = repository.supabaseUrl,
            supabaseAnonKey = repository.supabaseAnonKey,
            manualToken = repository.getStoredToken().orEmpty(),
            isAuthenticated = false
        )
    )
    val uiState: StateFlow<EmployeeAppUiState> = _uiState.asStateFlow()

    init {
        // If an active session exists in storage, attempt to load profile automatically
        if (repository.hasStoredSession()) {
            val token = repository.getStoredToken()
            if (!token.isNullOrBlank()) {
                fetchProfile(token)
            }
        }
    }

    fun toggleLanguage() {
        _uiState.update { it.copy(isArabic = !it.isArabic) }
    }

    fun onEmailChanged(newEmail: String) {
        _uiState.update { it.copy(email = newEmail, loginError = null) }
    }

    fun onPasswordChanged(newPassword: String) {
        _uiState.update { it.copy(password = newPassword, loginError = null) }
    }

    fun updateBackendUrl(newUrl: String) {
        val trimmed = newUrl.trim()
        repository.backendBaseUrl = trimmed
        _uiState.update { it.copy(backendBaseUrl = trimmed) }
    }

    fun updateSupabaseUrl(newUrl: String) {
        val trimmed = newUrl.trim()
        repository.supabaseUrl = trimmed
        _uiState.update { it.copy(supabaseUrl = trimmed) }
    }

    fun updateSupabaseAnonKey(newKey: String) {
        val trimmed = newKey.trim()
        repository.supabaseAnonKey = trimmed
        _uiState.update { it.copy(supabaseAnonKey = trimmed) }
    }

    fun updateManualToken(newToken: String) {
        _uiState.update { it.copy(manualToken = newToken.trim()) }
    }

    fun toggleDiagnostics() {
        _uiState.update { it.copy(isDiagnosticsExpanded = !it.isDiagnosticsExpanded) }
    }

    fun login() {
        val email = _uiState.value.email.trim()
        val password = _uiState.value.password

        if (email.isBlank()) {
            _uiState.update {
                it.copy(
                    loginError = LocalizedMessage(
                        english = "Please enter your employee email address.",
                        arabic = "يرجى إدخال البريد الإلكتروني للموظف."
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

            when (val authResult = repository.login(email, password)) {
                is ApiResult.Success -> {
                    val token = authResult.data.accessToken
                    _uiState.update {
                        it.copy(
                            manualToken = token,
                            isAuthenticating = false
                        )
                    }
                    // Next, load employee profile from FastAPI to enforce backend authorization
                    fetchProfile(token)
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapSupabaseError(
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
            ?: _uiState.value.manualToken.trim().takeIf { it.isNotEmpty() }
            ?: repository.getStoredToken()

        if (effectiveToken.isNullOrBlank()) {
            _uiState.update {
                it.copy(
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
                    _uiState.update {
                        it.copy(
                            isAuthenticated = true,
                            isLoadingProfile = false,
                            profile = profileResult.data,
                            profileError = null,
                            loginError = null,
                            currentScreen = AppScreen.HOME
                        )
                    }
                    loadQuarries()
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapBackendError(
                        profileResult.statusCode,
                        profileResult.message,
                        profileResult.code
                    )
                    _uiState.update {
                        it.copy(
                            isAuthenticated = false,
                            isLoadingProfile = false,
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
                            profileError = mapped
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
                createQuarryError = null
            )
        }
    }

    fun dismissCreateQuarryDialog() {
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

    fun clearCreateQuarrySuccessMessage() {
        _uiState.update { it.copy(createQuarrySuccessMessage = null) }
    }

    fun createQuarry() {
        val name = _uiState.value.newQuarryName.trim()
        if (name.isBlank()) {
            _uiState.update {
                it.copy(
                    createQuarryError = LocalizedMessage(
                        arabic = "اسم المحجر مطلوب ولا يمكن أن يكون فارغاً",
                        english = "Quarry name is required and cannot be empty"
                    )
                )
            }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(isCreatingQuarry = true, createQuarryError = null) }
            val result = repository.createQuarry(name)
            when (result) {
                is ApiResult.Success -> {
                    val created = result.data
                    _uiState.update {
                        it.copy(
                            isCreatingQuarry = false,
                            isCreateQuarryDialogVisible = false,
                            createQuarrySuccessMessage = LocalizedMessage(
                                arabic = "تم إنشاء المحجر \"${created.name}\" بنجاح",
                                english = "Quarry \"${created.name}\" created successfully"
                            )
                        )
                    }
                    loadQuarries()
                }
                is ApiResult.Error -> {
                    val msg = when {
                        result.statusCode == 409 || result.message.contains("already exists", ignoreCase = true) -> {
                            LocalizedMessage(
                                arabic = "يوجد محجر مسجل بالفعل بهذا الاسم داخل شركتك",
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
                                arabic = "فشل إنشاء المحجر: ${result.message}",
                                english = "Failed to create quarry: ${result.message}"
                            )
                        }
                    }
                    _uiState.update {
                        it.copy(
                            isCreatingQuarry = false,
                            createQuarryError = msg
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isCreatingQuarry = false,
                            createQuarryError = mapped
                        )
                    }
                }
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
                downloadError = null
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
                documentSearchQuery = ""
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
            ?: return
        _uiState.update {
            it.copy(
                currentScreen = AppScreen.TRASH,
                selectedQuarry = targetQuarry,
                trashError = null
            )
        }
        loadTrash(targetQuarry.id)
    }

    fun navigateBackFromTrash() {
        val quarry = _uiState.value.selectedQuarry
        if (quarry != null) {
            _uiState.update { it.copy(currentScreen = AppScreen.QUARRY_DETAIL, trashError = null) }
            loadQuarryContent(quarry.id, _uiState.value.currentFolderId)
        } else {
            navigateBackToHome()
        }
    }

    fun selectFolder(folderId: String?) {
        val quarry = _uiState.value.selectedQuarry ?: return
        _uiState.update { it.copy(currentFolderId = folderId, contentError = null) }
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

    fun downloadDocument(document: Document) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isDownloading = true,
                    downloadingDocumentId = document.id,
                    downloadError = null,
                    downloadSuccessMessage = null,
                    downloadedDocumentData = null
                )
            }

            val result = repository.downloadDocument(document.id)
            when (result) {
                is ApiResult.Success -> {
                    _uiState.update {
                        it.copy(
                            isDownloading = false,
                            downloadingDocumentId = null,
                            downloadedDocumentData = Pair(document, result.data),
                            downloadSuccessMessage = LocalizedMessage(
                                english = "Downloaded '${document.displayName}' (${result.data.size} bytes).",
                                arabic = "تم تنزيل '${document.displayName}' (${result.data.size} بايت)."
                            )
                        )
                    }
                }
                is ApiResult.Error -> {
                    val mapped = AuthErrorMapper.mapBackendError(
                        result.statusCode,
                        result.message,
                        result.code
                    )
                    _uiState.update {
                        it.copy(
                            isDownloading = false,
                            downloadingDocumentId = null,
                            downloadError = mapped
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    val mapped = AuthErrorMapper.mapNetworkError(result.throwable)
                    _uiState.update {
                        it.copy(
                            isDownloading = false,
                            downloadingDocumentId = null,
                            downloadError = mapped
                        )
                    }
                }
            }
        }
    }

    fun clearDownloadedData() {
        _uiState.update { it.copy(downloadedDocumentData = null) }
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
                            english = result.message ?: "Failed to load trash documents",
                            arabic = "فشل تحميل سلة المهملات: ${result.message ?: ""}"
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
        viewModelScope.launch {
            _uiState.update { it.copy(isDeletingDocument = true, deleteDocumentError = null, deleteSuccessMessage = null) }
            val result = repository.deleteDocument(quarryId, documentId, version)
            _uiState.update { state ->
                when (result) {
                    is ApiResult.Success -> {
                        loadQuarryContent(quarryId, state.currentFolderId)
                        state.copy(
                            isDeletingDocument = false,
                            deleteSuccessMessage = LocalizedMessage(
                                english = "Document moved to trash.",
                                arabic = "تم نقل المستند إلى سلة المهملات بنجاح."
                            )
                        )
                    }
                    is ApiResult.Error -> state.copy(
                        isDeletingDocument = false,
                        deleteDocumentError = LocalizedMessage(
                            english = result.message ?: "Failed to delete document",
                            arabic = "فشل نقل المستند إلى السلة: ${result.message ?: ""}"
                        )
                    )
                    is ApiResult.NetworkError -> state.copy(
                        isDeletingDocument = false,
                        deleteDocumentError = LocalizedMessage(
                            english = "Network error while deleting document",
                            arabic = "خطأ في الاتصال أثناء حذف المستند."
                        )
                    )
                }
            }
        }
    }

    fun restoreDocument(quarryId: String, documentId: String, version: Int? = null) {
        viewModelScope.launch {
            _uiState.update { it.copy(isRestoringDocument = true, restoreError = null, restoreSuccessMessage = null) }
            val result = repository.restoreDocument(quarryId, documentId, version)
            _uiState.update { state ->
                when (result) {
                    is ApiResult.Success -> {
                        loadTrash(quarryId)
                        state.copy(
                            isRestoringDocument = false,
                            restoreSuccessMessage = LocalizedMessage(
                                english = "Document restored successfully.",
                                arabic = "تمت استعادة المستند بنجاح."
                            )
                        )
                    }
                    is ApiResult.Error -> state.copy(
                        isRestoringDocument = false,
                        restoreError = LocalizedMessage(
                            english = result.message ?: "Failed to restore document",
                            arabic = "فشل استعادة المستند: ${result.message ?: ""}"
                        )
                    )
                    is ApiResult.NetworkError -> state.copy(
                        isRestoringDocument = false,
                        restoreError = LocalizedMessage(
                            english = "Network error while restoring document",
                            arabic = "خطأ في الاتصال أثناء استعادة المستند."
                        )
                    )
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
                    manualToken = "",
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

    fun checkHealth() {
        viewModelScope.launch {
            _uiState.update { it.copy(healthState = RequestState.Loading) }
            when (val result = repository.checkHealth()) {
                is ApiResult.Success -> {
                    _uiState.update { it.copy(healthState = RequestState.Success(result.data)) }
                }
                is ApiResult.Error -> {
                    _uiState.update {
                        it.copy(
                            healthState = RequestState.Error(
                                message = "Health check failed (HTTP ${result.statusCode}): ${result.message}",
                                code = result.code
                            )
                        )
                    }
                }
                is ApiResult.NetworkError -> {
                    _uiState.update {
                        it.copy(
                            healthState = RequestState.Error(
                                message = "Network error: ${result.throwable.localizedMessage ?: result.throwable.javaClass.simpleName}"
                            )
                        )
                    }
                }
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
                val errorMsg = result.exceptionOrNull()?.localizedMessage ?: "PDF generation failed"
                _uiState.update {
                    it.copy(
                        isGeneratingPdf = false,
                        scanUploadError = LocalizedMessage(
                            english = "Failed to generate PDF: $errorMsg",
                            arabic = "فشل في إنشاء ملف PDF: $errorMsg"
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
                    val err = genResult.exceptionOrNull()?.localizedMessage ?: "PDF generation error"
                    _uiState.update {
                        it.copy(
                            isUploadingScan = false,
                            scanUploadError = LocalizedMessage(
                                english = "Failed to create PDF before upload: $err",
                                arabic = "تعذر إنشاء ملف PDF قبل الرفع: $err"
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

                    _uiState.update {
                        it.copy(
                            isUploadingScan = false,
                            currentScreen = AppScreen.QUARRY_DETAIL,
                            selectedQuarry = quarry,
                            currentFolderId = state.selectedScanFolderId,
                            scannedPages = emptyList(),
                            generatedPdfFile = null,
                            uploadSuccessMessage = LocalizedMessage(
                                english = "Scanned document '${result.data.displayName}' uploaded successfully.",
                                arabic = "تم رفع المستند الممسوح ضوئيًا '${result.data.displayName}' بنجاح."
                            )
                        )
                    }

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
                }
                is ApiResult.NetworkError -> {
                    val netMsg = result.throwable.localizedMessage ?: result.throwable.javaClass.simpleName
                    _uiState.update {
                        it.copy(
                            isUploadingScan = false,
                            scanUploadError = LocalizedMessage(
                                english = "Network error during upload: $netMsg",
                                arabic = "خطأ في الاتصال بالشبكة أثناء الرفع: $netMsg"
                            )
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
}
