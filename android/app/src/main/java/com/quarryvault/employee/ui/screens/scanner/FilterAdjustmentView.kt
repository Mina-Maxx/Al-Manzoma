package com.quarryvault.employee.ui.screens.scanner

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.scanner.ImageProcessor
import com.quarryvault.employee.data.scanner.ScanFilterMode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilterAdjustmentView(
    warpedBitmap: Bitmap,
    initialFilter: ScanFilterMode = ScanFilterMode.DOCUMENT_ENHANCED,
    initialRotation: Int = 0,
    isArabic: Boolean,
    onConfirmPage: (Bitmap, ScanFilterMode, Int, Boolean) -> Unit, // Boolean: addAnotherPage
    onRetakeClicked: () -> Unit
) {
    var selectedFilter by remember { mutableStateOf(initialFilter) }
    var rotationDegrees by remember { mutableStateOf(initialRotation) }

    // Apply rotation and filter for preview
    val previewBitmap = remember(warpedBitmap, selectedFilter, rotationDegrees) {
        val rotated = ImageProcessor.rotateBitmap(warpedBitmap, rotationDegrees)
        ImageProcessor.applyFilter(rotated, selectedFilter)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = if (isArabic) "معالجة وتحسين الصفحة" else "Enhance & Filter Page",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onRetakeClicked) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "إعادة الالتقاط")
                    }
                },
                actions = {
                    IconButton(onClick = {
                        rotationDegrees = (rotationDegrees + 90) % 360
                    }) {
                        Icon(Icons.Default.RotateRight, contentDescription = "تدوير ٩٠ درجة")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            )
        },
        bottomBar = {
            Surface(
                tonalElevation = 6.dp,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    // Filter selection chips
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        FilterChip(
                            selected = selectedFilter == ScanFilterMode.DOCUMENT_ENHANCED,
                            onClick = { selectedFilter = ScanFilterMode.DOCUMENT_ENHANCED },
                            label = { Text(if (isArabic) "مستند محسّن" else "B&W Document") },
                            leadingIcon = { Icon(Icons.Default.AutoFixHigh, contentDescription = null, Modifier.size(16.dp)) }
                        )

                        FilterChip(
                            selected = selectedFilter == ScanFilterMode.COLOR,
                            onClick = { selectedFilter = ScanFilterMode.COLOR },
                            label = { Text(if (isArabic) "الألوان الأصلية" else "Color") },
                            leadingIcon = { Icon(Icons.Default.Palette, contentDescription = null, Modifier.size(16.dp)) }
                        )

                        FilterChip(
                            selected = selectedFilter == ScanFilterMode.GRAYSCALE,
                            onClick = { selectedFilter = ScanFilterMode.GRAYSCALE },
                            label = { Text(if (isArabic) "تدرج الرمادي" else "Grayscale") },
                            leadingIcon = { Icon(Icons.Default.FilterBAndW, contentDescription = null, Modifier.size(16.dp)) }
                        )
                    }

                    // Bottom Action Buttons
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        OutlinedButton(
                            onClick = {
                                onConfirmPage(previewBitmap, selectedFilter, rotationDegrees, true)
                            },
                            modifier = Modifier.weight(1f),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Icon(Icons.Default.AddPhotoAlternate, contentDescription = null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text(if (isArabic) "صفحة أخرى" else "Add Page")
                        }

                        Button(
                            onClick = {
                                onConfirmPage(previewBitmap, selectedFilter, rotationDegrees, false)
                            },
                            modifier = Modifier.weight(1f),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text(if (isArabic) "إنهاء ومراجعة" else "Finish & Review")
                            Spacer(Modifier.width(6.dp))
                            Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, Modifier.size(18.dp))
                        }
                    }
                }
            }
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .background(Color.Black)
                .padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            val imgBitmap = remember(previewBitmap) { previewBitmap.asImageBitmap() }
            Image(
                bitmap = imgBitmap,
                contentDescription = "معاينة الصفحة الممسوحة ضوئياً",
                modifier = Modifier.fillMaxSize()
            )
        }
    }
}
