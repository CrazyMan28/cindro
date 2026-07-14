import Foundation
import Combine
import SwiftUI

/// Backs one live chat session: loads history, folds the live `BrainEvent` stream into
/// `[ChatItem]`, and sends messages (with the first-message handoff + slash commands).
/// Port of Android `ui/chat/ChatViewModel.kt`.
@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var items: [ChatItem] = []
    @Published private(set) var busy = false
    @Published var draft = ""
    @Published var pendingImages: [PendingImage] = []
    @Published var errorText: String?

    let sessionId: String
    private let repo: JarvisRepository
    private var cancellable: AnyCancellable?
    private var itemIndex: [String: Int] = [:]
    private var seq = 0

    init(sessionId: String, repo: JarvisRepository) {
        self.sessionId = sessionId
        self.repo = repo
        subscribe()
        Task { await load() }
    }

    private func subscribe() {
        cancellable = repo.eventsFor(sessionId)
            .receive(on: RunLoop.main)
            .sink { [weak self] ev in self?.fold(ev) }
    }

    func load() async {
        do {
            let history = try await repo.history(sessionId)
            items.removeAll(); itemIndex.removeAll()
            for ev in history { fold(ev, live: false) }
            // Consume a stashed first message (blank-composer handoff).
            if let pending = PendingFirstMessage.consume(sessionId) {
                draft = pending.text
                pendingImages = pending.images
                await sendCurrent()
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    // MARK: sending

    func sendCurrent() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
        guard !text.isEmpty || !images.isEmpty else { return }

        if text.hasPrefix("/"), await handleSlash(text) { return }

        // Optimistic local echo.
        appendOrUpdate(id: "local-\(nextSeq())", .message(role: "user", text: text, streaming: false))
        draft = ""; pendingImages = []
        busy = true
        do {
            try await repo.send(sessionId, text: text, images: images)
        } catch {
            errorText = error.localizedDescription
            busy = false
        }
    }

    /// Returns true if the draft was a handled slash command (nothing more to send).
    private func handleSlash(_ text: String) async -> Bool {
        let parts = text.dropFirst().split(separator: " ", maxSplits: 1).map(String.init)
        let cmd = parts.first ?? ""
        let rest = parts.count > 1 ? parts[1] : ""
        switch cmd {
        case "clear":
            draft = ""
            return true
        case "dispatch":
            let sub = rest.split(separator: " ", maxSplits: 1).map(String.init)
            guard let agent = sub.first, !agent.isEmpty else { return false }
            let task = sub.count > 1 ? sub[1] : ""
            draft = ""
            do { _ = try await repo.agentDispatch(agent: agent, task: task, parentSessionId: sessionId) }
            catch { errorText = error.localizedDescription }
            return true
        default:
            // A `/<skill> args` passes through as a normal message — the model loads the
            // skill via its own tool. Not handled here; let the normal send path run.
            return false
        }
    }

    // MARK: fold

    private func fold(_ ev: BrainEvent, live: Bool = true) {
        switch ev.kind {
        case "turn_started":
            busy = true
        case "thinking":
            appendOrUpdate(id: ev.callId ?? "think-\(nextSeq())", .thinking(text: ev.text ?? ""))
        case "message":
            let role = ev.role ?? "assistant"
            appendOrUpdate(id: "msg-\(nextSeq())", .message(role: role, text: ev.text ?? "", streaming: false))
        case "tool_call":
            let id = ev.callId ?? "tool-\(nextSeq())"
            appendOrUpdate(id: id, .toolCall(name: ev.name ?? "tool", argsJson: jsonString(ev.obj("args")),
                                             output: nil, ok: nil, images: [], server: ev.server))
        case "tool_result":
            let id = ev.callId ?? "tool-\(nextSeq())"
            let images = extractImages(ev)
            if let idx = itemIndex[id], case let .toolCall(name, args, _, _, _, server) = items[idx].content {
                items[idx].content = .toolCall(name: name, argsJson: args, output: ev.output,
                                               ok: ev.bool("ok"), images: images, server: server)
            } else {
                appendOrUpdate(id: id, .toolCall(name: ev.name ?? "tool", argsJson: nil, output: ev.output,
                                                 ok: ev.bool("ok"), images: images, server: ev.server))
            }
        case "diff":
            appendOrUpdate(id: "diff-\(nextSeq())", .diff(path: ev.path ?? "", patch: ev.patch ?? ""))
        case "approval":
            let aid = ev.approvalId ?? "appr-\(nextSeq())"
            appendOrUpdate(id: "appr-\(aid)", .approval(approvalId: aid, summary: ev.summary ?? "Approve this action?",
                                                        risk: ev.risk, resolved: nil))
        case "error":
            appendOrUpdate(id: "err-\(nextSeq())", .error(message: ev.message ?? ev.text ?? "error"))
        case "final":
            busy = false
        default:
            break
        }
    }

    /// Base64 images attached to a tool result (`images:[...]` or a single `image`/`screenshot`).
    private func extractImages(_ ev: BrainEvent) -> [String] {
        var out: [String] = []
        if let arr = ev.fields.arr("images") { out += arr.compactMap { $0 as? String } }
        for key in ["image", "screenshot"] { if let s = ev.str(key) { out.append(s) } }
        return out
    }

    func markApprovalResolved(_ approvalId: String) {
        let id = "appr-\(approvalId)"
        guard let idx = itemIndex[id], case let .approval(aid, summary, risk, _) = items[idx].content else { return }
        items[idx].content = .approval(approvalId: aid, summary: summary, risk: risk, resolved: true)
    }

    // MARK: helpers

    private func appendOrUpdate(id: String, _ content: ChatItem.Content) {
        if let idx = itemIndex[id] {
            items[idx].content = content
        } else {
            itemIndex[id] = items.count
            items.append(ChatItem(id: id, content: content))
        }
    }

    private func nextSeq() -> Int { seq += 1; return seq }
    private func jsonString(_ obj: JSONObject?) -> String? {
        guard let obj, let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
