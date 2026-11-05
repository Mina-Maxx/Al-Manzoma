package com.quarryvault.employee.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.api.models.CompanyEmployee
import com.quarryvault.employee.ui.theme.QuarryPrimary
import com.quarryvault.employee.ui.theme.QuarrySecondary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmployeeManagementScreen(
    uiState: EmployeeAppUiState,
    onNavigateBack: () -> Unit,
    onRefresh: () -> Unit,
    onOpenCreateDialog: () -> Unit,
    onDismissCreateDialog: () -> Unit,
    onUsernameChanged: (String) -> Unit,
    onPasswordChanged: (String) -> Unit,
    onFullNameChanged: (String) -> Unit,
    onEmailChanged: (String) -> Unit,
    onToggleQuarryAssignment: (String) -> Unit,
    onUpdateQuarryPermission: (quarryId: String, canView: Boolean, canUpload: Boolean, canDownload: Boolean, canDelete: Boolean) -> Unit = { _, _, _, _, _ -> },
    onUpdateGeneralPermissions: (canView: Boolean?, canUpload: Boolean?, canDownload: Boolean?, canDelete: Boolean?) -> Unit = { _, _, _, _ -> },
    onToggleQuarryVisibility: (String) -> Unit = {},
    onOpenReviewDialog: () -> Unit,
    onDismissReviewDialog: () -> Unit,
    onSubmitCreateEmployee: () -> Unit,
    onDismissSuccessMessage: () -> Unit
) {
    BackHandler {
        onNavigateBack()
    }

    val isAr = uiState.isArabic
    val sortedEmployees = remember(uiState.employees) {
        com.quarryvault.employee.ui.util.UiFormatters.sortAlphabetically(uiState.employees) { it.fullName ?: it.username.orEmpty() }
    }

    CompositionLocalProvider(
        LocalLayoutDirection provides if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            text = if (isAr) "إدارة موظفي الشركة" else "Employee Management",
                            fontWeight = FontWeight.Bold
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = onNavigateBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = if (isAr) "رجوع" else "Back"
                            )
                        }
                    },
                    actions = {},
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        titleContentColor = MaterialTheme.colorScheme.onPrimary,
                        navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                        actionIconContentColor = MaterialTheme.colorScheme.onPrimary
                    )
                )
            },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = onOpenCreateDialog,
                    icon = { Icon(Icons.Default.PersonAdd, contentDescription = null) },
                    text = { Text(if (isAr) "إضافة موظف جديد" else "Add New Employee") },
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary
                )
            }
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    contentPadding = PaddingValues(top = 16.dp, bottom = 80.dp)
                ) {
                    // Error Banner
                    if (uiState.employeesError != null) {
                        item {
                            Card(
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.errorContainer
                                ),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Row(
                                    modifier = Modifier.padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Icon(
                                        Icons.Default.Error,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.onErrorContainer
                                    )
                                    Text(
                                        text = if (isAr) uiState.employeesError.arabic else uiState.employeesError.english,
                                        color = MaterialTheme.colorScheme.onErrorContainer,
                                        style = MaterialTheme.typography.bodyMedium
                                    )
                                }
                            }
                        }
                    }

                    // Header Info
                    item {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant
                            ),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Row(
                                modifier = Modifier.padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                Icon(
                                    Icons.Default.Group,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(28.dp)
                                )
                                Column {
                                    Text(
                                        text = if (isAr) "قائمة موظفي المنشأة" else "Company Employees",
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.Bold
                                    )
                                    Text(
                                        text = if (isAr) "إجمالي الموظفين المسجلين: ${uiState.employees.size}" else "Total registered: ${uiState.employees.size}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                                    )
                                }
                            }
                        }
                    }

                    // Employee List
                    if (uiState.employees.isEmpty() && !uiState.isLoadingEmployees) {
                        item {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 40.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Column(
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                    verticalArrangement = Arrangement.spacedBy(8.dp)
                                ) {
                                    Icon(
                                        Icons.Default.PersonOff,
                                        contentDescription = null,
                                        modifier = Modifier.size(48.dp),
                                        tint = MaterialTheme.colorScheme.secondary
                                    )
                                    Text(
                                        text = if (isAr) "لا يوجد موظفون مسجلون حالياً" else "No employees registered yet",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.secondary
                                    )
                                }
                            }
                        }
                    } else {
                        items(sortedEmployees, key = { it.id }) { employee ->
                            EmployeeCard(employee = employee, isAr = isAr)
                        }
                    }
                }

                if (uiState.isLoadingEmployees) {
                    CircularProgressIndicator(
                        modifier = Modifier.align(Alignment.Center)
                    )
                }
            }
        }

        // Create Employee Dialog
        if (uiState.isCreateEmployeeDialogVisible) {
            CreateEmployeeDialog(
                uiState = uiState,
                isAr = isAr,
                onDismiss = onDismissCreateDialog,
                onUsernameChanged = onUsernameChanged,
                onPasswordChanged = onPasswordChanged,
                onFullNameChanged = onFullNameChanged,
                onEmailChanged = onEmailChanged,
                onUpdateGeneralPermissions = onUpdateGeneralPermissions,
                onToggleQuarryVisibility = onToggleQuarryVisibility,
                onProceedToReview = onOpenReviewDialog
            )
        }

        // Review Confirmation Dialog
        if (uiState.isReviewEmployeeDialogVisible) {
            ReviewEmployeeDialog(
                uiState = uiState,
                isAr = isAr,
                onDismiss = onDismissReviewDialog,
                onConfirm = onSubmitCreateEmployee
            )
        }
    }
}

