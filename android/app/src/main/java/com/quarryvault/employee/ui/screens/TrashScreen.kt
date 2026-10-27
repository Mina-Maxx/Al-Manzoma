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
    quarry: Quarry,
    onNavigateBack: () -> Unit,
    onRestoreDocument: (TrashDocument) -> Unit,
    onRefresh: () -> Unit,
    onToggleLanguage: () -> Unit,
    onClearMessages: () -> Unit = {}
) {
    BackHandler {
        onNavigateBack()
    }

    val isAr = uiState.isArabic
    val layoutDirection = if (isAr) LayoutDirection.Rtl else LayoutDirection.Ltr

    var documentPendingRestore by remember { mutableStateOf<TrashDocument?>(null) }

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
                                text = quarry.name,
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
                    actions = {
                        IconButton(onClick = onToggleLanguage) {
                            Text(
                                text = if (isAr) "EN" else "عربي",
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        IconButton(onClick = onRefresh) {
                            Icon(
                                Icons.Default.Refresh,
                                contentDescription = if (isAr) "تحديث" else "Refresh"
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

                    // Success Banner
                    if (uiState.restoreSuccessMessage != null) {
                        item {
                            BannerMessage(
                                message = if (isAr) uiState.restoreSuccessMessage.arabic else uiState.restoreSuccessMessage.english,
                                isError = false,
                                onDismiss = onClearMessages
                            )
                        }
                    }

                    // Error Banner
                    if (uiState.restoreError != null) {
                        item {
                            BannerMessage(
                                message = if (isAr) uiState.restoreError.arabic else uiState.restoreError.english,
                                isError = true,
                                onDismiss = onClearMessages
                            )
                        }
                    }

                    if (uiState.trashError != null) {
                        item {
                            BannerMessage(
                                message = if (isAr) uiState.trashError.arabic else uiState.trashError.english,
                                isError = true,
                                onDismiss = onClearMessages
                            )
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
                                            "لا توجد مستندات محذوفة في هذا المحجر حالياً."
                                        else
                                            "No deleted documents found in this quarry.",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.outline
                                    )
                                }
                            }
                        }
                    } else {
                        items(uiState.trashDocuments, key = { it.id }) { doc ->
                            TrashDocumentCard(
                                document = doc,
                                isAr = isAr,
                                isRestoring = uiState.isRestoringDocument,
                                onRestoreClick = { documentPendingRestore = doc }
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
                            "هل تريد استعادة المستند '${doc.displayName}' وإعادته إلى قائمة المستندات النشطة؟"
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
    }
}

@Composable
fun TrashDocumentCard(
    document: TrashDocument,
    isAr: Boolean,
    isRestoring: Boolean,
    onRestoreClick: () -> Unit
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
                            text = "v${document.version}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary
                        )
                    }

                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = if (isAr)
                            "حُذف: ${UiFormatters.formatDate(document.deletedAt)}"
                        else
                            "Deleted: ${UiFormatters.formatDate(document.deletedAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error
                    )
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
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Button(
                    onClick = onRestoreClick,
                    enabled = !isRestoring,
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
