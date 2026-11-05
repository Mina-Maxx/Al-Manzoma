package com.quarryvault.employee.ui.screens

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.view.View
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.ui.screens.scanner.DocumentScannerScreen
import com.quarryvault.employee.data.updates.UpdateManager
import com.quarryvault.employee.data.util.LocalizedMessage
import com.quarryvault.employee.ui.components.FloatingNotificationHost
import com.quarryvault.employee.ui.components.NotificationType
import java.io.File
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection

private var pendingInstallApkFile: File? = null

private fun startUpdateInstall(context: Context, viewModel: EmployeeAppViewModel, apkFile: File) {
    val updateManager = UpdateManager()
    if (!apkFile.isFile || !apkFile.exists()) {
        viewModel.showNotification(
            LocalizedMessage("Update file is missing. Download the update again.", "ملف التحديث غير موجود. نزّل التحديث مرة أخرى."),
            NotificationType.ERROR
        )
        return
    }

    try {
        if (!updateManager.canInstallPackages(context)) {
            pendingInstallApkFile = apkFile
            viewModel.showNotification(
                LocalizedMessage(
                    "Allow QuarryVault to install unknown apps in Settings, then return and tap Install Update Now again.",
                    "اسمح لتطبيق QuarryVault بتثبيت التطبيقات من هذا المصدر في الإعدادات، ثم ارجع وسيكتمل التثبيت تلقائياً."
                ),
                NotificationType.INFO,
                8000L
            )
            updateManager.launchManageUnknownSources(context)
        } else {
            pendingInstallApkFile = null
            context.startActivity(updateManager.createInstallIntent(context, apkFile))
        }
    } catch (e: ActivityNotFoundException) {
        android.util.Log.e("QuarryVaultUpdate", "Package installer ActivityNotFoundException", e)
        viewModel.showNotification(
            LocalizedMessage("Android could not open the package installer.", "تعذر على Android فتح مُثبّت الحزم."),
            NotificationType.ERROR
        )
    } catch (e: Exception) {
        android.util.Log.e("QuarryVaultUpdate", "Failed to start update install", e)
        viewModel.showNotification(
            LocalizedMessage("Could not start the update installer. Download the update again and retry.", "تعذر بدء مُثبّت التحديث. نزّل التحديث مرة أخرى ثم أعد المحاولة."),
            NotificationType.ERROR
        )
    }
}
@Composable
fun EmployeeAppScreen(
    viewModel: EmployeeAppViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current

    val layoutDirection = LayoutDirection.Rtl
    val activity = context as? Activity

    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                val pending = pendingInstallApkFile
                if (pending != null && pending.isFile && UpdateManager().canInstallPackages(context)) {
                    pendingInstallApkFile = null
                    startUpdateInstall(context, viewModel, pending)
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    SideEffect {
        activity?.window?.decorView?.layoutDirection = View.LAYOUT_DIRECTION_RTL
    }

    CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
        Box(modifier = Modifier.fillMaxSize()) {
        when {
            uiState.currentScreen == AppScreen.PASSWORD_CHANGE -> {
                BackHandler(enabled = true) { /* Password change is mandatory until completed or signed out. */ }
                MandatoryPasswordChangeScreen(
                    uiState = uiState,
                    onCurrentPasswordChange = { viewModel.onPasswordChanged(it) },
                    onNewPasswordChange = { viewModel.onNewPasswordChanged(it) },
                    onConfirmPasswordChange = { viewModel.onConfirmPasswordChanged(it) },
                    onSubmit = { viewModel.changePassword() },
                    onSignOut = { viewModel.logoutFromPasswordChange() }
                )
            }
            uiState.currentScreen == AppScreen.DOCUMENT_SCANNER -> {
                BackHandler {
                    viewModel.cancelScanning()
                }
                DocumentScannerScreen(
                    uiState = uiState,
                    viewModel = viewModel,
                    onNavigateBack = { viewModel.cancelScanning() }
                )
            }
            uiState.currentScreen == AppScreen.TRASH -> {
                BackHandler {
                    viewModel.navigateBackFromTrash()
                }
                TrashScreen(
                    uiState = uiState,
                    quarry = uiState.selectedQuarry,
                    onNavigateBack = { viewModel.navigateBackFromTrash() },
                    onRestoreDocument = { doc ->
                        viewModel.restoreDocument(doc.quarryId, doc.id, doc.version)
                    },
                    onPermanentlyDeleteDocument = { doc ->
                        viewModel.permanentlyDeleteDocument(doc.quarryId, doc.id)
                    },
                    onRefresh = {
                        viewModel.refreshTrash(uiState.selectedQuarry?.id)
                    },
                    onClearMessages = { viewModel.clearMessages() }
                )
            }
            uiState.currentScreen == AppScreen.PROFILE -> {
                BackHandler {
                    viewModel.navigateBackFromProfile()
                }
                ProfileScreen(
                    uiState = uiState,
                    onNavigateBack = { viewModel.navigateBackFromProfile() },
                    onUpdateFullName = { viewModel.updateFullName(it) }
                )
            }
            uiState.currentScreen == AppScreen.UPDATES -> {
                BackHandler {
                    viewModel.navigateBackFromUpdates()
                }
                UpdatesScreen(
                    uiState = uiState,
                    onNavigateBack = { viewModel.navigateBackFromUpdates() },
                    onNavigateToHome = { viewModel.navigateBackToHome() },
                    onCheckForUpdates = { viewModel.checkForUpdates() },
                    onDownloadUpdate = { manifest, isReq ->
                        val dir = UpdateManager().getUpdatesDir(context)
                        viewModel.downloadUpdate(manifest, dir, isReq)
                    },
                    onInstallUpdate = { file ->
                        startUpdateInstall(context, viewModel, file)
                    }
                )
            }
            uiState.currentScreen == AppScreen.EMPLOYEE_MANAGEMENT -> {
                BackHandler {
                    viewModel.navigateBackFromEmployeeManagement()
                }
                EmployeeManagementScreen(
                    uiState = uiState,
                    onNavigateBack = { viewModel.navigateBackFromEmployeeManagement() },
                    onRefresh = { viewModel.loadCompanyEmployees() },
                    onOpenCreateDialog = { viewModel.openCreateEmployeeDialog() },
                    onDismissCreateDialog = { viewModel.dismissCreateEmployeeDialog() },
                    onUsernameChanged = { viewModel.onNewEmployeeUsernameChanged(it) },
                    onPasswordChanged = { viewModel.onNewEmployeePasswordChanged(it) },
                    onFullNameChanged = { viewModel.onNewEmployeeFullNameChanged(it) },
                    onEmailChanged = { viewModel.onNewEmployeeEmailChanged(it) },
                    onToggleQuarryAssignment = { viewModel.toggleQuarryAssignment(it) },
                    onUpdateQuarryPermission = { qId, view, up, down, del ->
                        viewModel.updateQuarryPermission(qId, view, up, down, del)
                    },
                    onUpdateGeneralPermissions = { view, up, down, del ->
                        viewModel.updateNewEmployeePermissions(view, up, down, del)
                    },
                    onToggleQuarryVisibility = { qId ->
                        viewModel.toggleQuarryVisibilityForNewEmployee(qId)
                    },
                    onOpenReviewDialog = { viewModel.openReviewDialog() },
                    onDismissReviewDialog = { viewModel.dismissReviewDialog() },
                    onSubmitCreateEmployee = { viewModel.submitCreateEmployee() },
                    onDismissSuccessMessage = { viewModel.dismissEmployeeSuccessMessage() }
                )
            }
            uiState.currentScreen == AppScreen.QUARRY_DETAIL && uiState.selectedQuarry != null -> {
                BackHandler {
                    viewModel.navigateUpFolder()
                }
                QuarryDetailScreen(
                    uiState = uiState,
                    quarry = uiState.selectedQuarry!!,
                    onNavigateBack = { viewModel.navigateUpFolder() },
                    onSelectFolder = { viewModel.selectFolder(it) },
                    onSearchDocumentChange = { viewModel.onDocumentSearchQueryChanged(it) },
                    onRefresh = {
                        uiState.selectedQuarry?.let {
                            viewModel.refreshQuarryContent(it.id, uiState.currentFolderId)
                        }
                    },
                    onUploadDocument = { bytes, filename, mime, displayName ->
                        viewModel.uploadDocument(bytes, filename, mime, displayName)
                    },
                    onDownloadDocument = { viewModel.downloadDocument(it) },
                    onShareDocument = { viewModel.shareDocument(it) },
                    onViewDocument = { viewModel.viewDocument(it) },
                    onPrintDocument = { viewModel.printDocument(it) },
                    onClearPendingOpenDocument = { viewModel.clearPendingOpenDocument() },
                    onClearPendingPrintDocument = { viewModel.clearPendingPrintDocument() },
                    onClearDownloadedDocumentData = { viewModel.clearDownloadedDocumentData() },
                    onClearPendingShareDocument = { viewModel.clearPendingShareDocument() },
                    onOpenUploadDialog = { viewModel.openUploadDialog() },
                    onDismissUploadDialog = { viewModel.dismissUploadDialog() },
                    onClearMessages = { viewModel.clearMessages() },
                    onStartScanDocument = { viewModel.startScanning(uiState.selectedQuarry, uiState.currentFolderId) },
                    onNavigateToTrash = { viewModel.navigateToTrash(uiState.selectedQuarry?.id) },
                    onDeleteDocument = { doc ->
                        viewModel.deleteDocument(uiState.selectedQuarry!!.id, doc.id, doc.version)
                    },
                    onRenameDocument = { doc, newName ->
                        viewModel.renameDocument(uiState.selectedQuarry!!.id, doc.id, newName)
                    },
                    onDeleteFolder = { folder ->
                        viewModel.deleteFolder(uiState.selectedQuarry!!.id, folder.id)
                    }
                )
            }
            uiState.currentScreen == AppScreen.HOME && uiState.isAuthenticated -> {
                HomeScreen(
                    uiState = uiState,
                    onSelectQuarry = { viewModel.selectQuarry(it) },
                    onSearchQueryChange = { viewModel.onQuarrySearchQueryChanged(it) },
                    onRefresh = { viewModel.refreshQuarries() },
                    onSignOut = { viewModel.logout() },
                    onOpenCreateQuarryDialog = { viewModel.openCreateQuarryDialog() },
                    onDismissCreateQuarryDialog = { viewModel.dismissCreateQuarryDialog() },
                    onNewQuarryNameChange = { viewModel.onNewQuarryNameChanged(it) },
                    onNewQuarryNumberChange = { viewModel.onNewQuarryNumberChanged(it) },
                    onNewQuarryTypeChange = { viewModel.onNewQuarryTypeChanged(it) },
                    onConfirmCreateQuarry = { viewModel.createQuarry() },
                    onClearCreateQuarrySuccess = { viewModel.clearCreateQuarrySuccessMessage() },
                    onNavigateToTrash = { viewModel.navigateToTrash() },
                    onNavigateToUpdates = { viewModel.navigateToUpdates() },
                    onNavigateToProfile = { viewModel.navigateToProfile() },
                    onNavigateToEmployeeManagement = { viewModel.navigateToEmployeeManagement() }
                )
            }
            else -> {
                LoginScreenContainer(viewModel = viewModel, uiState = uiState)
            }
        }

        // Unified floating notification toast
        FloatingNotificationHost(
            notification = uiState.activeNotification,
            isArabic = uiState.isArabic,
            onDismiss = { viewModel.dismissNotification() },
            modifier = Modifier.align(Alignment.BottomCenter)
        )
    }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MandatoryPasswordChangeScreen(
    uiState: EmployeeAppUiState,
    onCurrentPasswordChange: (String) -> Unit,
    onNewPasswordChange: (String) -> Unit,
    onConfirmPasswordChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onSignOut: () -> Unit
) {
    var currentPasswordVisible by remember { mutableStateOf(false) }
    var newPasswordVisible by remember { mutableStateOf(false) }
    var confirmPasswordVisible by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        if (uiState.isArabic) "تغيير كلمة المرور" else "Change password",
                        fontWeight = FontWeight.Bold
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                )
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(20.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Icon(Icons.Default.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Text(
                        if (uiState.isArabic) "أنشئ كلمة مرور جديدة للمتابعة إلى المكتب" else "Create a new password to continue to your office",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        if (uiState.isArabic) "الحساب جديد، ولا يمكن فتح بيانات المكتب قبل تغيير كلمة المرور المؤقتة." else "This is a new account. Office data stays locked until you replace the temporary password.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            OutlinedTextField(
                value = uiState.password,
                onValueChange = onCurrentPasswordChange,
                label = { Text(if (uiState.isArabic) "كلمة المرور المؤقتة" else "Temporary password") },
                leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = { currentPasswordVisible = !currentPasswordVisible }) {
                        Icon(if (currentPasswordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility, contentDescription = null)
                    }
                },
                visualTransformation = if (currentPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                enabled = !uiState.isChangingPassword,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = uiState.newPassword,
                onValueChange = onNewPasswordChange,
                label = { Text(if (uiState.isArabic) "كلمة المرور الجديدة" else "New password") },
                leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = { newPasswordVisible = !newPasswordVisible }) {
                        Icon(if (newPasswordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility, contentDescription = null)
                    }
                },
                visualTransformation = if (newPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                enabled = !uiState.isChangingPassword,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = uiState.confirmPassword,
                onValueChange = onConfirmPasswordChange,
                label = { Text(if (uiState.isArabic) "تأكيد كلمة المرور الجديدة" else "Confirm new password") },
                leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = { confirmPasswordVisible = !confirmPasswordVisible }) {
                        Icon(if (confirmPasswordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility, contentDescription = null)
                    }
                },
                visualTransformation = if (confirmPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                enabled = !uiState.isChangingPassword,
                modifier = Modifier.fillMaxWidth()
            )

            uiState.passwordChangeError?.let { error ->
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(error.arabic, color = MaterialTheme.colorScheme.onErrorContainer, fontWeight = FontWeight.Bold)
                        Text(error.english, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }

            Button(
                onClick = onSubmit,
                enabled = !uiState.isChangingPassword,
                modifier = Modifier.fillMaxWidth().height(50.dp)
            ) {
                if (uiState.isChangingPassword) {
                    CircularProgressIndicator(Modifier.size(22.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(if (uiState.isArabic) "جارٍ حفظ كلمة المرور..." else "Saving password...")
                } else {
                    Text(if (uiState.isArabic) "حفظ والمتابعة إلى المكتب" else "Save and continue to office", fontWeight = FontWeight.Bold)
                }
            }
            TextButton(
                onClick = onSignOut,
                enabled = !uiState.isChangingPassword,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (uiState.isArabic) "تسجيل الخروج" else "Sign out")
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreenContainer(
    viewModel: EmployeeAppViewModel,
    uiState: EmployeeAppUiState
) {
    var isPasswordVisible by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = if (uiState.isArabic) "منظومة محاجر" else "QuarryVault Employee",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = if (uiState.isArabic) "بوابة الموظف" else "Employee Portal - Secure Document Archive",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.8f)
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                )
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            LoginView(
                uiState = uiState,
                isPasswordVisible = isPasswordVisible,
                onTogglePasswordVisibility = { isPasswordVisible = !isPasswordVisible },
                onEmailChange = { viewModel.onEmailChanged(it) },
                onPasswordChange = { viewModel.onPasswordChanged(it) },
                onSignIn = { viewModel.login() }
            )
        }
    }
}

@Composable
fun LoginView(
    uiState: EmployeeAppUiState,
    isPasswordVisible: Boolean,
    onTogglePasswordVisibility: () -> Unit,
    onEmailChange: (String) -> Unit,
    onPasswordChange: (String) -> Unit,
    onSignIn: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Header
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.size(48.dp)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            Icons.Default.Lock,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary
                        )
                    }
                }
                Column {
                    Text(
                        text = if (uiState.isArabic) "تسجيل الدخول" else "Sign In / تسجيل الدخول",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = if (uiState.isArabic) "أدخل بيانات اعتمادك للمتابعة" else "Enter your company credentials to continue",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // Error banner if any
            if (uiState.loginError != null) {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer
                    ),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Icon(
                            Icons.Default.Error,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error
                        )
                        Column {
                            Text(
                                text = uiState.loginError.arabic,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.onErrorContainer
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = uiState.loginError.english,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer
                            )
                        }
                    }
                }
            }

            // Email Input
            OutlinedTextField(
                value = uiState.email,
                onValueChange = onEmailChange,
                label = { Text(if (uiState.isArabic) "البريد الإلكتروني" else "Email / البريد الإلكتروني") },
                placeholder = { Text("employee@quarryvault.com") },
                leadingIcon = { Icon(Icons.Default.Email, contentDescription = null) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth(),
                enabled = !uiState.isAuthenticating && !uiState.isLoadingProfile
            )

            // Password Input
            OutlinedTextField(
                value = uiState.password,
                onValueChange = onPasswordChange,
                label = { Text(if (uiState.isArabic) "كلمة المرور" else "Password / كلمة المرور") },
                leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = onTogglePasswordVisibility) {
                        Icon(
                            if (isPasswordVisible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = if (isPasswordVisible) "Hide password" else "Show password"
                        )
                    }
                },
                visualTransformation = if (isPasswordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
                enabled = !uiState.isAuthenticating && !uiState.isLoadingProfile
            )

            // Submit Button
            Button(
                onClick = onSignIn,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
                enabled = !uiState.isAuthenticating && !uiState.isLoadingProfile
            ) {
                if (uiState.isAuthenticating || uiState.isLoadingProfile) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(if (uiState.isAuthenticating) "Authenticating... / جارٍ التحقق..." else "Loading Profile... / جارٍ تحميل الحساب...")
                } else {
                    Icon(Icons.Default.Login, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(if (uiState.isArabic) "تسجيل الدخول" else "Sign In / دخول", fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}
