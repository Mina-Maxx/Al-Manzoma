package com.quarryvault.employee.data.util

import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Utility for parsing HTTP Content-Disposition headers according to RFC 6266 and RFC 5987,
 * and safely sanitizing filenames across Android filesystems while fully preserving Arabic
 * and other valid Unicode characters.
 */
object ContentDispositionParser {

    private val FILENAME_STAR_REGEX = Regex("""filename\*\s*=\s*(?:(?:"([^"]*)")|([^;\s]+))""", RegexOption.IGNORE_CASE)
    private val FILENAME_REGEX = Regex("""(?:^|;)\s*filename\s*=\s*(?:(?:"([^"]*)")|([^;\s]+))""", RegexOption.IGNORE_CASE)
    private val ILLEGAL_CHARS_REGEX = Regex("""[\\/:*?"<>|\x00-\x1F]""")

    /**
     * Convenience method to extract filename or return null if absent/blank.
     */
    fun extractFilename(contentDisposition: String?): String? {
        if (contentDisposition.isNullOrBlank()) return null
        val parsed = parseFilename(contentDisposition, "")
        return parsed.ifBlank { null }
    }

    /**
     * Extracts and decodes the filename from an HTTP Content-Disposition header.
     *
     * Per RFC 6266 Section 4.3:
     * - When both "filename" and "filename*" are present, "filename*" MUST be preferred.
     * - "filename*" conveys RFC 5987 encoded characters (e.g. UTF-8''%D8%B1...).
     * - Decodes UTF-8 percent-encoding exactly once.
     * - Safely falls back to the ASCII "filename" parameter if "filename*" is absent.
     * - Applies filesystem sanitization while preserving valid Unicode (e.g. Arabic) characters.
     */
    fun parseFilename(contentDisposition: String?, fallbackName: String = "document"): String {
        if (contentDisposition.isNullOrBlank()) {
            return sanitizeFilename(fallbackName)
        }

        // 1. Try RFC 5987 filename* first
        val starMatch = FILENAME_STAR_REGEX.find(contentDisposition)
        if (starMatch != null) {
            val rawStar = (starMatch.groups[1]?.value ?: starMatch.groups[2]?.value).orEmpty().trim()
            val decodedStar = decodeRfc5987(rawStar)
            if (decodedStar.isNotBlank()) {
                return sanitizeFilename(decodedStar, fallbackName)
            }
        }

        // 2. Fall back to standard filename parameter
        val standardMatch = FILENAME_REGEX.find(contentDisposition)
        if (standardMatch != null) {
            val rawName = (standardMatch.groups[1]?.value ?: standardMatch.groups[2]?.value).orEmpty().trim()
            if (rawName.isNotBlank()) {
                // If rawName was percent-encoded by a non-conforming server, decode it once safely
                val decodedName = if (rawName.contains('%')) {
                    try {
                        URLDecoder.decode(rawName, StandardCharsets.UTF_8.name())
                    } catch (_: Exception) {
                        rawName
                    }
                } else {
                    rawName
                }
                return sanitizeFilename(decodedName, fallbackName)
            }
        }

        return sanitizeFilename(fallbackName)
    }

    /**
     * Decodes an RFC 5987 ext-value: <charset>'<language>'<percent-encoded-value>
     */
    private fun decodeRfc5987(extValue: String): String {
        val cleanValue = extValue.removeSurrounding("\"").trim()
        val firstQuote = cleanValue.indexOf('\'')
        if (firstQuote == -1) {
            // No charset delimiter, attempt direct UTF-8 URL decoding
            return try {
                URLDecoder.decode(cleanValue, StandardCharsets.UTF_8.name())
            } catch (_: Exception) {
                cleanValue
            }
        }

        val secondQuote = cleanValue.indexOf('\'', firstQuote + 1)
        if (secondQuote == -1) {
            return try {
                URLDecoder.decode(cleanValue, StandardCharsets.UTF_8.name())
            } catch (_: Exception) {
                cleanValue
            }
        }

        val charsetName = cleanValue.substring(0, firstQuote).trim().ifBlank { "UTF-8" }
        val encodedPayload = cleanValue.substring(secondQuote + 1)

        return try {
            URLDecoder.decode(encodedPayload, charsetName)
        } catch (_: Exception) {
            try {
                URLDecoder.decode(encodedPayload, StandardCharsets.UTF_8.name())
            } catch (_: Exception) {
                encodedPayload
            }
        }
    }

    /**
     * Sanitizes a filename for Android filesystem storage:
     * - Strips path traversal characters (../, ..\, directory paths).
     * - Replaces illegal filesystem characters (\\ / : * ? " < > | and control chars) with '_'.
     * - Retains all valid Unicode characters, including Arabic letters and numbers.
     * - Strips leading/trailing spaces and dots.
     * - Preserves valid extensions and caps length at 255 characters.
     */
    fun sanitizeFilename(rawName: String, fallback: String = "document"): String {
        if (rawName.isBlank()) {
            return fallback.ifBlank { "document" }
        }

        // 1. Strip path traversal & directory paths
        val normalizedPath = rawName.replace('\\', '/')
        val baseName = normalizedPath.substringAfterLast('/')

        // 2. Replace illegal filesystem characters while preserving Unicode (Arabic, etc.)
        val cleanChars = ILLEGAL_CHARS_REGEX.replace(baseName, "_")

        // 3. Remove leading and trailing dots and whitespace
        var trimmed = cleanChars.trim { it <= ' ' || it == '.' }

        // If nothing remains or filename consists only of underscores, check fallback
        if (trimmed.isBlank() || trimmed.all { it == '_' }) {
            trimmed = fallback.trim { it <= ' ' || it == '.' }.ifBlank { "document" }
        }

        // Ensure extension is retained if trimmed starts with a dot
        if (trimmed.startsWith('.')) {
            trimmed = "document$trimmed"
        }

        // 4. Cap length at 255 characters while preserving extension
        if (trimmed.length > 255) {
            val lastDot = trimmed.lastIndexOf('.')
            trimmed = if (lastDot in 1..254) {
                val ext = trimmed.substring(lastDot)
                val base = trimmed.substring(0, lastDot).take(255 - ext.length)
                "$base$ext"
            } else {
                trimmed.take(255)
            }
        }

        return trimmed.ifBlank { "document" }
    }
}
