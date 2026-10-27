package com.quarryvault.employee.ui.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object UiFormatters {

    fun formatBytes(bytes: Long, isArabic: Boolean = false): String {
        if (bytes <= 0) return if (isArabic) "0 بايت" else "0 B"
        val unitsEn = arrayOf("B", "KB", "MB", "GB", "TB")
        val unitsAr = arrayOf("بايت", "ك.بايت", "م.بايت", "ج.بايت", "ت.بايت")
        val units = if (isArabic) unitsAr else unitsEn

        var size = bytes.toDouble()
        var unitIndex = 0
        while (size >= 1024 && unitIndex < units.size - 1) {
            size /= 1024
            unitIndex++
        }

        return if (unitIndex == 0) {
            "${size.toLong()} ${units[unitIndex]}"
        } else {
            String.format(Locale.US, "%.1f %s", size, units[unitIndex])
        }
    }

    fun formatDate(isoString: String): String {
        return try {
            val inputFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
            val date = inputFormat.parse(isoString.substringBefore(".")) ?: Date()
            val outputFormat = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
            outputFormat.format(date)
        } catch (_: Exception) {
            isoString.substringBefore("T")
        }
    }
}
