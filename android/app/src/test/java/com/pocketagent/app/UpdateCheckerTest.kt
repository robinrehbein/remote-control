package com.pocketagent.app

import com.pocketagent.app.data.UpdateChecker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {

    // Realistischer Ausschnitt aus GET /repos/…/releases/latest — inklusive
    // Feldern, die der Parser nicht kennt (ignoreUnknownKeys).
    private val releaseJson = """
        {
          "url": "https://api.github.com/repos/robinrehbein/remote-control/releases/1",
          "tag_name": "v0.13.0",
          "name": "v0.13.0",
          "draft": false,
          "prerelease": false,
          "published_at": "2026-08-18T09:00:00Z",
          "assets": [
            {
              "name": "pocketagent-v0.13.0.apk",
              "content_type": "application/vnd.android.package-archive",
              "size": 12345678,
              "browser_download_url": "https://github.com/robinrehbein/remote-control/releases/download/v0.13.0/pocketagent-v0.13.0.apk"
            }
          ],
          "body": "## Neu\n- In-App-Updater\n- Kleinere Fixes"
        }
    """.trimIndent()

    @Test
    fun `parses latest release with apk asset`() {
        val info = UpdateChecker.parseLatestRelease(releaseJson)
        assertNotNull(info)
        assertEquals("v0.13.0", info!!.tag)
        assertEquals("pocketagent-v0.13.0.apk", info.apkName)
        assertEquals(
            "https://github.com/robinrehbein/remote-control/releases/download/v0.13.0/pocketagent-v0.13.0.apk",
            info.apkUrl,
        )
        assertEquals(12345678L, info.apkSize)
        assertTrue(info.notes.contains("In-App-Updater"))
    }

    @Test
    fun `picks the apk even when other assets are present`() {
        val json = """
            {
              "tag_name": "v0.13.0",
              "assets": [
                {"name": "checksums.txt", "content_type": "text/plain", "size": 100, "browser_download_url": "https://example.com/checksums.txt"},
                {"name": "pocketagent-v0.13.0.apk", "content_type": "application/vnd.android.package-archive", "size": 5, "browser_download_url": "https://example.com/a.apk"}
              ],
              "body": ""
            }
        """.trimIndent()
        val info = UpdateChecker.parseLatestRelease(json)
        assertEquals("pocketagent-v0.13.0.apk", info?.apkName)
    }

    @Test
    fun `release without apk asset yields null`() {
        val json = """
            {
              "tag_name": "v0.13.0",
              "assets": [
                {"name": "source.zip", "content_type": "application/zip", "size": 1, "browser_download_url": "https://example.com/s.zip"}
              ],
              "body": "nur Quelltext"
            }
        """.trimIndent()
        assertNull(UpdateChecker.parseLatestRelease(json))
        assertNull(UpdateChecker.parseLatestRelease("""{"tag_name": "v1.0.0", "assets": [], "body": ""}"""))
    }

    @Test
    fun `garbage or empty json yields null`() {
        assertNull(UpdateChecker.parseLatestRelease("not json"))
        assertNull(UpdateChecker.parseLatestRelease("""{"message": "Not Found"}"""))
    }

    @Test
    fun `isNewer compares versions segment-wise`() {
        assertTrue(UpdateChecker.isNewer("v0.12.2", "0.12.1"))
        assertFalse(UpdateChecker.isNewer("v0.12.2", "0.12.2"))
        assertFalse(UpdateChecker.isNewer("v0.12.1", "0.12.2"))
        // Unterschiedliche Segmentanzahl: 0.13 zählt als 0.13.0.
        assertTrue(UpdateChecker.isNewer("0.13", "0.12.2"))
        assertFalse(UpdateChecker.isNewer("0.12", "0.12.0"))
        assertTrue(UpdateChecker.isNewer("1.0.0", "0.99.99"))
    }

    @Test
    fun `isNewer is conservative for non-numeric tags`() {
        // Suffixe und kaputte Tags: lieber kein Update anbieten als ein falsches.
        assertFalse(UpdateChecker.isNewer("0.13-rc1", "0.12.2"))
        assertFalse(UpdateChecker.isNewer("v0.13.0", "0.12.2-usercatrust"))
        assertFalse(UpdateChecker.isNewer("latest", "0.12.2"))
        assertFalse(UpdateChecker.isNewer("", "0.12.2"))
        assertFalse(UpdateChecker.isNewer("v0.13.0", ""))
    }
}
