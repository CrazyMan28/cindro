import SwiftUI

/// One live chat session: transcript + composer. Port of Android `ui/chat/ChatScreen.kt`.
struct ChatView: View {
    let sessionId: String
    @EnvironmentObject var app: AppState
    @StateObject private var vm: ChatViewModel

    init(sessionId: String, repo: JarvisRepository) {
        self.sessionId = sessionId
        _vm = StateObject(wrappedValue: ChatViewModel(sessionId: sessionId, repo: repo))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(vm.items) { item in
                            ChatItemRow(item: item, onApprove: { approve($0, decision: "approve") },
                                        onDeny: { approve($0, decision: "deny") })
                                .id(item.id)
                        }
                        if vm.busy { TypingIndicator().id("__busy__") }
                    }
                    .padding()
                }
                .onChange(of: vm.items.count) { _ in
                    withAnimation { proxy.scrollTo(vm.items.last?.id ?? "__busy__", anchor: .bottom) }
                }
            }
            Divider()
            Composer(draft: $vm.draft, pendingImages: $vm.pendingImages, busy: vm.busy) {
                Task { await vm.sendCurrent() }
            }
        }
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Something went wrong", isPresented: .constant(vm.errorText != nil)) {
            Button("OK") { vm.errorText = nil }
        } message: { Text(vm.errorText ?? "") }
    }

    private func approve(_ approvalId: String, decision: String) {
        Task {
            guard await Biometric.authenticate(reason: "Approve this action") else { return }
            try? await app.repository.respondApproval(sessionId: sessionId, approvalId: approvalId, decision: decision)
            vm.markApprovalResolved(approvalId)
        }
    }
}

/// Renders a single folded transcript item.
struct ChatItemRow: View {
    let item: ChatItem
    var onApprove: (String) -> Void = { _ in }
    var onDeny: (String) -> Void = { _ in }

    var body: some View {
        switch item.content {
        case let .message(role, text, _):
            MessageBubble(role: role, text: text)
        case let .thinking(text):
            Label(text.isEmpty ? "Thinking…" : text, systemImage: "brain")
                .font(.footnote).foregroundStyle(.secondary)
        case let .toolCall(name, args, output, ok, images, server):
            ToolCallCard(name: name, argsJson: args, output: output, ok: ok, images: images, server: server)
        case let .diff(path, patch):
            DisclosureGroup("Edited \(path)") {
                Text(patch).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
        case let .approval(aid, summary, risk, resolved):
            ApprovalCard(summary: summary, risk: risk, resolved: resolved,
                         onApprove: { onApprove(aid) }, onDeny: { onDeny(aid) })
        case let .error(message):
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.red).font(.footnote)
        case let .fileOffer(name, _, size, _):
            Label("\(name)\(size.map { " · \($0) B" } ?? "")", systemImage: "doc")
                .font(.footnote)
        case let .widget(title, _):
            Label(title.isEmpty ? "Widget" : title, systemImage: "square.grid.2x2")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}

struct MessageBubble: View {
    let role: String
    let text: String
    private var isUser: Bool { role == "user" }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            Text(text)
                .textSelection(.enabled)
                .padding(10)
                .background(isUser ? Color.accentColor.opacity(0.85) : Color(.secondarySystemBackground))
                .foregroundStyle(isUser ? .white : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            if !isUser { Spacer(minLength: 40) }
        }
    }
}

struct ToolCallCard: View {
    let name: String
    let argsJson: String?
    let output: String?
    let ok: Bool?
    let images: [String]
    let server: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: ok == false ? "wrench.and.screwdriver.fill" : "wrench.and.screwdriver")
                Text(name).font(.subheadline.weight(.medium))
                if let server { Text(server).font(.caption2).foregroundStyle(.secondary) }
                Spacer()
                if let ok { Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(ok ? .green : .red) }
            }
            if let output, !output.isEmpty {
                Text(output.prefix(2000)).font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary).lineLimit(12)
            }
            ForEach(images.prefix(3), id: \.self) { b64 in
                if let img = decode(b64) {
                    Image(uiImage: img).resizable().scaledToFit()
                        .frame(maxHeight: 220).clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(10)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func decode(_ b64: String) -> UIImage? {
        Data(base64Encoded: b64).flatMap(UIImage.init(data:))
    }
}

struct ApprovalCard: View {
    let summary: String
    let risk: String?
    let resolved: Bool?
    var onApprove: () -> Void
    var onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(summary, systemImage: "hand.raised")
            if let risk { Text("Risk: \(risk)").font(.caption).foregroundStyle(.secondary) }
            if resolved == true {
                Text("Resolved").font(.caption).foregroundStyle(.secondary)
            } else {
                HStack {
                    Button("Deny", role: .destructive, action: onDeny).buttonStyle(.bordered)
                    Button("Approve", action: onApprove).buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(12)
        .background(Color.yellow.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct TypingIndicator: View {
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { _ in Circle().frame(width: 6, height: 6).foregroundStyle(.secondary) }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

/// The message composer: photo attach chips, text field, send button. A subset of
/// Android's `InputRow` (gallery attach; clipboard/voice are follow-ups).
struct Composer: View {
    @Binding var draft: String
    @Binding var pendingImages: [PendingImage]
    let busy: Bool
    var onSend: () -> Void
    @State private var showPicker = false

    var body: some View {
        VStack(spacing: 6) {
            if !pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(pendingImages) { img in
                            ZStack(alignment: .topTrailing) {
                                if let p = img.preview {
                                    Image(uiImage: p).resizable().scaledToFill()
                                        .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 8))
                                }
                                Button { pendingImages.removeAll { $0.id == img.id } } label: {
                                    Image(systemName: "xmark.circle.fill")
                                }.tint(.white)
                            }
                        }
                    }.padding(.horizontal)
                }
            }
            HStack(spacing: 8) {
                Button { showPicker = true } label: { Image(systemName: "photo.on.rectangle") }
                TextField("Message Cindro…", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                Button(action: onSend) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pendingImages.isEmpty))
            }
            .padding(.horizontal).padding(.vertical, 6)
        }
        .sheet(isPresented: $showPicker) {
            PhotoPicker { image in
                if let enc = ImageEncoding.encode(image) { pendingImages.append(enc) }
            }
        }
    }
}
