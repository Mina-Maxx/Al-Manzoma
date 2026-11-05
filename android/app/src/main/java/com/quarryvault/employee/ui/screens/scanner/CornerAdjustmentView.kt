package com.quarryvault.employee.ui.screens.scanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Crop
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.quarryvault.employee.data.scanner.DocumentCorners
import com.quarryvault.employee.data.scanner.EdgeDetector
import com.quarryvault.employee.data.scanner.ScanPoint
import java.io.File
import kotlin.math.hypot

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CornerAdjustmentView(
    imageFile: File,
    initialCorners: DocumentCorners?,
    isArabic: Boolean,
    onCornersConfirmed: (Bitmap, DocumentCorners) -> Unit,
    onRetakeClicked: () -> Unit
) {
    // Load bitmap once
    val bitmap = remember(imageFile) {
        val options = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        BitmapFactory.decodeFile(imageFile.absolutePath, options)
    }

    if (bitmap == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(if (isArabic) "خطأ في قراءة الصورة الملتقطة" else "Failed to load captured image")
        }
        return
    }

    // State for corners
    var corners by remember {
        mutableStateOf(
            initialCorners
                ?: EdgeDetector.detectCorners(bitmap)
                ?: DocumentCorners.defaultCorners()
        )
    }

    var viewSize by remember { mutableStateOf(IntSize.Zero) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = if (isArabic) "ضبط حواف المستند" else "Adjust Document Edges",
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
                        corners = EdgeDetector.detectCorners(bitmap) ?: DocumentCorners.defaultCorners()
                    }) {
                        Icon(Icons.Default.Refresh, contentDescription = "إعادة ضبط الحواف")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            )
        },
        bottomBar = {
            Surface(
                tonalElevation = 4.dp,
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedButton(
                        onClick = onRetakeClicked,
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Text(if (isArabic) "إعادة الالتقاط" else "Retake")
                    }

                    Button(
                        onClick = {
                            val validCorners = if (corners.isAcceptableQuad()) corners else DocumentCorners.defaultCorners()
                            onCornersConfirmed(bitmap, validCorners)
                        },
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Text(if (isArabic) "قص ومتابعة" else "Crop & Next")
                        Spacer(Modifier.width(8.dp))
                        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null)
                    }
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .background(Color.Black),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Helper instruction banner
            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer,
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Default.Crop, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = if (isArabic)
                            "اسحب المقابض الدائرية الأربعة لمطابقة زوايا المستند"
                        else
                            "Drag the 4 corner handles to align with the document edges",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }

            // Interactive Image & Corner Mesh Area
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .weight(1f)
                    .onSizeChanged { viewSize = it }
            ) {
                val imageBitmap = remember(bitmap) { bitmap.asImageBitmap() }

                // Calculate image display rect within the view (Letterboxed / FitCenter)
                val viewW = viewSize.width.toFloat()
                val viewH = viewSize.height.toFloat()

                val bmW = bitmap.width.toFloat()
                val bmH = bitmap.height.toFloat()

                val scale = if (viewW > 0 && viewH > 0) minOf(viewW / bmW, viewH / bmH) else 1f
                val drawnW = bmW * scale
                val drawnH = bmH * scale
                val offsetX = (viewW - drawnW) / 2f
                val offsetY = (viewH - drawnH) / 2f

                // Canvas drawing the image, boundary polygon, and corner handles
                Canvas(
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(drawnW, drawnH, offsetX, offsetY) {
                            if (drawnW <= 0 || drawnH <= 0) return@pointerInput

                            var activeCornerIndex: Int? = null
                            val touchRadiusPx = 48.dp.toPx()

                            detectDragGestures(
                                onDragStart = { touchOffset ->
                                    // Identify nearest corner
                                    val pts = listOf(
                                        corners.topLeft,
                                        corners.topRight,
                                        corners.bottomRight,
                                        corners.bottomLeft
                                    )

                                    var nearestIdx: Int? = null
                                    var minDist = Float.MAX_VALUE

                                    for (i in pts.indices) {
                                        val cx = offsetX + (pts[i].x * drawnW)
                                        val cy = offsetY + (pts[i].y * drawnH)
                                        val dist = hypot(touchOffset.x - cx, touchOffset.y - cy)
                                        if (dist < minDist && dist <= touchRadiusPx * 1.5f) {
                                            minDist = dist
                                            nearestIdx = i
                                        }
                                    }
                                    activeCornerIndex = nearestIdx
                                },
                                onDrag = { change, dragAmount ->
                                    val idx = activeCornerIndex ?: return@detectDragGestures
                                    change.consume()

                                    val currentPt = when (idx) {
                                        0 -> corners.topLeft
                                        1 -> corners.topRight
                                        2 -> corners.bottomRight
                                        else -> corners.bottomLeft
                                    }

                                    val newNormX = ((currentPt.x * drawnW) + dragAmount.x) / drawnW
                                    val newNormY = ((currentPt.y * drawnH) + dragAmount.y) / drawnH

                                    val clampedPt = ScanPoint(
                                        x = newNormX.coerceIn(0f, 1f),
                                        y = newNormY.coerceIn(0f, 1f)
                                    )

                                    corners = when (idx) {
                                        0 -> corners.copy(topLeft = clampedPt)
                                        1 -> corners.copy(topRight = clampedPt)
                                        2 -> corners.copy(bottomRight = clampedPt)
                                        else -> corners.copy(bottomLeft = clampedPt)
                                    }
                                },
                                onDragEnd = {
                                    activeCornerIndex = null
                                }
                            )
                        }
                ) {
                    if (drawnW <= 0 || drawnH <= 0) return@Canvas

                    // 1. Draw Image
                    drawImage(
                        image = imageBitmap,
                        dstOffset = androidx.compose.ui.unit.IntOffset(offsetX.toInt(), offsetY.toInt()),
                        dstSize = androidx.compose.ui.unit.IntSize(drawnW.toInt(), drawnH.toInt())
                    )

                    // 2. Compute absolute screen coordinates for corners
                    val p0 = Offset(offsetX + corners.topLeft.x * drawnW, offsetY + corners.topLeft.y * drawnH)
                    val p1 = Offset(offsetX + corners.topRight.x * drawnW, offsetY + corners.topRight.y * drawnH)
                    val p2 = Offset(offsetX + corners.bottomRight.x * drawnW, offsetY + corners.bottomRight.y * drawnH)
                    val p3 = Offset(offsetX + corners.bottomLeft.x * drawnW, offsetY + corners.bottomLeft.y * drawnH)

                    // 3. Draw Polygon Shading & Border
                    val polyPath = Path().apply {
                        moveTo(p0.x, p0.y)
                        lineTo(p1.x, p1.y)
                        lineTo(p2.x, p2.y)
                        lineTo(p3.x, p3.y)
                        close()
                    }

                    // Semi-transparent overlay inside polygon
                    drawPath(polyPath, Color(0x3300E5FF))
                    // Boundary outline
                    drawPath(polyPath, Color(0xFF00E5FF), style = Stroke(width = 3.dp.toPx()))

                    // 4. Draw Corner Handles (Draggable Circles)
                    val handleRadius = 14.dp.toPx()
                    val handleOuterRadius = 20.dp.toPx()
                    val cornerPoints = listOf(p0, p1, p2, p3)

                    for (pt in cornerPoints) {
                        drawCircle(
                            color = Color(0x4400E5FF),
                            radius = handleOuterRadius,
                            center = pt
                        )
                        drawCircle(
                            color = Color(0xFF00E5FF),
                            radius = handleRadius,
                            center = pt
                        )
                        drawCircle(
                            color = Color.White,
                            radius = handleRadius * 0.5f,
                            center = pt
                        )
                    }
                }
            }
        }
    }
}
