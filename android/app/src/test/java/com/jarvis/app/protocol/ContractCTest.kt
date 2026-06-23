package com.jarvis.app.protocol

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.jarvis.app.net.JarvisRepository
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer

/**
 * Tests for the Wave-5 Contract C surface the full Android app consumes: the binary
 * `mirror.frame` video framing, the `file.offer` push event, and the extended
 * capability-tier table (voice / settings.set / mcp.add / take_over / mirror).
 */
class ContractCTest {

    private fun obj(json: String) = JsonParser.parseString(json).asJsonObject

    /** Build a binary frame the same way DeviceServer::emitMirrorFrame does. */
    private fun frameBytes(header: JsonObject, jpeg: ByteArray): ByteArray {
        val hdr = header.toString().toByteArray(Charsets.UTF_8)
        val out = ByteBuffer.allocate(4 + hdr.size + jpeg.size)
        out.putInt(hdr.size)
        out.put(hdr)
        out.put(jpeg)
        return out.array()
    }

    @Test
    fun decodesBinaryMirrorFrame() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3, 0xFF.toByte(), 0xD9.toByte())
        val header = JsonObject().apply {
            addProperty("t", "mirror.frame")
            addProperty("session_id", "sess9")
            addProperty("ts", 1234567L)
            addProperty("len", jpeg.size)
        }
        val frame = MirrorFrame.parse(frameBytes(header, jpeg))!!
        assertEquals("sess9", frame.sessionId)
        assertEquals(1234567L, frame.ts)
        assertArrayEquals(jpeg, frame.jpeg)
    }

    @Test
    fun rejectsNonMirrorBinary() {
        val header = JsonObject().apply { addProperty("t", "something.else") }
        assertNull(MirrorFrame.parse(frameBytes(header, byteArrayOf(1, 2))))
        assertNull(MirrorFrame.parse(byteArrayOf(0, 1))) // too short for the length prefix
    }

    @Test
    fun decodesFileOfferEvent() {
        val frame = obj(
            """{"v":1,"event":"file.offer","data":{"id":"f1","name":"report.pdf",
               "mime":"application/pdf","size":2048,"session_id":"s","b64":"AAAA"}}""",
        )
        val fo = FileOfferEvent.from(frame)!!
        assertEquals("f1", fo.offer.id)
        assertEquals("report.pdf", fo.offer.name)
        assertEquals("application/pdf", fo.offer.mime)
        assertEquals(2048L, fo.offer.size)
        assertEquals("AAAA", fo.offer.b64)
    }

    @Test
    fun fileOfferIgnoresOtherEvents() {
        assertNull(FileOfferEvent.from(obj("""{"v":1,"event":"session.event","data":{}}""")))
    }

    @Test
    fun parsesModelList() {
        val m = ModelInfo.from(obj("""{"id":"mistral-large-latest","label":"Mistral Large","brain":"api"}"""))
        assertEquals("mistral-large-latest", m.id)
        assertEquals("Mistral Large", m.display)
    }

    @Test
    fun parsesMcpServer() {
        val s = McpServer.from(obj("""{"name":"desktop-use","url":"http://x/mcp","enabled":true}"""))
        assertEquals("desktop-use", s.name)
        assertEquals("http://x/mcp", s.url)
        assertTrue(s.enabled)
    }

    @Test
    fun parsesSkill() {
        val sk = Skill.from(obj("""{"name":"deploy","description":"ship it","tags":["ops","ci"]}"""))
        assertEquals("deploy", sk.name)
        assertEquals(listOf("ops", "ci"), sk.tags)
    }

    @Test
    fun extendedTierMapping() {
        // reads
        assertEquals(Tier.READ, JarvisRepository.tierOf("settings.get"))
        assertEquals(Tier.READ, JarvisRepository.tierOf("model.list"))
        assertEquals(Tier.READ, JarvisRepository.tierOf("skills.today"))
        // actions
        assertEquals(Tier.ACTION, JarvisRepository.tierOf("voice.stt"))
        assertEquals(Tier.ACTION, JarvisRepository.tierOf("voice.tts"))
        assertEquals(Tier.ACTION, JarvisRepository.tierOf("input.event"))
        // biometric
        assertEquals(Tier.BIOMETRIC, JarvisRepository.tierOf("settings.set"))
        assertEquals(Tier.BIOMETRIC, JarvisRepository.tierOf("mcp.add"))
        assertEquals(Tier.BIOMETRIC, JarvisRepository.tierOf("take_over.request"))
        assertEquals(Tier.BIOMETRIC, JarvisRepository.tierOf("mirror.start"))
    }
}
