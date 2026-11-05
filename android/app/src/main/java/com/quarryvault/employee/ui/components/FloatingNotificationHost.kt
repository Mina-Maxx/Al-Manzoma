package com.quarryvault.employee.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.quarryvault.employee.data.util.LocalizedMessage
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.math.abs
import kotlin.math.roundToInt

enum class NotificationType {
    SUCCESS,
    ERROR,
    WARNING,
    INFO
}

data class AppNotification(
    val id: String = UUID.randomUUID().toString(),
    val message: LocalizedMessage,
    val type: NotificationType = NotificationType.INFO,
    val durationMs: Long = 3000L
)

@Composable
fun FloatingNotificationHost(
    notification: AppNotification?,
    isArabic: Boolean,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    val layoutDirection = if (isArabic) LayoutDirection.Rtl else LayoutDirection.Ltr

    CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
        Box(
            modifier = modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 16.dp),
            contentAlignment = Alignment.BottomCenter
        ) {
            AnimatedVisibility(
                visible = notification != null,
                enter = slideInVertically(initialOffsetY = { it / 2 }) + fadeIn(),
                exit = slideOutVertically(targetOffsetY = { it / 2 }) + fadeOut()
            ) {
                if (notification != null) {
                    FloatingNotificationCard(
                        notification = notification,
                        isArabic = isArabic,
                        onDismiss = onDismiss
                    )
                }
            }
        }
    }
}

@Composable
private fun FloatingNotificationCard(
    notification: AppNotification,
    isArabic: Boolean,
    onDismiss: () -> Unit
) {
    val isDark = isSystemInDarkTheme()
    val density = LocalDensity.current
    val dismissThresholdPx = with(density) { 80.dp.toPx() }
    val offsetX = remember(notification.id) { Animatable(0f) }
    val scope = rememberCoroutineScope()

    val (containerColor, contentColor, iconColor, icon) = when (notification.type) {
        NotificationType.SUCCESS -> Quadruple(
            if (isDark) Color(0xFF1B382B) else Color(0xFFE8F5E9),
            if (isDark) Color(0xFFC8E6C9) else Color(0xFF1B5E20),
            Color(0xFF2E7D32),
            Icons.Filled.CheckCircle
        )
        NotificationType.ERROR -> Quadruple(
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
            MaterialTheme.colorScheme.error,
            Icons.Filled.Error
        )
        NotificationType.WARNING -> Quadruple(
            if (isDark) Color(0xFF3E2D1A) else Color(0xFFFFF4E5),
            if (isDark) Color(0xFFFFE0B2) else Color(0xFF663C00),
            Color(0xFFED6C02),
            Icons.Filled.Warning
        )
        NotificationType.INFO -> Quadruple(
            MaterialTheme.colorScheme.primaryContainer,
            MaterialTheme.colorScheme.onPrimaryContainer,
            MaterialTheme.colorScheme.primary,
            Icons.Filled.Info
        )
    }

    val displayedText = if (isArabic) notification.message.arabic else notification.message.english

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = containerColor,
        shadowElevation = 8.dp,
        tonalElevation = 4.dp,
        modifier = Modifier
            .fillMaxWidth()
            .offset { IntOffset(offsetX.value.roundToInt(), 0) }
            .graphicsLayer {
                alpha = (1f - (abs(offsetX.value) / (dismissThresholdPx * 2.5f))).coerceIn(0f, 1f)
            }
            .pointerInput(notification.id) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        if (abs(offsetX.value) > dismissThresholdPx) {
                            scope.launch {
                                val target = if (offsetX.value > 0) 1200f else -1200f
                                offsetX.animateTo(target, tween(200))
                                onDismiss()
                            }
                        } else {
                            scope.launch {
                                offsetX.animateTo(0f, spring())
                            }
                        }
                    },
                    onDragCancel = {
                        scope.launch { offsetX.animateTo(0f, spring()) }
                    },
                    onHorizontalDrag = { change, dragAmount ->
                        change.consume()
                        scope.launch {
                            offsetX.snapTo(offsetX.value + dragAmount)
                        }
                    }
                )
            }
    ) {
        Row(
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = iconColor,
                modifier = Modifier.size(24.dp)
            )

            Text(
                text = displayedText,
                color = contentColor,
                style = MaterialTheme.typography.bodyMedium.copy(
                    fontWeight = FontWeight.Medium,
                    lineHeight = 20.sp
                ),
                modifier = Modifier.weight(1f)
            )

            IconButton(
                onClick = onDismiss,
                modifier = Modifier.size(28.dp)
            ) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = "إغلاق",
                    tint = contentColor.copy(alpha = 0.7f),
                    modifier = Modifier.size(18.dp)
                )
            }
        }
    }
}

private data class Quadruple<A, B, C, D>(
    val first: A,
    val second: B,
    val third: C,
    val fourth: D
)
