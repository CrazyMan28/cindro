import XCTest
@testable import Cindro

/// Wire-format tests — these pin the Contract A / Contract C encoding the daemon expects,
/// so a drift from the Android/desktop protocol fails here rather than silently on-device.
final class ProtocolTests: XCTestCase {

    func testRequestEncodesEnvelope() throws {
        let text = WireProtocol.request(id: 7, method: "session.list", params: ["limit": 5])
        let obj = try XCTUnwrap(WireProtocol.parse(text))
        XCTAssertEqual(obj.int("v"), 1)
        XCTAssertEqual(obj.int("id"), 7)
        XCTAssertEqual(obj.str("method"), "session.list")
        XCTAssertEqual(obj.obj("params")?.int("limit"), 5)
    }

    func testResponseParsingOKandError() throws {
        let ok = try XCTUnwrap(WsResponse.from(WireProtocol.parse(#"{"v":1,"id":3,"ok":true,"result":{"a":1}}"#)!))
        XCTAssertEqual(ok.id, 3); XCTAssertTrue(ok.ok); XCTAssertEqual(ok.result?.int("a"), 1)

        let err = try XCTUnwrap(WsResponse.from(WireProtocol.parse(#"{"v":1,"id":4,"ok":false,"error":{"code":"x","message":"nope"}}"#)!))
        XCTAssertFalse(err.ok); XCTAssertEqual(err.errorCode, "x"); XCTAssertEqual(err.errorMessage, "nope")
    }

    func testEventFramesAreNotResponses() {
        let ev = WireProtocol.parse(#"{"v":1,"event":"session.event","data":{"session_id":"s1","ev":{"kind":"message","role":"assistant","text":"hi"}}}"#)!
        XCTAssertNil(WsResponse.from(ev))
        let se = SessionEvent.from(ev)
        XCTAssertEqual(se?.sessionId, "s1")
        XCTAssertEqual(se?.event.kind, "message")
        XCTAssertEqual(se?.event.text, "hi")
        XCTAssertEqual(se?.event.role, "assistant")
    }

    func testSessionOpenedAndFileOfferAndWidgetEvents() {
        let so = SessionOpened.event(WireProtocol.parse(#"{"event":"session.opened","data":{"session_id":"s9","title":"T"}}"#)!)
        XCTAssertEqual(so?.sessionId, "s9"); XCTAssertEqual(so?.title, "T")

        let fo = FileOffer.event(WireProtocol.parse(#"{"event":"file.offer","data":{"id":"f1","name":"a.txt","mime":"text/plain","size":12}}"#)!)
        XCTAssertEqual(fo?.name, "a.txt"); XCTAssertEqual(fo?.size, 12)

        let w = WidgetEvent.from(WireProtocol.parse(#"{"event":"widget.render","data":{"id":"w1","title":"CPU","target":"canvas","spec":{"type":"text"}}}"#)!)
        XCTAssertEqual(w?.op, "render"); XCTAssertEqual(w?.id, "w1"); XCTAssertNotNil(w?.spec)
    }

    func testAuthChallengeParsing() {
        let ac = AuthChallenge.from(WireProtocol.parse(#"{"event":"auth.challenge","data":{"challenge_id":"c1","origin":"extension"}}"#)!)
        XCTAssertEqual(ac?.challengeId, "c1")
        XCTAssertEqual(ac?.origin, "extension")
    }

    func testMirrorFrameBinaryLayout() throws {
        let header = #"{"t":"mirror.frame","session_id":"s1","ts":123}"#
        let headerBytes = Array(header.utf8)
        let jpeg: [UInt8] = [0xFF, 0xD8, 0xFF, 0xE0, 0x00]
        var bytes: [UInt8] = []
        let len = headerBytes.count
        bytes += [UInt8((len >> 24) & 0xFF), UInt8((len >> 16) & 0xFF), UInt8((len >> 8) & 0xFF), UInt8(len & 0xFF)]
        bytes += headerBytes
        bytes += jpeg
        let frame = try XCTUnwrap(MirrorFrame.parse(Data(bytes)))
        XCTAssertEqual(frame.sessionId, "s1")
        XCTAssertEqual(frame.ts, 123)
        XCTAssertEqual([UInt8](frame.jpeg), jpeg)
    }

    func testPairPayloadParsing() throws {
        let p = try XCTUnwrap(PairPayload.parse("jarvis://pair?host=100.64.0.1:8796&code=ABC123&fp=deadbeef"))
        XCTAssertEqual(p.hostPort, "100.64.0.1:8796")
        XCTAssertEqual(p.code, "ABC123")
        XCTAssertEqual(p.fingerprint, "deadbeef")
        XCTAssertNil(PairPayload.parse("https://example.com"))
    }

    func testHostPortParsing() {
        XCTAssertEqual(HostPort.parse("10.0.0.2:8796")?.port, 8796)
        XCTAssertEqual(HostPort.parse("myhost")?.port, 8796)   // default port
        XCTAssertNil(HostPort.parse(""))
        XCTAssertNil(HostPort.parse("host:0"))
    }
}
