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

    fun formatRemainingDays(isoString: String, isArabic: Boolean = true): String {
        return try {
            val inputFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
            val expiryDate = inputFormat.parse(isoString.substringBefore(".")) ?: return ""
            val diffMs = expiryDate.time - System.currentTimeMillis()
            val days = (diffMs / (1000 * 60 * 60 * 24)).coerceAtLeast(0)
            if (isArabic) {
                if (days == 0L) "أقل من يوم متبقي" else "$days يوم متبقي للحذف النهائي"
            } else {
                if (days == 0L) "Less than 1 day remaining" else "$days days remaining"
            }
        } catch (_: Exception) {
            ""
        }
    }

    fun formatRoleLabel(role: String, isArabic: Boolean = true): String {
        return when (role) {
            "platform_admin" -> if (isArabic) "مسؤول المنصة" else "Platform Admin"
            "company_admin" -> if (isArabic) "أدمن المكتب" else "Office Admin"
            "employee" -> if (isArabic) "موظف" else "Employee"
            else -> role
        }
    }

    private val arabicCollator: java.text.Collator by lazy {
        java.text.Collator.getInstance(Locale("ar")).apply {
            strength = java.text.Collator.PRIMARY
        }
    }

    fun <T> sortAlphabetically(items: List<T>, keySelector: (T) -> String): List<T> {
        return items.sortedWith { a, b ->
            val keyA = keySelector(a).trim()
            val keyB = keySelector(b).trim()
            arabicCollator.compare(keyA, keyB)
        }
    }
}
