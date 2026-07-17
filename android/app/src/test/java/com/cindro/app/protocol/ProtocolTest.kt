package com.cindro.app.protocol

import com.google.gson.JsonParser
import com.cindro.app.net.JarvisRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the Contract A/C wire decoding and capability-tier mapping. These
 * exercise the same shapes the daemon emits (see core/include/jarvis/Protocol.h).
 */
class ProtocolTest {

    private fun obj(json: String) = JsonParser.parseString(json).asJsonObject

    @Test
    fun decodesSuccessResponse() {
        val resp = WsResponse.from(
            obj("""{"v":1,"id":7,"ok":true,"result":{"session_id":"abc"}}"""),
        )
        assertNotNull(resp)
        assertEquals(7, resp!!.id)
        assertTrue(resp.ok)
        assertEquals("abc", resp.result!!.get("session_id").asString)
    }

    @Test
    fun decodesErrorResponse() {
        val resp = WsResponse.from(
            obj("""{"v":1,"id":3,"ok":false,"error":{"code":"bad","message":"nope"}}"""),
        )!!
        assertFalse(resp.ok)
        assertEquals("bad", resp.errorCode)
        assertEquals("nope", resp.errorMessage)
    }

    @Test
    fun responseWithExplicitNullResultDoesNotThrow() {
        // {"id":5,"ok":true,"result":null} — JsonNull must not ClassCastException.
        val resp = WsResponse.from(obj("""{"id":5,"ok":true,"result":null}"""))!!
        assertEquals(5, resp.id)
        assertTrue(resp.ok)
        assertNull(resp.result)
    }

    @Test
    fun errorWithNullFieldsDoesNotThrow() {
        // Null error.code / error.message must decode to null, not throw.
        val resp = WsResponse.from(obj("""{"id":5,"ok":false,"error":{"code":null}}"""))!!
        assertFalse(resp.ok)
        assertNull(resp.errorCode)
        assertNull(resp.errorMessage)
    }

    @Test
    fun explicitNullErrorDoesNotThrow() {
        // {"id":5,"ok":true,"error":null} — JsonNull error must not ClassCastException.
        val resp = WsResponse.from(obj("""{"id":5,"ok":true,"error":null}"""))!!
        assertTrue(resp.ok)
        assertNull(resp.errorCode)
    }

    @Test
    fun sessionEventWithNonObjectDataDropped() {
        // A malformed frame with a non-object `data` must be dropped, not crash.
        assertNull(SessionEvent.from(obj("""{"event":"session.event","data":"foo"}""")))
        assertNull(SessionEvent.from(obj("""{"event":"session.event","data":null}""")))
        assertNull(SessionEvent.from(obj("""{"event":"session.event","data":{"session_id":"s","ev":"x"}}""")))
    }

    @Test
    fun responseFromIgnoresEvents() {
        assertNull(
            WsResponse.from(
                obj("""{"v":1,"event":"session.event","data":{"session_id":"s","ev":{"kind":"final"}}}"""),
            ),
        )
    }

    @Test
    fun decodesSessionEvent() {
        val frame = obj(
            """{"v":1,"event":"session.event","data":{"session_id":"sess1",
               "ev":{"kind":"message","role":"assistant","text":"hi"}}}""",
        )
        val se = SessionEvent.from(frame)!!
        assertEquals("sess1", se.sessionId)
        assertEquals("message", se.event.kind)
        assertEquals("assistant", se.event.role)
        assertEquals("hi", se.event.text)
    }

    @Test
    fun toolCallEventExposesArgs() {
        val frame = obj(
            """{"v":1,"event":"session.event","data":{"session_id":"s",
               "ev":{"kind":"tool_call","call_id":"c1","name":"shell","args":{"cmd":"ls"}}}}""",
        )
        val ev = SessionEvent.from(frame)!!.event
        assertEquals("tool_call", ev.kind)
        assertEquals("c1", ev.callId)
        assertEquals("shell", ev.name)
        assertTrue(ev.argsJson!!.contains("\"cmd\""))
    }

    @Test
    fun approvalEventFields() {
        val frame = obj(
            """{"v":1,"event":"session.event","data":{"session_id":"s",
               "ev":{"kind":"approval","approval_id":"a1","summary":"rm -rf","risk":"high"}}}""",
        )
        val ev = SessionEvent.from(frame)!!.event
        assertEquals("a1", ev.approvalId)
        assertEquals("high", ev.risk)
    }

    @Test
    fun nonEventReturnsNull() {
        assertNull(SessionEvent.from(obj("""{"v":1,"id":1,"ok":true,"result":{}}""")))
    }

    @Test
    fun requestEnvelopeShape() {
        val text = Protocol.request(42, "session.list")
        val o = obj(text)
        assertEquals(1, o.get("v").asInt)
        assertEquals(42, o.get("id").asInt)
        assertEquals("session.list", o.get("method").asString)
        assertTrue(o.has("params"))
    }

    @Test
    fun tierMapping() {
        assertEquals(Tier.READ, JarvisRepository.tierOf("session.list"))
        assertEquals(Tier.READ, JarvisRepository.tierOf("session.history"))
        assertEquals(Tier.ACTION, JarvisRepository.tierOf("session.send"))
        assertEquals(Tier.ACTION, JarvisRepository.tierOf("task.queue"))
        assertEquals(Tier.BIOMETRIC, JarvisRepository.tierOf("approval.respond"))
    }
}
