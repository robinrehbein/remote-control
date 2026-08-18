package com.pocketagent.app

import com.pocketagent.app.data.PairingApi
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

class PairingFailureMessageTest {

    // Fund: Beim Koppeln stand nur die rohe OkHttp-Meldung „Failed to connect
    // to host/ip:443“ auf dem Screen — ohne Hinweis, ob URL, Handy-Netz oder
    // Server schuld sind. describeNetworkFailure übersetzt die Exception in
    // eine Meldung mit konkretem nächsten Schritt (Browser-Test auf
    // /api/health).

    @Test
    fun `dns failure names the url and private dns as suspects`() {
        val msg = PairingApi.describeNetworkFailure(UnknownHostException("pocketagent.example.com"), "https://pocketagent.example.com")
        assertTrue(msg, "DNS" in msg)
        assertTrue(msg, "privates DNS" in msg)
    }

    @Test
    fun `tls failure points at the certificate, also when nested as cause`() {
        val nested = IOException("wrapper", SSLHandshakeException("chain validation failed"))
        val msg = PairingApi.describeNetworkFailure(nested, "https://orch.example.com")
        assertTrue(msg, "Zertifikat" in msg)
        assertTrue(msg, "https://orch.example.com/api/health" in msg)
    }

    @Test
    fun `connect failure suggests the browser test against the health endpoint`() {
        val error = ConnectException("Failed to connect to pocketagent.example.com/188.245.45.58:443")
        val msg = PairingApi.describeNetworkFailure(error, "https://pocketagent.example.com/")
        // Kein doppelter Slash, obwohl die Basis mit "/" endet.
        assertTrue(msg, "https://pocketagent.example.com/api/health" in msg)
        assertTrue(msg, "VPN" in msg)
    }

    @Test
    fun `retry only when the request can not have reached the server`() {
        // Sicher: Der TCP-Connect kam nie zustande, der Code ist unverbraucht.
        assertTrue(PairingApi.failedBeforeSend(ConnectException("connection refused")))
        assertTrue(PairingApi.failedBeforeSend(UnknownHostException("host")))
        assertTrue(PairingApi.failedBeforeSend(SocketTimeoutException("connect timed out")))
        assertTrue(PairingApi.failedBeforeSend(IOException("wrapper", ConnectException("refused"))))

        // Unsicher: Der Server könnte den Pairing-Code schon konsumiert haben —
        // ein Retry würde dann fälschlich „invalid or expired code“ melden.
        assertFalse(PairingApi.failedBeforeSend(SocketTimeoutException("read timed out")))
        assertFalse(PairingApi.failedBeforeSend(SocketTimeoutException("timeout")))
        assertFalse(PairingApi.failedBeforeSend(IOException("unexpected end of stream")))
    }

    @Test
    fun `cause cycles do not hang the classifier`() {
        val a = IOException("a")
        val b = IOException("b", a)
        a.initCause(b)
        // Darf nicht endlos laufen; Klassifikation fällt auf den Standardfall.
        val msg = PairingApi.describeNetworkFailure(b, "https://x.example")
        assertTrue(msg, "https://x.example/api/health" in msg)
    }
}
