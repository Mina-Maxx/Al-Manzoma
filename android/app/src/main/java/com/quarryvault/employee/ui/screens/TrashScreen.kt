package com.quarryvault.employee.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.api.models.Quarry
import com.quarryvault.employee.data.api.models.TrashDocument
import com.quarryvault.employee.ui.util.UiFormatters

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(
    uiState: EmployeeAppUiState,
    quarry: Quarry? = null,
    onNavigateBack: () -> Unit,
    onRestoreDocument: (TrashDocument) -> Unit,
    onPermanentlyDeleteDocument: (TrashDocument) -> Unit = {},
    onRefresh: () -> Unit,
    onClearMessages: () -> Unit = {}
) {
    BackHandler {
        onNavigateBack()
    }

    val isAr = uiState.isArabic
    val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr

    var documentPendingRestore by remember { mutableStateOf<TrashDocument?>(null) }
    var documentPendingPermanentDelete by remember { mutableStateOf<TrashDocument?>(null) }
    val sortedTrash = remember(uiState.trashDocuments) {
        com.quarryvault.employee.ui.util.UiFormatters.sortAlphabetically(uiState.trashDocuments) { it.displayName }
    }
    val canPermanentlyDelete = uiState.profile?.role == "company_admin" || uiState.profile?.permissions?.canDelete == true

    CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text(
                                text = if (isAr) "سلة المهملات" else "Trash & Recovery",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                text = quarry?.displayNameFormatted ?: (if (isAr) "سلة المهملات المركزية لجميع المحاجر" else "Centralized Company Trash"),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.8f)
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onNavigateBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = if (isAr) "رجوع" else "Back"
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                    )
                )
            }
        ) { paddingValues ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
            ) {
                PullToRefreshBox(
                    isRefreshing = uiState.isRefreshingTrash,
                    onRefresh = onRefresh,
                    modifier = Modifier.fillMaxSize()
                ) {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(horizontal = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = PaddingValues(top = 12.dp, bottom = 80.dp)
                    ) {
                        // Retention Policy Card
                        item {
                            Card(
                                shape = RoundedCornerShape(12.dp),
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f)
                                ),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Row(
                                    modifier = Modifier.padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                                ) {
                                    Icon(
                                        Icons.Default.Info,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.onSecondaryContainer
                                    )
                                    Text(
                                        text = if (isAr)
                                            "يتم الاحتفاظ بالمستندات المحذوفة لمدة 30 يوماً قبل الحذف النهائي. يمكنك استعادة أي مستند لإعادته إلى أرشيف المحجر."
                                        else
                                            "Deleted documents are retained for 30 days before permanent purging. You can restore any document back to the quarry archive.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSecondaryContainer
                                    )
                                }
                            }
                        }

                        // Trash List
                        if (uiState.trashDocuments.isEmpty() && !uiState.isLoadingTrash) {
                            item {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 48.dp),
                                    contentAlignment = Alignment.Center
                                ) {
                                    Column(
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                        verticalArrangement = Arrangement.spacedBy(8.dp)
                                    ) {
                                        Icon(
                                            Icons.Default.DeleteSweep,
                                            contentDescription = null,
                                            tint = MaterialTheme.colorScheme.outline,
                                            modifier = Modifier.size(56.dp)
                                        )
                                        Text(
                                            text = if (isAr) "سلة المهملات فارغة" else "Trash is empty",
                                            style = MaterialTheme.typography.titleMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                        Text(
                                            text = if (isAr)
                                                "لا توجد مستندات محذوفة حالياً."
                                            else
                                                "No deleted documents found.",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.outline
                                        )
                                    }
                                }
                            }
                        } else {
                            items(sortedTrash, key = { it.id }) { doc ->
                                TrashDocumentCard(
                                    document = doc,
                                    isAr = isAr,
                                    isRestoring = uiState.isRestoringDocument,
                                    canPermanentlyDelete = canPermanentlyDelete,
                                    onRestoreClick = { documentPendingRestore = doc },
                                    onPermanentlyDeleteClick = { documentPendingPermanentDelete = doc }
                                )
                            }
                        }
                    }

                    if (uiState.isLoadingTrash) {
                        CircularProgressIndicator(
                            modifier = Modifier.align(Alignment.Center)
                        )
                    }
                }
            }
        }

        // Restore Confirmation Dialog
        if (documentPendingRestore != null) {
            val doc = documentPendingRestore!!
            AlertDialog(
                onDismissRequest = { documentPendingRestore = null },
                icon = {
                    Icon(
                        Icons.Default.Restore,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary
                    )
                },
                title = {
                    Text(if (isAr) "استعادة المستند" else "Restore Document")
                },
                text = {
                    Text(
                        if (isAr)
                            "هل أنت متأكد من استعادة المستند '${doc.displayName}' إلى مكانه الأصلي في ${doc.quarryName ?: "المحجر"} (${doc.folderName ?: "المجلد الرئيسي"})؟"
                        else
                            "Restore document '${doc.displayName}' back to the active documents list?"
                    )
                },
                confirmButton = {
                    Button(
                        onClick = {
                            val target = doc
                            documentPendingRestore = null
                            onRestoreDocument(target)
                        }
                    ) {
                        Text(if (isAr) "استعادة" else "Restore")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { documentPendingRestore = null }) {
                        Text(if (isAr) "إلغاء" else "Cancel")
                    }
                }
            )
        }

        // Permanent Deletion Confirmation Dialog
        if (documentPendingPermanentDelete != null) {
            val doc = documentPendingPermanentDelete!!
            AlertDialog(
                onDismissRequest = { documentPendingPermanentDelete = null },
                icon = {
                    Icon(
                        Icons.Default.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error
                    )
                },
                title = {
                    Text(if (isAr) "تأكيد الحذف النهائي" else "Confirm Permanent Deletion")
                },
                text = {
                    Text(
                        if (isAr)
                            "تحذير: هل أنت متأكد من رغبتك في حذف المستند '${doc.displayName}' نهائياً؟ سيتم حذف جميع النسخ والملفات المرتبطة به نهائياً وتحرير المساحة، ولا يمكن استرجاع هذه البيانات بعد الحذف."
                        else
                            "Warning: Are you sure you want to permanently delete '${doc.displayName}'? This action cannot be undone."
                    )
                },
                confirmButton = {
                    Button(
                        onClick = {
                            val target = doc
                            documentPendingPermanentDelete = null
                            onPermanentlyDeleteDocument(target)
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError
                        )
                    ) {
                        Text(if (isAr) "حذف نهائي" else "Delete Permanently")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { documentPendingPermanentDelete = null }) {
                        Text(if (isAr) "إلغاء" else "Cancel")
                    }
                }
            )
        }
    }
}

