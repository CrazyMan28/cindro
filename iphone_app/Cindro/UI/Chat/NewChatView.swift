import SwiftUI

/// The blank landing composer — the true app root (matches Android `NewChatScreen` /
/// `CHAT_HOME`). Typing + send creates a session, stashes the draft via
/// `PendingFirstMessage`, and hands off to the live chat.
struct NewChatView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var vm: HomeViewModel
    /// Called with the new session id once created, so the shell can push the chat.
    var onOpenSession: (String) -> Void

    @State private var draft = ""
    @State private var pendingImages: [PendingImage] = []

    init(repo: JarvisRepository, onOpenSession: @escaping (String) -> Void) {
        _vm = StateObject(wrappedValue: HomeViewModel(repo: repo))
        self.onOpenSession = onOpenSession
    }

    var body: some View {
        VStack(spacing: 0) {
            ConnectionBanner()
            Spacer()
            VStack(spacing: 12) {
                Image(systemName: "sparkles")
                    .font(.system(size: 44, weight: .light)).foregroundStyle(.tint)
                Text("What can Cindro do for you?")
                    .font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                suggestionRow
            }
            .padding()
            Spacer()
            Divider()
            Composer(draft: $draft, pendingImages: $pendingImages, busy: false) {
                Task { await start() }
            }
        }
        .navigationTitle("Cindro")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Couldn't start chat", isPresented: .constant(vm.errorText != nil)) {
            Button("OK") { vm.errorText = nil }
        } message: { Text(vm.errorText ?? "") }
    }

    private var suggestionRow: some View {
        let suggestions = ["Summarize my day", "Check the build", "Draft an email", "What's on my computer?"]
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(suggestions, id: \.self) { s in
                    Button(s) { draft = s }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }.padding(.horizontal)
        }
    }

    private func start() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pendingImages.isEmpty else { return }
        if let sid = await vm.startChat(text: text, images: pendingImages) {
            draft = ""; pendingImages = []
            onOpenSession(sid)
        }
    }
}

/// Backs `NewChatView` and the drawer's "Recents". Port of Android `HomeViewModel`.
@MainActor
final class HomeViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var errorText: String?
    private let repo: JarvisRepository

    init(repo: JarvisRepository) { self.repo = repo }

    func loadSessions() async {
        sessions = (try? await repo.listSessions())?.filter { !$0.isSubagent } ?? []
    }

    /// Create a session and stash the first message for the chat to replay. Returns the
    /// new session id, or nil on failure (error surfaced). Mirrors Android's `sendFirst`,
    /// which stashes only AFTER `session.create` succeeds (no silent message loss).
    func startChat(text: String, images: [PendingImage]) async -> String? {
        do {
            let sid = try await repo.createSession(profile: "coworker")
            guard !sid.isEmpty else { errorText = "Daemon did not return a session id."; return nil }
            PendingFirstMessage.stash(sessionId: sid, text: text, images: images)
            return sid
        } catch {
            errorText = error.localizedDescription
            return nil
        }
    }
}
