package com.quarryvault.employee.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.api.models.EffectivePermissions
import com.quarryvault.employee.ui.theme.QuarryPrimary
import com.quarryvault.employee.ui.theme.QuarrySecondary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    uiState: EmployeeAppUiState,
    onNavigateBack: () -> Unit,
    onUpdateFullName: (String) -> Unit
) {
    BackHandler {
        onNavigateBack()
    }

    val isAr = true
    val layoutDirection = LayoutDirection.Rtl

    val user = uiState.profile?.user
    val company = uiState.profile?.company
    val role = uiState.profile?.role.orEmpty()
    val permissions = uiState.profile?.permissions ?: EffectivePermissions(
        canView = true,
        canUpload = true,
        canDownload = true,
        canDelete = role == "company_admin" || role == "platform_admin"
    )

    var showEditDialog by remember { mutableStateOf(false) }
    var editedName by remember(user?.fullName) { mutableStateOf(user?.fullName.orEmpty()) }

    // Dismiss edit dialog when update succeeds
    LaunchedEffect(uiState.profileUpdateSuccessMessage) {
        if (uiState.profileUpdateSuccessMessage != null) {
            showEditDialog = false
        }
    }

    CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            text = if (isAr) "الملف الشخصي" else "My Profile",
                            fontWeight = FontWeight.Bold
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = onNavigateBack) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = if (isAr) "رجوع" else "Back"
                            )
                        }
                    },

                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface
                    )
                )
            }
        ) { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // User Header Card
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    )
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(20.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        // Avatar
                        Box(
                            modifier = Modifier
                                .size(80.dp)
                                .clip(CircleShape)
                                .background(QuarryPrimary),
                            contentAlignment = Alignment.Center
                        ) {
                            val initials = (user?.fullName ?: user?.username ?: "?")
                                .trim()
                                .take(2)
                                .uppercase()
                            Text(
                                text = initials,
                                style = MaterialTheme.typography.headlineMedium,
                                color = Color.White,
                                fontWeight = FontWeight.Bold
                            )
                        }

                        // Full Name
                        Text(
                            text = user?.fullName?.ifBlank { null }
                                ?: if (isAr) "بدون اسم معروض" else "No display name",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )

                        // Role badge
                        val roleLabel = when (role) {
                            "platform_admin" -> if (isAr) "مسؤول المنصة" else "Platform Admin"
                            "company_admin" -> if (isAr) "مسؤول الشركة" else "Company Admin"
                            "employee" -> if (isAr) "موظف" else "Employee"
                            else -> role
                        }
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = QuarrySecondary.copy(alpha = 0.15f)
                        ) {
                            Text(
                                text = roleLabel,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                                style = MaterialTheme.typography.labelLarge,
                                color = QuarrySecondary,
                                fontWeight = FontWeight.Bold
                            )
                        }

                        // Edit Name Button
                        OutlinedButton(
                            onClick = {
                                editedName = user?.fullName.orEmpty()
                                showEditDialog = true
                            },
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Edit,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(text = if (isAr) "تعديل الاسم" else "Edit Name")
                        }

                    }
                }

                // Status & Success / Error Messages
                if (uiState.profileUpdateError != null) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Text(
                            text = if (isAr) uiState.profileUpdateError.arabic else uiState.profileUpdateError.english,
                            modifier = Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }



                // Account Information Section
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp)
                    ) {
                        Text(
                            text = if (isAr) "بيانات الحساب" else "Account Information",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )

                        ProfileInfoRow(
                            icon = Icons.Default.AccountBox,
                            label = if (isAr) "اسم المستخدم" else "Username",
                            value = user?.username ?: user?.email ?: if (isAr) "غير محدد" else "Not set"
                        )

                        ProfileInfoRow(
                            icon = Icons.Default.Email,
                            label = if (isAr) "البريد الإلكتروني" else "Email",
                            value = user?.email?.ifBlank { null } ?: if (isAr) "غير مسجل" else "Not registered"
                        )

                        ProfileInfoRow(
                            icon = Icons.Default.Business,
                            label = if (isAr) "الشركة / المؤسسة" else "Company / Organization",
                            value = company?.name ?: if (isAr) "غير محدد" else "Not set"
                        )

                        ProfileInfoRow(
                            icon = Icons.Default.CheckCircle,
                            label = if (isAr) "حالة الحساب" else "Account Status",
                            value = if (user?.status == "active") {
                                if (isAr) "نشط" else "Active"
                            } else {
                                user?.status ?: if (isAr) "نشط" else "Active"
                            }
                        )
                    }
                }

                // Permissions Section ("صلاحياتي")
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Security,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(22.dp)
                            )
                            Text(
                                text = if (isAr) "صلاحياتي على المنظومة" else "My System Permissions",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }

                        Text(
                            text = if (isAr)
                                "توضح هذه القائمة الصلاحيات الفعلية الممنوحة لحسابك في تصفح وإدارة المحاجر والمستندات."
                            else
                                "This list shows the effective permissions granted to your account across company quarries and documents.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )

                        HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                        PermissionRow(
                            label = if (isAr) "عرض المحاجر والمستندات" else "View Quarries & Documents",
                            granted = permissions.canView,
                            isAr = isAr
                        )

                        PermissionRow(
                            label = if (isAr) "رفع وحفظ مستندات جديدة" else "Upload Documents",
                            granted = permissions.canUpload,
                            isAr = isAr
                        )

                        PermissionRow(
                            label = if (isAr) "تحميل المستندات إلى الهاتف" else "Download Documents",
                            granted = permissions.canDownload,
                            isAr = isAr
                        )

                        PermissionRow(
                            label = if (isAr) "حذف المستندات ونقلها للسلة" else "Delete Documents to Trash",
                            granted = permissions.canDelete,
                            isAr = isAr,
                            description = if (!permissions.canDelete && isAr) "محظور للموظفين افتراضياً" else null
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))
            }
        }

        // Edit Name Dialog
        if (showEditDialog) {
            AlertDialog(
                onDismissRequest = {
                    if (!uiState.isUpdatingProfile) showEditDialog = false
                },
                title = {
                    Text(
                        text = if (isAr) "تعديل الاسم المعروض" else "Edit Display Name",
                        fontWeight = FontWeight.Bold
                    )
                },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            text = if (isAr)
                                "أدخل اسمك الكامل الذي سيظهر لزملائك وإدارة الشركة."
                            else
                                "Enter your full name to display to colleagues and company management.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        OutlinedTextField(
                            value = editedName,
                            onValueChange = { editedName = it },
                            label = { Text(if (isAr) "الاسم الكامل" else "Full Name") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                            isError = editedName.trim().length < 2 || editedName.trim().length > 100
                        )
                        if (editedName.trim().isNotEmpty() && (editedName.trim().length < 2 || editedName.trim().length > 100)) {
                            Text(
                                text = if (isAr) "يجب أن يكون الاسم بين حرفين و 100 حرف" else "Name must be between 2 and 100 characters",
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        if (uiState.isUpdatingProfile) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 8.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                CircularProgressIndicator(modifier = Modifier.size(28.dp))
                            }
                        }
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            onUpdateFullName(editedName.trim())
                        },
                        enabled = editedName.trim().length in 2..100 && !uiState.isUpdatingProfile
                    ) {
                        Text(if (isAr) "حفظ" else "Save")
                    }
                },
                dismissButton = {
                    TextButton(
                        onClick = { showEditDialog = false },
                        enabled = !uiState.isUpdatingProfile
                    ) {
                        Text(if (isAr) "إلغاء" else "Cancel")
                    }
                }
            )
        }
    }
}

@Composable
private fun ProfileInfoRow(
    icon: ImageVector,
    label: String,
    value: String
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp)
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text(
                text = value,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
        }
    }
}

@Composable
private fun PermissionRow(
    label: String,
    granted: Boolean,
    isAr: Boolean,
    description: String? = null
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
            if (description != null) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        Surface(
            shape = RoundedCornerShape(6.dp),
            color = if (granted) Color(0xFFDCFCE7) else Color(0xFFFEE2E2)
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Icon(
                    imageVector = if (granted) Icons.Default.Check else Icons.Default.Close,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = if (granted) Color(0xFF166534) else Color(0xFF991B1B)
                )
                Text(
                    text = if (granted) {
                        if (isAr) "مسموح" else "Allowed"
                    } else {
                        if (isAr) "غير مسموح" else "Denied"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (granted) Color(0xFF166534) else Color(0xFF991B1B),
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
