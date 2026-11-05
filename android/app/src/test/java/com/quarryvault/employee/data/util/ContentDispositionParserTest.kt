package com.quarryvault.employee.data.util

import com.quarryvault.employee.data.api.models.Document
import com.quarryvault.employee.ui.util.DocumentActionsHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ContentDispositionParserTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun parseFilename_prefersRfc5987FilenameStarWithArabic() {
        val header = """attachment; filename="document.pdf"; filename*=UTF-8''%D8%B1%D8%AE%D8%B5%D8%A9%20%D8%A7%D9%84%D9%85%D8%AD%D8%AC%D8%B1.pdf"""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("رخصة المحجر.pdf", filename)
    }

    @Test
    fun parseFilename_handlesArabicWithSpaces() {
        val header = """attachment; filename="contract.pdf"; filename*=UTF-8''%D8%B9%D9%82%D8%AF%20%D8%AA%D9%88%D8%B1%D9%8A%D8%AF%20%D9%85%D8%AD%D8%AC%D8%B1.pdf"""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("عقد توريد محجر.pdf", filename)
    }

    @Test
    fun parseFilename_handlesMixedArabicAndEnglish() {
        val header = """attachment; filename="Quarry__2026.pdf"; filename*=UTF-8''Quarry_%D8%B1%D8%AE%D8%B5%D8%A9_2026.pdf"""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("Quarry_رخصة_2026.pdf", filename)
    }

    @Test
    fun parseFilename_handlesArabicWithParentheses() {
        val header = """attachment; filename="(1).pdf"; filename*=UTF-8''%D8%B1%D8%AE%D8%B5%D8%A9%20%281%29.pdf"""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("رخصة (1).pdf", filename)
    }

    @Test
    fun parseFilename_handlesPureEnglishWithFilenameStar() {
        val header = """attachment; filename="geology_survey.pdf"; filename*=UTF-8''geology_survey.pdf"""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("geology_survey.pdf", filename)
    }

    @Test
    fun parseFilename_fallsBackToStandardFilenameWhenStarAbsent() {
        val header = """attachment; filename="standard_report.pdf""""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("standard_report.pdf", filename)
    }

    @Test
    fun parseFilename_handlesUnquotedFilename() {
        val header = "attachment; filename=unquoted_name.pdf"
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("unquoted_name.pdf", filename)
    }

    @Test
    fun parseFilename_handlesLegacyPercentEncodedInStandardFilename() {
        val header = """attachment; filename="%D8%B1%D8%AE%D8%B5%D8%A9.pdf""""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("رخصة.pdf", filename)
    }

    @Test
    fun parseFilename_fallsBackGracefullyWhenHeaderNullOrBlank() {
        assertEquals("default.pdf", ContentDispositionParser.parseFilename(null, "default.pdf"))
        assertEquals("default.pdf", ContentDispositionParser.parseFilename("", "default.pdf"))
        assertEquals("default.pdf", ContentDispositionParser.parseFilename("   ", "default.pdf"))
    }

    @Test
    fun parseFilename_fallsBackGracefullyWhenHeaderMalformed() {
        val header = "attachment; corrupted_parameter=unknown"
        val filename = ContentDispositionParser.parseFilename(header, "fallback.pdf")
        assertEquals("fallback.pdf", filename)
    }

    @Test
    fun sanitizeFilename_neutralizesPathTraversalAttempts() {
        val traversal1 = "../../etc/passwd"
        assertEquals("passwd", ContentDispositionParser.sanitizeFilename(traversal1))

        val traversal2 = "..\\..\\windows\\system32\\secret.pdf"
        assertEquals("secret.pdf", ContentDispositionParser.sanitizeFilename(traversal2))

        val traversal3 = "/var/log/quarry/data.pdf"
        assertEquals("data.pdf", ContentDispositionParser.sanitizeFilename(traversal3))
    }

    @Test
    fun sanitizeFilename_neutralizesIllegalFilesystemCharsWhilePreservingArabic() {
        val raw = "رخصة : المحجر * 2026? <معتمد> | نهائي.pdf"
        val sanitized = ContentDispositionParser.sanitizeFilename(raw)
        // Illegal characters: : * ? < > | must be replaced with _
        assertFalse(sanitized.contains(':'))
        assertFalse(sanitized.contains('*'))
        assertFalse(sanitized.contains('?'))
        assertFalse(sanitized.contains('<'))
        assertFalse(sanitized.contains('>'))
        assertFalse(sanitized.contains('|'))
        // Arabic characters and spaces must be completely preserved
        assertTrue(sanitized.contains("رخصة"))
        assertTrue(sanitized.contains("المحجر"))
        assertTrue(sanitized.contains("معتمد"))
        assertTrue(sanitized.contains("نهائي"))
        assertTrue(sanitized.endsWith(".pdf"))
    }

    @Test
    fun parseFilename_handlesArabicWithParenthesesAndArabicNumerals() {
        // Arabic-Indic numeral ١ is encoded as %D9%A1
        val header = """attachment; filename="document.pdf"; filename*=UTF-8''%D8%B1%D8%AE%D8%B5%D8%A9%20%D8%A7%D9%84%D9%85%D8%AD%D8%AC%D8%B1%20%28%D9%A1%29.pdf"""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("رخصة المحجر (١).pdf", filename)
    }

    @Test
    fun parseFilename_handlesPercentSignAndApostrophe() {
        // % is %25, ' is %27
        val header = """attachment; filename="document.pdf"; filename*=UTF-8''%D8%B9%D9%82%D8%AF%20100%25%20%27%D8%AE%D8%A7%D8%B5%27%20%D8%A7%D9%84%D9%85%D8%AD%D8%AC%D8%B1.pdf"""
        val filename = ContentDispositionParser.parseFilename(header)
        assertEquals("عقد 100% 'خاص' المحجر.pdf", filename)
    }

    @Test
    fun saveDocumentToCache_preservesArabicWithParenthesesAndNumeralsInSaveAndOpenFlow() {
        val targetCacheDir = tempFolder.newFolder("fake_cache_parens")
        val arabicDoc = Document(
            id = "doc-ar-parens",
            quarryId = "q-1",
            displayName = "رخصة المحجر (١)",
            originalFilename = "رخصة المحجر (١).pdf",
            mimeType = "application/pdf",
            sizeBytes = 2048L,
            status = "available",
            createdAt = "2026-10-29T00:00:00Z"
        )

        val docsDir = File(targetCacheDir, "documents").apply { mkdirs() }
        val rawName = arabicDoc.originalFilename.ifBlank { arabicDoc.displayName }
        val safeName = ContentDispositionParser.sanitizeFilename(rawName, fallback = "document.pdf")
        val file = File(docsDir, safeName)
        file.writeBytes("SAMPLE-PDF-BYTES".toByteArray())

        assertTrue(file.exists())
        assertEquals("رخصة المحجر (١).pdf", file.name)
        assertEquals("pdf", file.extension)
    }

    @Test
    fun saveDocumentToCache_preservesArabicFilenameWithoutUnderscoreMangle() {
        val targetCacheDir = tempFolder.newFolder("fake_cache")
        // Create a dummy Context-like mock or call directly with directory
        val arabicDoc = Document(
            id = "doc-ar-1",
            quarryId = "q-1",
            displayName = "رخصة تشغيل المحجر",
            originalFilename = "رخصة المحجر.pdf",
            mimeType = "application/pdf",
            sizeBytes = 1024L,
            status = "available",
            createdAt = "2026-10-29T00:00:00Z"
        )

        val docsDir = File(targetCacheDir, "documents").apply { mkdirs() }
        val rawName = arabicDoc.originalFilename.ifBlank { arabicDoc.displayName }
        val safeName = ContentDispositionParser.sanitizeFilename(rawName, fallback = "document.pdf")
        val file = File(docsDir, safeName)
        file.writeBytes("PDF-CONTENT".toByteArray())

        assertTrue(file.exists())
        assertEquals("رخصة المحجر.pdf", file.name)
        // Must NOT be mangled to '_____________.pdf'
        assertFalse(file.name.startsWith("___"))
    }
}
