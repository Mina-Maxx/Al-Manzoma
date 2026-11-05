package com.quarryvault.employee.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.ui.util.UiFormatters

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    uiState: EmployeeAppUiState,
    onSelectQuarry: (Quarry) -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    onOpenCreateQuarryDialog: () -> Unit = {},
    onDismissCreateQuarryDialog: () -> Unit = {},
    onNewQuarryNameChange: (String) -> Unit,
    onNewQuarryNumberChange: (String) -> Unit,
    onNewQuarryTypeChange: (String) -> Unit,
    onConfirmCreateQuarry: () -> Unit = {},
    onClearCreateQuarrySuccess: () -> Unit = {},
    onNavigateToTrash: () -> Unit = {},
    onNavigateToUpdates: () -> Unit = {},
    onNavigateToProfile: () -> Unit = {},
    onNavigateToEmployeeManagement: () -> Unit = {}
) {
    val isAr = uiState.isArabic
    val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr

    CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text(
                                text = if (isAr) "المنظومة" else "المنظومة (QuarryVault)",
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = if (isAr) "بوابة الموظف" else "Employee Portal",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.8f)
                            )
                        }
                    },
                    actions = {
                        if (uiState.profile?.role == "company_admin") {
                            IconButton(onClick = onNavigateToEmployeeManagement) {
                                Icon(
                                    Icons.Default.Group,
                                    contentDescription = if (isAr) "إدارة الموظفين" else "Employee Management"
                                )
                            }
                        }
                        IconButton(onClick = onNavigateToProfile) {
                            Icon(
                                Icons.Default.AccountCircle,
                                contentDescription = if (isAr) "الملف الشخصي" else "Profile"
                            )
                        }
                        IconButton(onClick = onNavigateToUpdates) {
                            BadgedBox(
                                badge = {
                                    if (uiState.updateStatus is UpdateStatus.Available) {
                                        Badge { Text("!") }
                                    }
                                }
                            ) {
                                Icon(
                                    Icons.Default.SystemUpdate,
                                    contentDescription = if (isAr) "التحديثات" else "Updates"
                                )
                            }
                        }
                        IconButton(onClick = onSignOut) {
                            Icon(Icons.Default.ExitToApp, contentDescription = if (isAr) "تسجيل خروج" else "Sign out")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                    )
                )
            },
            floatingActionButton = {
                Column(
                    horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.padding(bottom = 8.dp)
                ) {
                    // Centralized Company Trash FAB (Requirement 5)
                    FloatingActionButton(
                        onClick = onNavigateToTrash,
                        containerColor = MaterialTheme.colorScheme.secondaryContainer,
                        contentColor = MaterialTheme.colorScheme.onSecondaryContainer
                    ) {
                        BadgedBox(
                            badge = {
                                if (uiState.trashDocuments.isNotEmpty()) {
                                    Badge {
                                        Text(text = "${uiState.trashDocuments.size}")
                                    }
                                }
                            }
                        ) {
                            Icon(
                                imageVector = Icons.Default.DeleteOutline,
                                contentDescription = if (isAr) "سلة المهملات" else "Company Trash"
                            )
                        }
                    }

                    // Create Quarry FAB
                    ExtendedFloatingActionButton(
                        onClick = onOpenCreateQuarryDialog,
                        icon = { Icon(Icons.Default.Add, contentDescription = null) },
                        text = { Text(if (isAr) "إنشاء محجر" else "Create Quarry") },
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary
                    )
                }
            }
        ) { innerPadding ->
            val filteredQuarries = uiState.quarries.filter {
                uiState.quarrySearchQuery.isBlank() ||
                        it.name.contains(uiState.quarrySearchQuery, ignoreCase = true)
            }
            val sortedQuarries = remember(filteredQuarries) {
                com.quarryvault.employee.ui.util.UiFormatters.sortAlphabetically(filteredQuarries) { it.name }
            }

            PullToRefreshBox(
                isRefreshing = uiState.isRefreshingQuarries,
                onRefresh = onRefresh,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    contentPadding = PaddingValues(vertical = 16.dp)
                ) {
                // Profile & Storage Usage Card
                item {
                    ProfileHeaderCard(uiState = uiState, isAr = isAr)
                }

                if (uiState.profile?.role == "company_admin") {
                    item {
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(onClick = onNavigateToEmployeeManagement),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.secondaryContainer
                            ),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Row(
                                modifier = Modifier.padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                                ) {
                                    Icon(
                                        Icons.Default.Group,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.onSecondaryContainer,
                                        modifier = Modifier.size(28.dp)
                                    )
                                    Column {
                                        Text(
                                            text = if (isAr) "إدارة الموظفين" else "Employee Management",
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.Bold,
                                            color = MaterialTheme.colorScheme.onSecondaryContainer
                                        )
                                        Text(
                                            text = if (isAr) "إضافة وإدارة موظفي الشركة وتعيين المحاجر" else "Manage employees and quarry assignments",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.8f)
                                        )
                                    }
                                }
                                Icon(
                                    Icons.AutoMirrored.Filled.ArrowForward,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSecondaryContainer
                                )
                            }
                        }
                    }
                }



                // Search Bar
                item {
                    OutlinedTextField(
                        value = uiState.quarrySearchQuery,
                        onValueChange = onSearchQueryChange,
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = {
                            Text(if (isAr) "البحث عن محجر..." else "Search authorized quarries...")
                        },
                        leadingIcon = {
                            Icon(Icons.Default.Search, contentDescription = null)
                        },
                        trailingIcon = {
                            if (uiState.quarrySearchQuery.isNotEmpty()) {
                                IconButton(onClick = { onSearchQueryChange("") }) {
                                    Icon(Icons.Default.Clear, contentDescription = null)
                                }
                            }
                        },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp)
                    )
                }

                // Section Title & Add Quarry Button
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = if (isAr) "المحاجر المصرح لك بها" else "Authorized Quarries",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                text = "(${sortedQuarries.size})",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.secondary
                            )
                        }
                        FilledTonalButton(
                            onClick = onOpenCreateQuarryDialog,
                            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                        ) {
                            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                text = if (isAr) "+ محجر جديد" else "+ New Quarry",
                                style = MaterialTheme.typography.labelMedium
                            )
                        }
                    }
                }



                // Loading State
                if (uiState.isLoadingQuarries) {
                    item {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(32.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }
                } else if (sortedQuarries.isEmpty()) {
                    // Empty State
                    item {
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                            ),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(32.dp),
                                horizontalAlignment = Alignment.CenterHorizontally
                            ) {
                                Icon(
                                    Icons.Default.Terrain,
                                    contentDescription = null,
                                    modifier = Modifier.size(56.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                                )
                                Spacer(modifier = Modifier.height(12.dp))
                                Text(
                                    text = if (isAr) "لا توجد محاجر مصرح لك بها حالياً" else "No authorized quarries assigned",
                                    style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = if (isAr) "يرجى مراجعة مسؤول الشركة لمنحك صلاحيات الوصول." else "Please contact your company admin to grant permissions.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                } else {
                    // Quarries List
                    items(sortedQuarries, key = { it.id }) { quarry ->
                        QuarryCard(
                            quarry = quarry,
                            isAr = isAr,
                            onClick = { onSelectQuarry(quarry) }
                        )
                    }
                }
                }
            }
        }

        // Create Quarry Dialog
        if (uiState.isCreateQuarryDialogVisible) {
            CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
                AlertDialog(
                    onDismissRequest = {
                        if (!uiState.isCreatingQuarry) onDismissCreateQuarryDialog()
                    },
                    title = {
                        CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
                            Text(
                                text = if (isAr) "إنشاء محجر جديد" else "Create New Quarry",
                                fontWeight = FontWeight.Bold
                            )
                        }
                    },
                    text = {
                        CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
                            Column(modifier = Modifier.fillMaxWidth()) {
                                Text(
                                    text = if (isAr)
                                        "سيظهر هذا المحجر لجميع موظفي الشركة بصلاحية العرض تلقائياً."
                                    else
                                        "This quarry will appear to all company employees with view permission.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                                Spacer(modifier = Modifier.height(16.dp))
                                OutlinedTextField(
                                    value = uiState.newQuarryName,
                                    onValueChange = onNewQuarryNameChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text(if (isAr) "اسم المحجر *" else "Quarry Name *") },
                                    placeholder = { Text(if (isAr) "مثال: محجر النور والبركة" else "e.g. Eastern Granite Quarry") },
                                    singleLine = true,
                                    enabled = !uiState.isCreatingQuarry,
                                    isError = uiState.createQuarryError != null,
                                    shape = RoundedCornerShape(8.dp),
                                    keyboardOptions = KeyboardOptions(
                                        keyboardType = KeyboardType.Text,
                                        imeAction = ImeAction.Next
                                    )
                                )
                                Spacer(modifier = Modifier.height(10.dp))
                                OutlinedTextField(
                                    value = uiState.newQuarryNumber,
                                    onValueChange = onNewQuarryNumberChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text(if (isAr) "رقم المحجر الرسمي *" else "Official Quarry Number *") },
                                    placeholder = { Text(if (isAr) "مثال: ١٠٤/أ أو 104-A" else "e.g. 104-A") },
                                    singleLine = true,
                                    enabled = !uiState.isCreatingQuarry,
                                    isError = uiState.createQuarryError != null,
                                    shape = RoundedCornerShape(8.dp),
                                    keyboardOptions = KeyboardOptions(
                                        keyboardType = KeyboardType.Text,
                                        imeAction = ImeAction.Next
                                    )
                                )
                                Spacer(modifier = Modifier.height(10.dp))
                                OutlinedTextField(
                                    value = uiState.newQuarryType,
                                    onValueChange = onNewQuarryTypeChange,
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text(if (isAr) "نوع المحجر / الخامة *" else "Quarry Type / Material *") },
                                    placeholder = { Text(if (isAr) "مثال: رخام، جرانيت، حجر جيري، بازلت" else "e.g. Marble, Granite, Basalt") },
                                    singleLine = true,
                                    enabled = !uiState.isCreatingQuarry,
                                    isError = uiState.createQuarryError != null,
                                    shape = RoundedCornerShape(8.dp),
                                    keyboardOptions = KeyboardOptions(
                                        keyboardType = KeyboardType.Text,
                                        imeAction = ImeAction.Done
                                    ),
                                    keyboardActions = KeyboardActions(
                                        onDone = {
                                            if (uiState.newQuarryName.isNotBlank() && uiState.newQuarryNumber.isNotBlank() && uiState.newQuarryType.isNotBlank() && !uiState.isCreatingQuarry) {
                                                onConfirmCreateQuarry()
                                            }
                                        }
                                    )
                                )
                                if (uiState.createQuarryError != null) {
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        text = if (isAr) uiState.createQuarryError.arabic else uiState.createQuarryError.english,
                                        color = MaterialTheme.colorScheme.error,
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                }
                            }
                        }
                    },
                    confirmButton = {
                        CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
                            Button(
                                onClick = onConfirmCreateQuarry,
                                enabled = uiState.newQuarryName.isNotBlank() && uiState.newQuarryNumber.isNotBlank() && uiState.newQuarryType.isNotBlank() && !uiState.isCreatingQuarry
                            ) {
                                if (uiState.isCreatingQuarry) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        color = MaterialTheme.colorScheme.onPrimary,
                                        strokeWidth = 2.dp
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                }
                                Text(if (isAr) "إنشاء" else "Create")
                            }
                        }
                    },
                    dismissButton = {
                        CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
                            TextButton(
                                onClick = onDismissCreateQuarryDialog,
                                enabled = !uiState.isCreatingQuarry
                            ) {
                                Text(if (isAr) "إلغاء" else "Cancel")
                            }
                        }
                    }
                )
            }
        }
    }
}