@Composable
fun TrashDocumentCard(
    document: TrashDocument,
    isAr: Boolean,
    isRestoring: Boolean,
    canPermanentlyDelete: Boolean = false,
    onRestoreClick: () -> Unit,
    onPermanentlyDeleteClick: () -> Unit = {}
) {
    val isPdf = document.mimeType.contains("pdf", ignoreCase = true) ||
            document.originalFilename.endsWith(".pdf", ignoreCase = true)

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp)
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // Icon
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = Color(0xFFFEE2E2),
                    modifier = Modifier.size(44.dp)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            imageVector = if (isPdf) Icons.Default.PictureAsPdf else Icons.Default.Description,
                            contentDescription = null,
                            tint = Color(0xFFB91C1C)
                        )
                    }
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = document.displayName,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = document.originalFilename,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        if (!document.quarryName.isNullOrBlank()) {
                            Surface(
                                shape = RoundedCornerShape(4.dp),
                                color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.8f)
                            ) {
                                Text(
                                    text = document.quarryName,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }
                        Surface(
                            shape = RoundedCornerShape(4.dp),
                            color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.8f)
                        ) {
                            Text(
                                text = document.folderName ?: (if (isAr) "المجلد الرئيسي" else "Root Folder"),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(4.dp))
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = UiFormatters.formatBytes(document.sizeBytes, isAr),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary
                        )
                        Text(text = "•", style = MaterialTheme.typography.labelSmall)
                        Text(
                            text = "الإصدار ${document.version}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary
                        )
                    }

                    Spacer(modifier = Modifier.height(4.dp))
                    if (!document.deletedByName.isNullOrBlank()) {
                        Text(
                            text = if (isAr) "حُذف بواسطة: ${document.deletedByName}" else "Deleted by: ${document.deletedByName}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Text(
                        text = if (isAr)
                            "تاريخ الحذف: ${UiFormatters.formatDate(document.deletedAt)}"
                        else
                            "Deleted: ${UiFormatters.formatDate(document.deletedAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error
                    )
                    val remainingDaysText = UiFormatters.formatRemainingDays(document.retentionExpiresAt, isAr)
                    if (remainingDaysText.isNotBlank()) {
                        Text(
                            text = remainingDaysText,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                    Text(
                        text = if (isAr)
                            "تاريخ الإتلاف النهائي: ${UiFormatters.formatDate(document.retentionExpiresAt)}"
                        else
                            "Purge date: ${UiFormatters.formatDate(document.retentionExpiresAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.outline
                    )
                }
            }

            Spacer(modifier = Modifier.height(10.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.3f))
            Spacer(modifier = Modifier.height(6.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (canPermanentlyDelete) {
                    Button(
                        onClick = onPermanentlyDeleteClick,
                        enabled = !isRestoring,
                        shape = RoundedCornerShape(8.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError
                        )
                    ) {
                        Icon(
                            Icons.Default.DeleteForever,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(if (isAr) "حذف نهائي" else "Delete Permanently")
                    }
                }

                Button(
                    onClick = onRestoreClick,
                    enabled = !isRestoring && document.canRestore,
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Icon(
                        Icons.Default.Restore,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(if (isAr) "استعادة" else "Restore")
                }
            }
        }
    }
}
