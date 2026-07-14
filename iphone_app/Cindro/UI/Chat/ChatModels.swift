import Foundation
import UIKit

/// One rendered row in a chat transcript, folded from the `BrainEvent` stream.
/// Port of Android `ui/chat/ChatModels.kt` `ChatItem` (sealed interface → enum content).
struct ChatItem: Identifiable, Equatable {
    let id: String
    var content: Content

    enum Content: Equatable {
        case message(role: String, text: String, streaming: Bool)
        case thinking(text: String)
        case toolCall(name: String, argsJson: String?, output: String?, ok: Bool?, images: [String], server: String?)
        case diff(path: String, patch: String)
        case approval(approvalId: String, summary: String, risk: String?, resolved: Bool?)
        case error(message: String)
        case fileOffer(name: String, mime: String?, size: Int?, b64: String?)
        case widget(title: String, specJson: String)
    }
}

/// An image staged in the composer, ready to send with the next message.
/// Port of Android `PendingImage(mime, b64, previewUri)`.
struct PendingImage: Identifiable, Equatable {
    let id = UUID()
    let mime: String
    let b64: String
    var preview: UIImage?

    static func == (l: PendingImage, r: PendingImage) -> Bool { l.id == r.id }
}

/// Single-slot handoff for the blank-composer → live-chat flow: `NewChatView` stashes the
/// typed draft/photos keyed by the new session id, and `ChatViewModel.init` consumes+sends
/// it through the normal `send()` path. Port of Android's `PendingFirstMessage` object.
@MainActor
enum PendingFirstMessage {
    private static var sessionId: String?
    private static var text: String = ""
    private static var images: [PendingImage] = []

    static func stash(sessionId: String, text: String, images: [PendingImage]) {
        self.sessionId = sessionId
        self.text = text
        self.images = images
    }

    /// Returns and clears the stashed draft iff it was stashed for `sid`.
    static func consume(_ sid: String) -> (text: String, images: [PendingImage])? {
        guard sessionId == sid else { return nil }
        let out = (text, images)
        sessionId = nil; text = ""; images = []
        return out
    }
}
