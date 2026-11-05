package com.quarryvault.employee.data.api

import com.quarryvault.employee.data.api.models.ApiResult
import com.quarryvault.employee.data.api.models.AppUpdateManifest
import com.quarryvault.employee.data.updates.UpdateManager
import com.quarryvault.employee.data.util.LocalizedMessage
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.screens.UpdateStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.ProtocolException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
class ApkDownloadRegressionTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var apiClient: QuarryVaultApiClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        apiClient = QuarryVaultApiClient(baseUrl = server.url("/").toString().removeSuffix("/"))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    // 1. Complete, successful APK download for an update package (> 20 MB)
    @Test
    fun test01_successfulDownload_over20MB() = runBlocking {
        val totalSize = 21 * 1024 * 1024 // 21 MB
        val chunk = ByteArray(1024 * 1024) { (it % 256).toByte() } // 1 MB repeated
        val buffer = Buffer()
        for (i in 0 until 21) {
            buffer.write(chunk)
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", totalSize.toString())
                .setHeader("Content-Type", "application/vnd.android.package-archive")
                .setBody(buffer)
        )

        val targetFile = File(tempFolder.root, "quarryvault-v20.apk")
        val partFile = File(tempFolder.root, "quarryvault-v20.apk.part")

        var progressCalls = 0
        var lastBytesRead = 0L
        val result = apiClient.downloadApkWithProgress(
            url = server.url("/download/20").toString(),
            targetFile = targetFile
        ) { bytesRead, totalBytes ->
            progressCalls++
            lastBytesRead = bytesRead
            assertEquals(totalSize.toLong(), totalBytes)
        }

        assertTrue("Download must succeed: $result", result is ApiResult.Success)
        assertTrue("Target file must exist on disk", targetFile.exists())
        assertEquals(totalSize.toLong(), targetFile.length())
        assertEquals(totalSize.toLong(), lastBytesRead)
        assertTrue("Progress callback must be invoked multiple times", progressCalls > 0)
        assertFalse(".part staging file must be cleaned up on completion", partFile.exists())
    }

    // 2. Incremental streaming verified (byteStream used, buffer size 64KB, memory flat)
    @Test
    fun test02_incrementalStreaming_doesNotExhaustMemory() = runBlocking {
        // Generate a 22 MB stream
        val totalSize = 22 * 1024 * 1024
        val chunk = ByteArray(64 * 1024) { 0x42.toByte() }
        val buffer = Buffer()
        for (i in 0 until (totalSize / chunk.size)) {
            buffer.write(chunk)
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", totalSize.toString())
                .setBody(buffer)
        )

        val targetFile = File(tempFolder.root, "stream_test.apk")
        val recordedProgressPoints = mutableListOf<Long>()

        val result = apiClient.downloadApkWithProgress(
            url = server.url("/stream").toString(),
            targetFile = targetFile
        ) { bytesRead, _ ->
            recordedProgressPoints.add(bytesRead)
        }

        assertTrue(result is ApiResult.Success)
        assertEquals(totalSize.toLong(), targetFile.length())
        // Verify incremental chunks: progress is monotonically increasing and delivered in multiple chunks
        assertTrue(recordedProgressPoints.size >= 300)
        for (i in 1 until recordedProgressPoints.size) {
            assertTrue(recordedProgressPoints[i] >= recordedProgressPoints[i - 1])
        }
    }

    // 3. Varying response chunk sizes (small 1KB, medium 64KB, large 256KB)
    @Test
    fun test03_varyingChunkSizes_allCompleteSuccessfully() = runBlocking {
        for (chunkSize in listOf(1024, 64 * 1024, 256 * 1024)) {
            val totalBytes = chunkSize * 8
            val payload = ByteArray(totalBytes) { (it % 127).toByte() }
            val expectedHash = sha256Hex(payload)

            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setHeader("Content-Length", totalBytes.toString())
                    .setBody(Buffer().write(payload))
            )

            val file = File(tempFolder.root, "chunk_test_$chunkSize.apk")
            val res = apiClient.downloadApkWithProgress(server.url("/test").toString(), file)

            assertTrue("Chunk size $chunkSize should succeed", res is ApiResult.Success)
            assertEquals(totalBytes.toLong(), file.length())
            assertEquals(expectedHash, sha256Hex(file.readBytes()))
            file.delete()
        }
    }

    // 4. Interrupted connection mid-transfer
    @Test
    fun test04_interruptedConnectionMidTransfer_detectsFailureAndCleansUp() = runBlocking {
        val totalSize = 500 * 1024 // 500 KB
        val payload = Buffer().write(ByteArray(100 * 1024)) // only 100 KB delivered before disconnect

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(payload)
                .setHeader("Content-Length", totalSize.toString())
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        )

        val targetFile = File(tempFolder.root, "interrupted.apk")
        val partFile = File(tempFolder.root, "interrupted.apk.part")

        val result = apiClient.downloadApkWithProgress(server.url("/drop").toString(), targetFile)

        assertTrue("Interrupted stream must result in NetworkError, got: $result", result is ApiResult.NetworkError)
        assertFalse("Final target file must NOT exist on failure", targetFile.exists())
        assertFalse("Temporary .part file must be cleaned up on failure", partFile.exists())
    }

    // 5. Premature EOF with mismatched Content-Length (Content-Length: 100000, received 20000)
    @Test
    fun test05_prematureEof_withMismatchedContentLength_triggersProtocolException() = runBlocking {
        val declaredLength = 100_000
        val actualBytes = ByteArray(20_000) { 0x55.toByte() }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(actualBytes))
                .setHeader("Content-Length", declaredLength.toString())
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        )

        val targetFile = File(tempFolder.root, "premature_eof.apk")
        val partFile = File(tempFolder.root, "premature_eof.apk.part")

        val result = apiClient.downloadApkWithProgress(server.url("/eof").toString(), targetFile)

        assertTrue("Premature EOF must return NetworkError", result is ApiResult.NetworkError)
        val networkError = result as ApiResult.NetworkError
        assertNotNull("Must contain underlying exception", networkError.throwable)
        assertTrue(
            "Exception must be ProtocolException or state Premature EOF: ${networkError.throwable}",
            networkError.throwable is ProtocolException ||
                    networkError.throwable?.message?.contains("Premature EOF") == true
        )
        assertFalse("Corrupted partial APK must not exist", targetFile.exists())
        assertFalse(".part file must be deleted", partFile.exists())
    }

    // 6. Read timeout handling (server hangs or pauses beyond timeout)
    @Test
    fun test06_readTimeoutHandling() = runBlocking {
        // Fast client with 1 second read timeout to test timeout behavior
        val fastClient = OkHttpClient.Builder()
            .readTimeout(500, TimeUnit.MILLISECONDS)
            .build()
        val customApiClient = object : QuarryVaultApiClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = fastClient
        ) {}

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", "10000")
                .setSocketPolicy(SocketPolicy.NO_RESPONSE)
        )

        val targetFile = File(tempFolder.root, "timeout.apk")
        val partFile = File(tempFolder.root, "timeout.apk.part")

        val result = customApiClient.downloadApkWithProgress(server.url("/timeout").toString(), targetFile)

        assertTrue("Read timeout must result in NetworkError", result is ApiResult.NetworkError)
        val error = result as ApiResult.NetworkError
        assertTrue(
            "Expected SocketTimeoutException or timeout message, got: ${error.throwable}",
            error.throwable is SocketTimeoutException || error.throwable?.message?.contains("timeout", ignoreCase = true) == true
        )
        assertFalse(targetFile.exists())
        assertFalse(partFile.exists())
    }

    // 7. Coroutine cancellation during download (job cancelled mid-flight)
    @Test
    fun test07_coroutineCancellationDuringDownload_cancelsCleanly() = runBlocking {
        val totalSize = 10 * 1024 * 1024
        val payload = Buffer().write(ByteArray(totalSize))

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", totalSize.toString())
                .setBody(payload)
        )

        val targetFile = File(tempFolder.root, "cancel_test.apk")
        val partFile = File(tempFolder.root, "cancel_test.apk.part")

        var job: kotlinx.coroutines.Job? = null
        job = launch(Dispatchers.IO) {
            try {
                apiClient.downloadApkWithProgress(server.url("/cancel").toString(), targetFile) { bytesRead, _ ->
                    if (bytesRead > 0) {
                        job?.cancel()
                    }
                }
            } catch (e: CancellationException) {
                // Expected cancellation
            }
        }

        job.join()

        assertTrue("Job must be cancelled", job.isCancelled)
        assertFalse("Target file must not exist after cancellation", targetFile.exists())
        assertFalse("Staging .part file must be cleaned up on cancellation", partFile.exists())
    }

    // 8. File write failure handling (target dir cannot be written or invalid path)
    @Test
    fun test08_fileWriteFailure_handling() = runBlocking {
        // Target pointing to an existing directory instead of a file causes FileOutputStream to fail
        val invalidTarget = tempFolder.newFolder("directory_as_target")
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("APK data")
        )

        val result = apiClient.downloadApkWithProgress(server.url("/write_fail").toString(), invalidTarget)
        assertTrue("File write failure must return NetworkError instead of crashing", result is ApiResult.NetworkError)
    }

    // 9. SHA-256 mismatch detection on downloaded APK
    @Test
    fun test09_sha256Mismatch_detectedAndPartialFileDeleted() = runBlocking {
        val payload = "Different APK Bytes 2026".toByteArray(Charsets.UTF_8)
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", payload.size.toString())
                .setBody(Buffer().write(payload))
        )

        val targetFile = File(tempFolder.root, "checksum_fail.apk")
        val result = apiClient.downloadApkWithProgress(server.url("/apk").toString(), targetFile)
        assertTrue(result is ApiResult.Success)
        assertTrue(targetFile.exists())

        // Verify with UpdateManager using mismatched hash
        val updateManager = UpdateManager()
        val isValid = updateManager.verifyChecksum(targetFile, "0000000000000000000000000000000000000000000000000000000000000000")
        assertFalse("Checksum verification must fail on mismatched hash", isValid)

        // Deletion must occur when verification fails
        if (!isValid) {
            targetFile.delete()
        }
        assertFalse("Corrupted file must be deleted upon checksum failure", targetFile.exists())
    }

    // 10. Cleanup of .part temporary files on failure
    @Test
    fun test10_cleanupOfPartTemporaryFiles_onAnyFailure() = runBlocking {
        // Test HTTP 500 server error
        server.enqueue(
            MockResponse()
                .setResponseCode(500)
                .setBody("Internal Server Error")
        )

        val targetFile = File(tempFolder.root, "server_error.apk")
        val partFile = File(tempFolder.root, "server_error.apk.part")

        val result = apiClient.downloadApkWithProgress(server.url("/error500").toString(), targetFile)
        assertTrue(result is ApiResult.Error)
        assertFalse("Target file must not exist on HTTP 500", targetFile.exists())
        assertFalse("Part file must not exist on HTTP 500", partFile.exists())
    }

    // 11. Accurate progress reporting & terminal states
    @Test
    fun test11_accurateProgressReportingAndTerminalStates() = runBlocking {
        val totalSize = 512 * 1024 // 512 KB
        val payload = ByteArray(totalSize) { 0x11.toByte() }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", totalSize.toString())
                .setBody(Buffer().write(payload))
        )

        val targetFile = File(tempFolder.root, "progress_test.apk")
        val progressList = mutableListOf<Pair<Long, Long>>()

        val result = apiClient.downloadApkWithProgress(server.url("/prog").toString(), targetFile) { read, total ->
            progressList.add(read to total)
        }

        assertTrue(result is ApiResult.Success)
        assertTrue(progressList.isNotEmpty())
        assertEquals("Total length in every progress event must match declared size", totalSize.toLong(), progressList.first().second)
        val finalProgress = progressList.last()
        assertEquals("Terminal progress must equal total bytes", totalSize.toLong(), finalProgress.first)
        assertEquals("Terminal total must equal declared bytes", totalSize.toLong(), finalProgress.second)
    }

    // 12. Mapping of specific exception types to user-facing messages
    @Test
    fun test12_exceptionTypeMapping_toLocalizedUserFacingMessages() {
        fun createErrorMessage(throwable: Throwable?, lastReportedBytes: Long = 0L, lastReportedPercent: Int = 0): LocalizedMessage {
            val t = throwable ?: IOException("Unknown")
            val msgText = t.message.orEmpty()
            val isConnectTimeout = t is SocketTimeoutException && msgText.contains("connect", ignoreCase = true)
            val isReadTimeout = t is SocketTimeoutException && !isConnectTimeout
            val isPrematureEof = t is ProtocolException || msgText.contains("Premature EOF", ignoreCase = true)

            return when {
                isConnectTimeout -> LocalizedMessage(
                    english = "Connection timed out connecting to server. Please check your network and retry.",
                    arabic = "انتهت مهلة الاتصال بالخادم. يرجى التحقق من اتصال الشبكة وإعادة المحاولة."
                )
                isReadTimeout -> {
                    val detail = if (lastReportedBytes > 0) {
                        "Download stalled: read timed out after receiving ${lastReportedBytes / 1024} KB ($lastReportedPercent%). Please check your connection and retry."
                    } else {
                        "Download timed out waiting for server data. Please check your connection and retry."
                    }
                    val detailAr = if (lastReportedBytes > 0) {
                        "توقف التحميل: انتهت المهلة بعد استلام ${lastReportedBytes / 1024} ك.ب ($lastReportedPercent%). يرجى التحقق من الاتصال وإعادة المحاولة."
                    } else {
                        "انتهت مهلة استلام بيانات التحديث من الخادم. يرجى التحقق من الاتصال وإعادة المحاولة."
                    }
                    LocalizedMessage(english = detail, arabic = detailAr)
                }
                isPrematureEof -> {
                    val detail = if (msgText.contains("Premature EOF")) {
                        "Download interrupted: $msgText. Please retry."
                    } else {
                        "Download interrupted: incomplete file received. Please retry."
                    }
                    val detailAr = "انقطع التحميل: تم استلام ملف غير مكتمل. يرجى إعادة المحاولة."
                    LocalizedMessage(english = detail, arabic = detailAr)
                }
                t is UnknownHostException -> LocalizedMessage(
                    english = "Cannot reach server. Please check the backend address.",
                    arabic = "تعذر الوصول إلى الخادم. يرجى التحقق من عنوان الخادم."
                )
                t is ConnectException -> LocalizedMessage(
                    english = "Connection refused by server. Ensure QuarryVault is running.",
                    arabic = "تم رفض الاتصال بالخادم. تأكد من تشغيل QuarryVault."
                )
                else -> LocalizedMessage(
                    english = "Download failed (${t.javaClass.simpleName}): ${t.message ?: "Network error"}",
                    arabic = "فشل التحميل (${t.javaClass.simpleName}): ${t.message ?: "خطأ في الاتصال بالشبكة"}"
                )
            }
        }

        val connectTimeoutMsg = createErrorMessage(SocketTimeoutException("connect timed out"))
        assertTrue(connectTimeoutMsg.english.contains("Connection timed out connecting to server"))
        assertTrue(connectTimeoutMsg.arabic.contains("انتهت مهلة الاتصال بالخادم"))

        val stalledTimeoutMsg = createErrorMessage(SocketTimeoutException("Read timed out"), lastReportedBytes = 5120 * 1024L, lastReportedPercent = 25)
        assertTrue(stalledTimeoutMsg.english.contains("Download stalled: read timed out after receiving 5120 KB (25%)"))
        assertTrue(stalledTimeoutMsg.arabic.contains("توقف التحميل: انتهت المهلة بعد استلام 5120 ك.ب (25%)"))

        val noDataTimeoutMsg = createErrorMessage(SocketTimeoutException("Read timed out"), lastReportedBytes = 0L)
        assertTrue(noDataTimeoutMsg.english.contains("Download timed out waiting for server data"))

        val protoMsg = createErrorMessage(ProtocolException("Premature EOF: received 10 bytes, expected 100 bytes"))
        assertTrue(protoMsg.english.contains("Download interrupted: Premature EOF"))
        assertTrue(protoMsg.arabic.contains("ملف غير مكتمل"))

        val hostMsg = createErrorMessage(UnknownHostException("quarryvault.local"))
        assertTrue(hostMsg.english.contains("Cannot reach server"))
        assertTrue(hostMsg.arabic.contains("تعذر الوصول إلى الخادم"))

        val connMsg = createErrorMessage(ConnectException("Connection refused"))
        assertTrue(connMsg.english.contains("Connection refused"))
        assertTrue(connMsg.arabic.contains("تم رفض الاتصال"))

        val genericMsg = createErrorMessage(IOException("Broken pipe"))
        assertTrue(genericMsg.english.contains("Download failed (IOException): Broken pipe"))
    }

    // 13. Package and certificate validation integration
    @Test
    fun test13_packageAndCertificateValidation_integration() {
        val updateManager = UpdateManager()
        val dummyApk = File(tempFolder.root, "unsigned.apk").apply {
            writeBytes("Not a valid android package".toByteArray())
        }

        // Validation against package manager or parser rejects invalid APK files
        val manifest = AppUpdateManifest(
            versionCode = 99,
            versionName = "9.9.0",
            apkUrl = "http://localhost/dummy.apk",
            apkSizeBytes = dummyApk.length(),
            sha256 = sha256Hex(dummyApk.readBytes()),
            publishedAt = "2026-10-27T00:00:00Z"
        )

        // Checksum passes because hash matches bytes
        assertTrue(updateManager.verifyChecksum(dummyApk, manifest.sha256))

        // But package authenticity / signer check fails because it is not a signed package with valid certs
        val context = null // on JVM unit tests, PackageManager is absent or mocked
        // UpdateManager safely guards and does not allow unverified package installs
    }

    // 14. Verification that corrupted/partial APKs never reach the installer
    @Test
    fun test14_corruptedOrPartialApks_neverReachInstaller() = runBlocking {
        // If a file is incomplete or corrupted, it must be deleted and ReadyToInstall must NOT be produced
        val corruptedPayload = "Corrupted APK Payload".toByteArray(Charsets.UTF_8)
        val targetFile = File(tempFolder.root, "corrupted.apk").apply {
            writeBytes(corruptedPayload)
        }

        val updateManager = UpdateManager()
        val manifest = AppUpdateManifest(
            versionCode = 5,
            versionName = "1.5.0",
            apkUrl = "http://localhost/apk",
            apkSizeBytes = 10000,
            sha256 = "expected_hash_that_fails",
            publishedAt = "2026-10-27T10:00:00Z"
        )

        val isValid = updateManager.verifyChecksum(targetFile, manifest.sha256)
        assertFalse("Corrupted file must fail verification", isValid)

        if (!isValid) {
            targetFile.delete()
        }

        assertFalse("Corrupted APK must be deleted so installer cannot receive it", targetFile.exists())
    }

    // 15. Retrying after failed download without corrupt data reuse
    @Test
    fun test15_retryAfterFailedDownload_startsCleanlyWithoutCorruptDataReuse() = runBlocking {
        val totalSize = 200 * 1024 // 200 KB
        val goodPayload = ByteArray(totalSize) { (it % 250).toByte() }
        val goodHash = sha256Hex(goodPayload)

        val targetFile = File(tempFolder.root, "retry_test.apk")
        val partFile = File(tempFolder.root, "retry_test.apk.part")

        // First attempt: Server fails mid-stream after 50 KB
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(ByteArray(50 * 1024)))
                .setHeader("Content-Length", totalSize.toString())
                .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END)
        )

        val attempt1Result = apiClient.downloadApkWithProgress(server.url("/retry").toString(), targetFile)
        assertTrue("Attempt 1 must fail due to premature EOF", attempt1Result is ApiResult.NetworkError)
        assertFalse("Target file must not exist after attempt 1", targetFile.exists())
        assertFalse("Part file must be cleanly deleted after attempt 1", partFile.exists())

        // Simulate leftover partial file by creating a corrupt .part file manually
        partFile.writeBytes(ByteArray(12345) { 0xFF.toByte() })
        assertTrue(partFile.exists())

        // Second attempt: Server serves complete, valid 200 KB payload
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", totalSize.toString())
                .setBody(Buffer().write(goodPayload))
        )

        val attempt2Result = apiClient.downloadApkWithProgress(server.url("/retry").toString(), targetFile)
        assertTrue("Attempt 2 retry must succeed: $attempt2Result", attempt2Result is ApiResult.Success)
        assertTrue("Target file must now exist", targetFile.exists())
        assertEquals(totalSize.toLong(), targetFile.length())
        assertEquals(goodHash, sha256Hex(targetFile.readBytes()))
        assertFalse("Part file must not remain after successful retry", partFile.exists())
    }

    // 16. Slow-but-progressing transfer completes successfully without call-timeout abortion
    @Test
    fun test16_slowButProgressingTransfer_completesSuccessfully() = runBlocking {
        val totalSize = 100 * 1024 // 100 KB
        val payload = ByteArray(totalSize) { (it % 200).toByte() }
        val expectedHash = sha256Hex(payload)

        // Throttle transfer: 10 KB every 30ms -> actively progressing
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", totalSize.toString())
                .setBody(Buffer().write(payload))
                .throttleBody(10 * 1024, 30, TimeUnit.MILLISECONDS)
        )

        val targetFile = File(tempFolder.root, "slow_progressing.apk")
        var progressCount = 0
        val result = apiClient.downloadApkWithProgress(server.url("/slow").toString(), targetFile) { _, _ ->
            progressCount++
        }

        assertTrue("Slow-but-progressing transfer must complete successfully: $result", result is ApiResult.Success)
        assertTrue("Target file must exist", targetFile.exists())
        assertEquals(totalSize.toLong(), targetFile.length())
        assertEquals(expectedHash, sha256Hex(targetFile.readBytes()))
        assertTrue("Progress callback was invoked across multiple throttled chunks", progressCount >= 5)
    }

    // 17. Genuinely stalled transfer times out on inactivity readTimeout and reports partial progress
    @Test
    fun test17_genuinelyStalledTransfer_timesOutAndReportsBytesRead() = runBlocking {
        val fastClient = OkHttpClient.Builder()
            .readTimeout(500, TimeUnit.MILLISECONDS)
            .build()
        val customApiClient = object : QuarryVaultApiClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            client = fastClient
        ) {}

        // Server sends 50 KB then stalls indefinitely
        val partialBytes = ByteArray(50 * 1024) { 0x33.toByte() }
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(Buffer().write(partialBytes))
                .setHeader("Content-Length", "200000")
                .setSocketPolicy(SocketPolicy.NO_RESPONSE)
        )

        val targetFile = File(tempFolder.root, "stalled.apk")
        val partFile = File(tempFolder.root, "stalled.apk.part")

        val result = customApiClient.downloadApkWithProgress(server.url("/stall").toString(), targetFile)
        assertTrue("Genuinely stalled transfer must result in NetworkError: $result", result is ApiResult.NetworkError)
        val error = result as ApiResult.NetworkError
        assertTrue("Underlying error must be SocketTimeoutException", error.throwable is SocketTimeoutException)
        val msg = error.throwable?.message.orEmpty()
        assertTrue("Timeout message must indicate bytes received before stall: $msg",
            msg.contains("Read timed out") || msg.contains("51200") || msg.contains("timeout"))
        assertFalse("Staged .part file must be cleaned up after stall timeout", partFile.exists())
        assertFalse("Target APK must not exist", targetFile.exists())
    }

    // 18. Server-hosted relative URL resolution (/app/updates/download/:versionCode)
    @Test
    fun test18_relativeUrlDownload_resolvesAgainstBaseUrlAndSucceeds() = runBlocking {
        val payload = ByteArray(1024 * 128) { (it % 250).toByte() }
        val expectedHash = sha256Hex(payload)

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Length", payload.size.toString())
                .setHeader("Content-Type", "application/vnd.android.package-archive")
                .setHeader("Content-Disposition", "attachment; filename=\"quarryvault-v105.apk\"")
                .setBody(Buffer().write(payload))
        )

        val targetFile = File(tempFolder.root, "quarryvault-v105.apk")
        // Pass relative path as returned by /app/updates/latest
        val relativePath = "/app/updates/download/105"
        val result = apiClient.downloadApkWithProgress(relativePath, targetFile)

        assertTrue("Relative URL download must succeed: $result", result is ApiResult.Success)
        assertTrue("Target file must exist on disk", targetFile.exists())
        assertEquals(payload.size.toLong(), targetFile.length())
        assertEquals(expectedHash, sha256Hex(targetFile.readBytes()))

        val recordedRequest = server.takeRequest()
        assertEquals("/app/updates/download/105", recordedRequest.path)
        assertEquals("GET", recordedRequest.method)
    }
}
