package com.cindro.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostPortTest {

    @Test
    fun parsesIpv4WithPort() {
        val hp = HostPort.parse("192.168.0.47:8796")
        assertEquals(HostPort("192.168.0.47", 8796), hp)
    }

    @Test
    fun parsesTailscaleDefault() {
        val hp = HostPort.parse(PairingStore.DEFAULT_HOST_PORT)
        assertEquals("127.0.0.1", hp?.host)
        assertEquals(8796, hp?.port)
    }

    @Test
    fun trimsWhitespace() {
        assertEquals(HostPort("host.local", 8796), HostPort.parse("  host.local:8796  "))
    }

    @Test
    fun parsesBracketedIpv6() {
        val hp = HostPort.parse("[fe80::1]:8796")
        assertEquals(HostPort("fe80::1", 8796), hp)
    }

    @Test
    fun buildsWsUrl() {
        assertEquals("ws://192.168.0.47:8796/device/ws", HostPort("192.168.0.47", 8796).wsUrl())
    }

    @Test
    fun rejectsMissingPort() {
        assertNull(HostPort.parse("192.168.0.47"))
    }

    @Test
    fun rejectsEmptyPort() {
        assertNull(HostPort.parse("192.168.0.47:"))
    }

    @Test
    fun rejectsNonNumericPort() {
        assertNull(HostPort.parse("host:abc"))
    }

    @Test
    fun rejectsOutOfRangePort() {
        assertNull(HostPort.parse("host:70000"))
        assertNull(HostPort.parse("host:0"))
    }

    @Test
    fun rejectsBlank() {
        assertNull(HostPort.parse(""))
        assertNull(HostPort.parse("   "))
    }
}
