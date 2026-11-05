package com.quarryvault.employee.updates

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.quarryvault.employee.data.updates.UpdateManager
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UpdateInstallerTest {
    @Test
    fun cachedApkCanBeSharedWithAndroidPackageInstaller() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val updateManager = UpdateManager()
        val apkFile = File(updateManager.getUpdatesDir(context), "update-provider-test.apk")
        apkFile.writeBytes(byteArrayOf(0x50, 0x4b, 0x03, 0x04))

        try {
            val intent = updateManager.createInstallIntent(context, apkFile)

            assertEquals(Intent.ACTION_VIEW, intent.action)
            assertEquals("application/vnd.android.package-archive", intent.type)
            assertEquals("content", intent.data?.scheme)
            assertNotNull(intent.data)
            assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        } finally {
            apkFile.delete()
        }
    }
}