@Composable
fun ProfileHeaderCard(uiState: EmployeeAppUiState, isAr: Boolean) {
    val profile = uiState.profile ?: return
    val usedFormatted = UiFormatters.formatBytes(profile.company.usedBytes, isAr)
    val quotaFormatted = UiFormatters.formatBytes(profile.company.quotaBytes, isAr)
    val progress = if (profile.company.quotaBytes > 0) {
        (profile.company.usedBytes.toFloat() / profile.company.quotaBytes.toFloat()).coerceIn(0f, 1f)
    } else 0f

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        ),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = profile.user.fullName?.takeIf { it.isNotBlank() }
                            ?: profile.user.email
                            ?: if (isAr) "موظف محاجر" else "Quarry Employee",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = profile.company.name,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary
                    )
                }

                AssistChip(
                    onClick = {},
                    label = {
                        Text(if (isAr) "موظف" else "Employee")
                    },
                    leadingIcon = {
                        Icon(Icons.Default.Badge, contentDescription = null, modifier = Modifier.size(16.dp))
                    }
                )
            }

            Spacer(modifier = Modifier.height(12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f))
            Spacer(modifier = Modifier.height(12.dp))

            // Storage quota progress
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = if (isAr) "سعة تخزين الشركة" else "Company Storage Quota",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "$usedFormatted / $quotaFormatted",
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold
                )
            }

            Spacer(modifier = Modifier.height(6.dp))
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(6.dp),
                color = if (progress > 0.85f) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                trackColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f)
            )
        }
    }
}

@Composable
fun QuarryCard(
    quarry: Quarry,
    isAr: Boolean,
    onClick: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.primaryContainer,
                        modifier = Modifier.size(40.dp)
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                Icons.Default.Terrain,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onPrimaryContainer
                            )
                        }
                    }

                    Column {
                        Text(
                            text = quarry.displayNameFormatted,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            text = if (quarry.status == "active") {
                                if (isAr) "نشط" else "Active"
                            } else {
                                if (isAr) "غير نشط" else "Inactive"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = if (quarry.status == "active") Color(0xFF2E7D32) else MaterialTheme.colorScheme.error
                        )
                    }
                }

                Icon(
                    Icons.AutoMirrored.Filled.ArrowForward,
                    contentDescription = if (isAr) "عرض" else "Open",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
