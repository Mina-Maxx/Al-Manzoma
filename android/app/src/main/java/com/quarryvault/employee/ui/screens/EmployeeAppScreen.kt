package com.quarryvault.employee.ui.screens

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

@Composable
fun EmployeeAppScreen(
    viewModel: EmployeeAppViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    when {
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
        uiState.currentScreen == AppScreen.TRASH && uiState.selectedQuarry != null -> {
            BackHandler {
                viewModel.navigateBackFromTrash()
            }
            TrashScreen(
                uiState = uiState,
                quarry = uiState.selectedQuarry!!,
                onNavigateBack = { viewModel.navigateBackFromTrash() },
                onRestoreDocument = { doc ->
                    viewModel.restoreDocument(uiState.selectedQuarry!!.id, doc.id, doc.version)
                },
                onRefresh = { viewModel.loadTrash(uiState.selectedQuarry!!.id) },
                onToggleLanguage = { viewModel.toggleLanguage() },
                onClearMessages = { viewModel.clearMessages() }
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
                        viewModel.loadQuarryContent(it.id, uiState.currentFolderId)
                    }
                },
                onUploadDocument = { bytes, filename, mime, displayName ->
                    viewModel.uploadDocument(bytes, filename, mime, displayName)
                },
                onDownloadDocument = { viewModel.downloadDocument(it) },
                onToggleLanguage = { viewModel.toggleLanguage() },
                onOpenUploadDialog = { viewModel.openUploadDialog() },
                onDismissUploadDialog = { viewModel.dismissUploadDialog() },
                onClearMessages = { viewModel.clearMessages() },
                onStartScanDocument = { viewModel.startScanning(uiState.selectedQuarry, uiState.currentFolderId) },
                onNavigateToTrash = { viewModel.navigateToTrash() },
                onDeleteDocument = { doc ->
                    viewModel.deleteDocument(uiState.selectedQuarry!!.id, doc.id, doc.version)
                }
            )
        }
        uiState.currentScreen == AppScreen.HOME && uiState.isAuthenticated -> {
            HomeScreen(
                uiState = uiState,
                onSelectQuarry = { viewModel.selectQuarry(it) },
                onSearchQueryChange = { viewModel.onQuarrySearchQueryChanged(it) },
                onRefresh = { viewModel.loadQuarries() },
                onToggleLanguage = { viewModel.toggleLanguage() },
                onSignOut = { viewModel.logout() },
                onOpenCreateQuarryDialog = { viewModel.openCreateQuarryDialog() },
                onDismissCreateQuarryDialog = { viewModel.dismissCreateQuarryDialog() },
                onNewQuarryNameChange = { viewModel.onNewQuarryNameChanged(it) },
                onConfirmCreateQuarry = { viewModel.createQuarry() },
                onClearCreateQuarrySuccess = { viewModel.clearCreateQuarrySuccessMessage() }
            )
        }
        else -> {
            LoginScreenContainer(viewModel = viewModel, uiState = uiState)
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
                actions = {
                    IconButton(onClick = { viewModel.toggleLanguage() }) {
                        Text(
                            text = if (uiState.isArabic) "EN" else "عربي",
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold
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

            // Collapsible Developer & Diagnostic Controls
            DiagnosticsCard(
                uiState = uiState,
                onToggleExpand = { viewModel.toggleDiagnostics() },
                onUpdateBackendUrl = { viewModel.updateBackendUrl(it) },
                onUpdateSupabaseUrl = { viewModel.updateSupabaseUrl(it) },
                onUpdateSupabaseAnonKey = { viewModel.updateSupabaseAnonKey(it) },
                onUpdateManualToken = { viewModel.updateManualToken(it) },
                onCheckHealth = { viewModel.checkHealth() },
                onVerifyManualToken = { viewModel.fetchProfile(it) }
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

@Composable
fun DiagnosticsCard(
    uiState: EmployeeAppUiState,
    onToggleExpand: () -> Unit,
    onUpdateBackendUrl: (String) -> Unit,
    onUpdateSupabaseUrl: (String) -> Unit,
    onUpdateSupabaseAnonKey: (String) -> Unit,
    onUpdateManualToken: (String) -> Unit,
    onCheckHealth: () -> Unit,
    onVerifyManualToken: (String) -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        Icons.Default.Settings,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.size(20.dp)
                    )
                    Text(
                        text = "Developer & Diagnostics / أدوات التشخيص",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold
                    )
                }

                TextButton(onClick = onToggleExpand) {
                    Text(if (uiState.isDiagnosticsExpanded) "Hide / إخفاء" else "Show / إظهار")
                }
            }

            AnimatedVisibility(visible = uiState.isDiagnosticsExpanded) {
                Column(
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    HorizontalDivider()

                    // Backend Server URL
                    OutlinedTextField(
                        value = uiState.backendBaseUrl,
                        onValueChange = onUpdateBackendUrl,
                        label = { Text("FastAPI Backend URL") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        supportingText = { Text("Default: http://10.0.2.2:8000 for Android emulator") }
                    )

                    // Supabase Project URL
                    OutlinedTextField(
                        value = uiState.supabaseUrl,
                        onValueChange = onUpdateSupabaseUrl,
                        label = { Text("Supabase Project URL") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true
                    )

                    // Supabase Publishable / Anon Key
                    OutlinedTextField(
                        value = uiState.supabaseAnonKey,
                        onValueChange = onUpdateSupabaseAnonKey,
                        label = { Text("Supabase Publishable/Anon Key") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        supportingText = { Text("Leave empty to use built-in config or local.properties") }
                    )

                    // Health check button & status
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Button(
                            onClick = onCheckHealth,
                            enabled = uiState.healthState !is RequestState.Loading
                        ) {
                            Icon(Icons.Default.Refresh, contentDescription = null)
                            Spacer(Modifier.width(6.dp))
                            Text("Check Backend Health")
                        }

                        when (val state = uiState.healthState) {
                            is RequestState.Idle -> Text("Not checked", style = MaterialTheme.typography.bodySmall)
                            is RequestState.Loading -> CircularProgressIndicator(Modifier.size(20.dp))
                            is RequestState.Success -> {
                                Surface(color = Color(0xFFE8F5E9), shape = RoundedCornerShape(4.dp)) {
                                    Text(
                                        "Status: ${state.data.status}",
                                        color = Color(0xFF2E7D32),
                                        style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                    )
                                }
                            }
                            is RequestState.Error -> {
                                Text(
                                    state.message,
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.bodySmall
                                )
                            }
                        }
                    }

                    // Diagnostic manual token input
                    OutlinedTextField(
                        value = uiState.manualToken,
                        onValueChange = onUpdateManualToken,
                        label = { Text("Manual Bearer Token (Diagnostic)") },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 3,
                        supportingText = { Text("Allows directly querying /me with a test JWT") }
                    )

                    Button(
                        onClick = { onVerifyManualToken(uiState.manualToken) },
                        enabled = uiState.manualToken.isNotBlank() && !uiState.isLoadingProfile,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Verify Manual Token against /me")
                    }
                }
            }
        }
    }
}