@Composable
private fun EmployeeCard(employee: CompanyEmployee, isAr: Boolean) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 2.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = employee.fullName ?: employee.username ?: (if (isAr) "موظف بدون اسم" else "Unnamed"),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold
                )
                // Role Badge
                val isCompanyAdmin = employee.role == "company_admin"
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = if (isCompanyAdmin) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.secondaryContainer
                ) {
                    Text(
                        text = if (isCompanyAdmin) (if (isAr) "مسؤول شركة" else "Company Admin") else (if (isAr) "موظف" else "Employee"),
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        color = if (isCompanyAdmin) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSecondaryContainer,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            if (!employee.username.isNullOrBlank()) {
                Text(
                    text = "@${employee.username}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.secondary
                )
            }

            if (!employee.email.isNullOrBlank()) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Icon(
                        Icons.Default.Email,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = MaterialTheme.colorScheme.secondary
                    )
                    Text(
                        text = employee.email,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Status Badge
                val isActive = employee.status == "active"
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = if (isActive) Color(0xFFE8F5E9) else Color(0xFFFFEBEE)
                ) {
                    Text(
                        text = if (isActive) (if (isAr) "نشط" else "Active") else (if (isAr) "معطل" else "Inactive"),
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        color = if (isActive) Color(0xFF2E7D32) else Color(0xFFC62828),
                        fontWeight = FontWeight.Medium
                    )
                }

                if (employee.mustChangePassword) {
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = Color(0xFFFFF3E0)
                    ) {
                        Text(
                            text = if (isAr) "مطلوب تغيير كلمة المرور" else "Password change required",
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            color = Color(0xFFE65100),
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CreateEmployeeDialog(
    uiState: EmployeeAppUiState,
    isAr: Boolean,
    onDismiss: () -> Unit,
    onUsernameChanged: (String) -> Unit,
    onPasswordChanged: (String) -> Unit,
    onFullNameChanged: (String) -> Unit,
    onEmailChanged: (String) -> Unit,
    onUpdateGeneralPermissions: (canView: Boolean?, canUpload: Boolean?, canDownload: Boolean?, canDelete: Boolean?) -> Unit,
    onToggleQuarryVisibility: (String) -> Unit,
    onProceedToReview: () -> Unit
) {
    var passwordVisible by remember { mutableStateOf(false) }
    val sortedQuarries = remember(uiState.quarries) {
        com.quarryvault.employee.ui.util.UiFormatters.sortAlphabetically(uiState.quarries) { it.name }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = if (isAr) "إضافة موظف جديد" else "Add New Employee",
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                // Validation Error Banner
                if (uiState.createEmployeeError != null) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer
                        ),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = if (isAr) uiState.createEmployeeError.arabic else uiState.createEmployeeError.english,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(8.dp)
                        )
                    }
                }

                OutlinedTextField(
                    value = uiState.newEmployeeUsername,
                    onValueChange = onUsernameChanged,
                    label = { Text(if (isAr) "اسم المستخدم *" else "Username *") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                OutlinedTextField(
                    value = uiState.newEmployeePassword,
                    onValueChange = onPasswordChanged,
                    label = { Text(if (isAr) "كلمة المرور الأولية *" else "Initial Password *") },
                    singleLine = true,
                    visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    trailingIcon = {
                        IconButton(onClick = { passwordVisible = !passwordVisible }) {
                            Icon(
                                if (passwordVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                                contentDescription = null
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                )

                OutlinedTextField(
                    value = uiState.newEmployeeFullName,
                    onValueChange = onFullNameChanged,
                    label = { Text(if (isAr) "الاسم الكامل (اختياري)" else "Full Name (Optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                OutlinedTextField(
                    value = uiState.newEmployeeEmail,
                    onValueChange = onEmailChanged,
                    label = { Text(if (isAr) "البريد الإلكتروني (اختياري)" else "Email (Optional)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth()
                )

                HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                // General Operational Permissions
                Text(
                    text = if (isAr) "الصلاحيات التشغيلية العامة (على مستوى الشركة)" else "Company-Wide Operational Permissions",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold
                )

                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                ) {
                    Column(
                        modifier = Modifier.padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(if (isAr) "عرض المستندات (View)" else "View Documents", style = MaterialTheme.typography.bodySmall)
                            Switch(
                                checked = uiState.newEmployeeCanView,
                                onCheckedChange = { onUpdateGeneralPermissions(it, null, null, null) }
                            )
                        }

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(if (isAr) "رفع المستندات (Upload)" else "Upload Documents", style = MaterialTheme.typography.bodySmall)
                            Switch(
                                checked = uiState.newEmployeeCanUpload,
                                onCheckedChange = { onUpdateGeneralPermissions(null, it, null, null) }
                            )
                        }

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(if (isAr) "تحميل المستندات (Download)" else "Download Documents", style = MaterialTheme.typography.bodySmall)
                            Switch(
                                checked = uiState.newEmployeeCanDownload,
                                onCheckedChange = { onUpdateGeneralPermissions(null, null, it, null) }
                            )
                        }

                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                text = if (isAr) "حذف المستندات (Delete)" else "Delete Documents",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error
                            )
                            Switch(
                                checked = uiState.newEmployeeCanDelete,
                                onCheckedChange = { onUpdateGeneralPermissions(null, null, null, it) },
                                colors = SwitchDefaults.colors(
                                    checkedThumbColor = MaterialTheme.colorScheme.error,
                                    checkedTrackColor = MaterialTheme.colorScheme.errorContainer
                                )
                            )
                        }
                    }
                }

                HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                // Quarry Visibility Section
                Text(
                    text = if (isAr) "ظهور المحاجر وتخصيص الوصول" else "Quarry Visibility",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold
                )

                if (sortedQuarries.isEmpty()) {
                    Text(
                        text = if (isAr) "لا توجد محاجر مسجلة في الشركة حالياً" else "No quarries registered in company",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.secondary
                    )
                } else {
                    sortedQuarries.forEach { quarry ->
                        val isHidden = uiState.newEmployeeHiddenQuarries.contains(quarry.id)
                        val isVisible = !isHidden

                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .border(
                                    width = if (isVisible) 1.dp else 0.5.dp,
                                    color = if (isVisible) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                                    shape = RoundedCornerShape(8.dp)
                                ),
                            colors = CardDefaults.cardColors(
                                containerColor = if (isVisible) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.15f) else MaterialTheme.colorScheme.surface
                            )
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onToggleQuarryVisibility(quarry.id) }
                                    .padding(8.dp)
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    modifier = Modifier.weight(1f)
                                ) {
                                    Checkbox(
                                        checked = isVisible,
                                        onCheckedChange = { onToggleQuarryVisibility(quarry.id) }
                                    )
                                    Column {
                                        Text(
                                            text = quarry.name,
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.SemiBold
                                        )
                                        if (!quarry.quarryNumber.isNullOrBlank()) {
                                            Text(
                                                text = "${quarry.quarryNumber} - ${quarry.quarryType.orEmpty()}",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.secondary
                                            )
                                        }
                                    }
                                }

                                Surface(
                                    shape = RoundedCornerShape(6.dp),
                                    color = if (isVisible) Color(0xFFE8F5E9) else Color(0xFFEEEEEE)
                                ) {
                                    Text(
                                        text = if (isVisible) (if (isAr) "مرئي" else "Visible") else (if (isAr) "مخفي" else "Hidden"),
                                        style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                        color = if (isVisible) Color(0xFF2E7D32) else Color(0xFF757575),
                                        fontWeight = FontWeight.Medium
                                    )
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onProceedToReview,
                enabled = uiState.newEmployeeUsername.isNotBlank() && uiState.newEmployeePassword.isNotBlank()
            ) {
                Text(if (isAr) "متابعة للمراجعة" else "Continue to Review")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(if (isAr) "إلغاء" else "Cancel")
            }
        }
    )
}

@Composable
private fun ReviewEmployeeDialog(
    uiState: EmployeeAppUiState,
    isAr: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = {
            if (!uiState.isCreatingEmployee) onDismiss()
        },
        title = {
            Text(
                text = if (isAr) "تأكيد بيانات الموظف" else "Confirm Employee Details",
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = if (isAr) "يرجى مراجعة بيانات الحساب والصلاحيات قبل التأكيد:" else "Please review account details and permissions before confirming:",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.secondary
                )

                HorizontalDivider()

                Text(
                    text = "${if (isAr) "اسم المستخدم: " else "Username: "} ${uiState.newEmployeeUsername}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )

                if (uiState.newEmployeeFullName.isNotBlank()) {
                    Text(
                        text = "${if (isAr) "الاسم الكامل: " else "Full Name: "} ${uiState.newEmployeeFullName}",
                        style = MaterialTheme.typography.bodyMedium
                    )
                }

                if (uiState.newEmployeeEmail.isNotBlank()) {
                    Text(
                        text = "${if (isAr) "البريد الإلكتروني: " else "Email: "} ${uiState.newEmployeeEmail}",
                        style = MaterialTheme.typography.bodyMedium
                    )
                }

                Text(
                    text = "${if (isAr) "المحاجر المحددة: " else "Assigned Quarries: "} ${uiState.selectedEmployeeQuarries.size}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )

                uiState.selectedEmployeeQuarries.forEach { (quarryId, perm) ->
                    val qName = uiState.quarries.find { it.id == quarryId }?.name ?: quarryId
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                    ) {
                        Column(modifier = Modifier.padding(8.dp)) {
                            Text(text = qName, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodySmall)
                            val permsList = mutableListOf<String>()
                            if (perm.canView) permsList.add(if (isAr) "عرض" else "View")
                            if (perm.canUpload) permsList.add(if (isAr) "رفع" else "Upload")
                            if (perm.canDownload) permsList.add(if (isAr) "تحميل" else "Download")
                            if (perm.canDelete) permsList.add(if (isAr) "حذف" else "Delete")
                            Text(
                                text = permsList.joinToString(" • "),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                }

                if (uiState.createEmployeeError != null) {
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer
                        ),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = if (isAr) uiState.createEmployeeError.arabic else uiState.createEmployeeError.english,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(8.dp)
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = !uiState.isCreatingEmployee
            ) {
                if (uiState.isCreatingEmployee) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp
                    )
                } else {
                    Text(if (isAr) "تأكيد وإنشاء الحساب" else "Confirm & Create")
                }
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                enabled = !uiState.isCreatingEmployee
            ) {
                Text(if (isAr) "تعديل" else "Edit")
            }
        }
    )
}
