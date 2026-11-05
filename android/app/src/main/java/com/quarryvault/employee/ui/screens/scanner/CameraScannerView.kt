package com.quarryvault.employee.ui.screens.scanner

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashAuto
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun CameraScannerView(
    pageCount: Int,
    isArabic: Boolean,
    onPictureTaken: (File) -> Unit,
    onReviewClicked: () -> Unit,
    onCloseClicked: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    var imageCapture: ImageCapture? by remember { mutableStateOf(null) }
    var flashMode by remember { mutableStateOf(ImageCapture.FLASH_MODE_OFF) }
    var isCapturing by remember { mutableStateOf(false) }
    var captureError by remember { mutableStateOf<String?>(null) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // Camera Preview
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx).apply {
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }
                val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                cameraProviderFuture.addListener({
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }

                    val capture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .setFlashMode(flashMode)
                        .build()
                    imageCapture = capture

                    val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

                    try {
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            cameraSelector,
                            preview,
                            capture
                        )
                    } catch (_: Exception) {
                        captureError = "تعذر تشغيل الكاميرا. يرجى التحقق من الإذن والمحاولة مرة أخرى."
                    }
                }, ContextCompat.getMainExecutor(ctx))

                previewView
            }
        )

        // Viewfinder Guide Overlay
        Canvas(modifier = Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height

            // Document guide rectangle (typical A4 portrait ratio centered)
            val guideMarginX = w * 0.08f
            val guideWidth = w - (guideMarginX * 2)
            val guideHeight = guideWidth * 1.414f // A4 aspect
            val guideTop = (h - guideHeight) / 2f
            val guideBottom = guideTop + guideHeight
            val guideRight = guideMarginX + guideWidth

            // Draw darkened semi-transparent scrim outside guide
            drawRect(
                color = Color(0x66000000),
                topLeft = Offset(0f, 0f),
                size = androidx.compose.ui.geometry.Size(w, guideTop)
            )
            drawRect(
                color = Color(0x66000000),
                topLeft = Offset(0f, guideBottom),
                size = androidx.compose.ui.geometry.Size(w, h - guideBottom)
            )
            drawRect(
                color = Color(0x66000000),
                topLeft = Offset(0f, guideTop),
                size = androidx.compose.ui.geometry.Size(guideMarginX, guideHeight)
            )
            drawRect(
                color = Color(0x66000000),
                topLeft = Offset(guideRight, guideTop),
                size = androidx.compose.ui.geometry.Size(w - guideRight, guideHeight)
            )

            // Draw cyan boundary frame with corner brackets
            val strokeColor = Color(0xFF00E5FF)
            drawRect(
                color = strokeColor.copy(alpha = 0.5f),
                topLeft = Offset(guideMarginX, guideTop),
                size = androidx.compose.ui.geometry.Size(guideWidth, guideHeight),
                style = Stroke(width = 2.dp.toPx())
            )

            // Highlighted Corner Brackets
            val cornerLen = 28.dp.toPx()
            val cornerStroke = Stroke(width = 4.dp.toPx())

            // Top-Left
            drawLine(strokeColor, Offset(guideMarginX, guideTop), Offset(guideMarginX + cornerLen, guideTop), cornerStroke.width)
            drawLine(strokeColor, Offset(guideMarginX, guideTop), Offset(guideMarginX, guideTop + cornerLen), cornerStroke.width)
            // Top-Right
            drawLine(strokeColor, Offset(guideRight, guideTop), Offset(guideRight - cornerLen, guideTop), cornerStroke.width)
            drawLine(strokeColor, Offset(guideRight, guideTop), Offset(guideRight, guideTop + cornerLen), cornerStroke.width)
            // Bottom-Right
            drawLine(strokeColor, Offset(guideRight, guideBottom), Offset(guideRight - cornerLen, guideBottom), cornerStroke.width)
            drawLine(strokeColor, Offset(guideRight, guideBottom), Offset(guideRight, guideBottom - cornerLen), cornerStroke.width)
            // Bottom-Left
            drawLine(strokeColor, Offset(guideMarginX, guideBottom), Offset(guideMarginX + cornerLen, guideBottom), cornerStroke.width)
            drawLine(strokeColor, Offset(guideMarginX, guideBottom), Offset(guideMarginX, guideBottom - cornerLen), cornerStroke.width)
        }

        // Top Bar: Close, Instruction hint, Flash toggle
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(
                onClick = onCloseClicked,
                modifier = Modifier
                    .size(44.dp)
                    .background(Color(0x88000000), CircleShape)
            ) {
                Icon(Icons.Default.Close, contentDescription = "إغلاق", tint = Color.White)
            }

            Surface(
                color = Color(0x99000000),
                shape = RoundedCornerShape(16.dp)
            ) {
                Text(
                    text = if (isArabic) "اضبط المستند داخل الإطار" else "Fit document inside frame",
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp)
                )
            }

            IconButton(
                onClick = {
                    flashMode = when (flashMode) {
                        ImageCapture.FLASH_MODE_OFF -> ImageCapture.FLASH_MODE_ON
                        ImageCapture.FLASH_MODE_ON -> ImageCapture.FLASH_MODE_AUTO
                        else -> ImageCapture.FLASH_MODE_OFF
                    }
                    imageCapture?.flashMode = flashMode
                },
                modifier = Modifier
                    .size(44.dp)
                    .background(Color(0x88000000), CircleShape)
            ) {
                val icon = when (flashMode) {
                    ImageCapture.FLASH_MODE_ON -> Icons.Default.FlashOn
                    ImageCapture.FLASH_MODE_AUTO -> Icons.Default.FlashAuto
                    else -> Icons.Default.FlashOff
                }
                Icon(icon, contentDescription = "الفلاش", tint = Color.White)
            }
        }

        // Bottom Bar: Review Pages badge, Shutter button, Spacer
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(bottom = 32.dp, start = 24.dp, end = 24.dp)
        ) {
            // Page count review button (left / right depending on RTL)
            if (pageCount > 0) {
                Button(
                    onClick = onReviewClicked,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        contentColor = MaterialTheme.colorScheme.onPrimaryContainer
                    ),
                    shape = RoundedCornerShape(24.dp),
                    modifier = Modifier.align(if (isArabic) Alignment.CenterEnd else Alignment.CenterStart)
                ) {
                    Icon(Icons.Default.PhotoLibrary, contentDescription = null, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = if (isArabic) "$pageCount صفحات" else "$pageCount pages",
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            // Big Circular Shutter Button (Center)
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(80.dp)
                    .border(4.dp, Color.White, CircleShape)
                    .padding(6.dp)
                    .clip(CircleShape)
                    .background(if (isCapturing) Color.LightGray else Color.White)
            ) {
                IconButton(
                    onClick = {
                        if (isCapturing) return@IconButton
                        val capture = imageCapture ?: return@IconButton
                        isCapturing = true

                        val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                        val cacheDir = File(context.cacheDir, "quarryvault_scans").apply { mkdirs() }
                        val photoFile = File(cacheDir, "RAW_${timeStamp}.jpg")

                        val outputOptions = ImageCapture.OutputFileOptions.Builder(photoFile).build()
                        capture.takePicture(
                            outputOptions,
                            ContextCompat.getMainExecutor(context),
                            object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                                    isCapturing = false
                                    onPictureTaken(photoFile)
                                }

                                override fun onError(exception: ImageCaptureException) {
                                    isCapturing = false
                                    captureError = "تعذر التقاط الصورة. يرجى المحاولة مرة أخرى."
                                }
                            }
                        )
                    },
                    modifier = Modifier.fillMaxSize()
                ) {
                    Icon(
                        Icons.Default.CameraAlt,
                        contentDescription = "التقاط صورة",
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(36.dp)
                    )
                }
            }
        }
    }
}
