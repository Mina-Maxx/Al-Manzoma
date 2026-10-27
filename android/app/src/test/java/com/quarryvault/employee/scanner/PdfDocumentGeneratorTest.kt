package com.quarryvault.employee.scanner

import com.quarryvault.employee.data.scanner.PdfDocumentGenerator
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class PdfDocumentGeneratorTest {

    private lateinit var tempDir: File

    @Before
    fun setUp() {
        tempDir = File(System.getProperty("java.io.tmpdir"), "pdf_gen_test_${System.currentTimeMillis()}").apply {
            mkdirs()
        }
    }

    @After
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    @Test
    fun testIsValidPdfHeader_validHeaderReturnsTrue() {
        val validPdf = File(tempDir, "valid.pdf").apply {
            writeBytes("%PDF-1.7\n%some binary content\n".toByteArray(Charsets.US_ASCII))
        }
        assertTrue(PdfDocumentGenerator.isValidPdfHeader(validPdf))
    }

    @Test
    fun testIsValidPdfHeader_emptyFileReturnsFalse() {
        val emptyFile = File(tempDir, "empty.pdf").apply {
            writeBytes(byteArrayOf())
        }
        assertFalse(PdfDocumentGenerator.isValidPdfHeader(emptyFile))
    }

    @Test
    fun testIsValidPdfHeader_truncatedHeaderReturnsFalse() {
        val truncatedFile = File(tempDir, "truncated.pdf").apply {
            writeBytes("%PD".toByteArray(Charsets.US_ASCII))
        }
        assertFalse(PdfDocumentGenerator.isValidPdfHeader(truncatedFile))
    }

    @Test
    fun testIsValidPdfHeader_invalidHeaderReturnsFalse() {
        val nonPdf = File(tempDir, "image.jpg").apply {
            writeBytes(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0x00))
        }
        assertFalse(PdfDocumentGenerator.isValidPdfHeader(nonPdf))

        val textFile = File(tempDir, "plain.txt").apply {
            writeText("Hello World, this is not a PDF")
        }
        assertFalse(PdfDocumentGenerator.isValidPdfHeader(textFile))
    }

    @Test
    fun testIsValidPdfHeader_nonExistentFileReturnsFalse() {
        val missing = File(tempDir, "non_existent.pdf")
        assertFalse(PdfDocumentGenerator.isValidPdfHeader(missing))
    }
}
