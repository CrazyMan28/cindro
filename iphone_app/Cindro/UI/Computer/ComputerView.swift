import SwiftUI
import Combine

/// Computer: live screen mirror of a session's agent desktop + tap-to-click, plus
/// take-over. Port of Android `ui/computer/ComputerScreen.kt` (basic tier: tap → click;
/// keyboard/drag/scroll input and the full HUD are follow-ups — see README parity table).
struct ComputerView: View {
    @EnvironmentObject var app: AppState
    @StateObject private var vm = ComputerViewModel()

    var body: some View {
        VStack(spacing: 12) {
            if let frame = vm.frame {
                GeometryReader { geo in
                    Image(uiImage: frame)
                        .resizable().scaledToFit()
                        .frame(maxWidth: .infinity)
                        .gesture(DragGesture(minimumDistance: 0).onEnded { g in
                            vm.tap(at: g.location, in: geo.size)
                        })
                }
            } else {
                Spacer()
                Picker("Session", selection: $vm.selectedSession) {
                    Text("Pick a session").tag(String?.none)
                    ForEach(vm.sessions) { s in Text(s.displayTitle).tag(String?.some(s.id)) }
                }
                Text("Start a mirror to see and drive the computer.")
                    .foregroundStyle(.secondary).font(.footnote)
                Spacer()
            }

            HStack {
                if vm.mirroring {
                    Button("Stop", role: .destructive) { Task { await vm.stop() } }.buttonStyle(.bordered)
                    Button("Take over") { Task { await vm.takeOver() } }.buttonStyle(.bordered)
                } else {
                    Button("Start mirror") { Task { await vm.start() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(vm.selectedSession == nil)
                }
            }
            .padding(.bottom)
        }
        .padding()
        .navigationTitle("Computer")
        .task { vm.configure(app.repository); await vm.loadSessions() }
        .errorAlert($vm.errorText, title: "Mirror error")
    }
}

@MainActor
final class ComputerViewModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var selectedSession: String?
    @Published var frame: UIImage?
    @Published var mirroring = false
    @Published var errorText: String?

    private var repo: JarvisRepository?
    private var cancellable: AnyCancellable?
    private var size: (w: Int, h: Int) = (0, 0)
    /// The session actually being mirrored, captured when the mirror starts. The Picker's
    /// `selectedSession` stays live (it's still visible until the first frame arrives), so
    /// stop / take-over / tap / the frame filter must key off THIS, not the live selection —
    /// otherwise switching the Picker before the first frame targets the wrong session.
    private var mirroredSession: String?

    func configure(_ repo: JarvisRepository) {
        guard self.repo == nil else { return }
        self.repo = repo
        cancellable = repo.client.frames.receive(on: RunLoop.main).sink { [weak self] mf in
            guard let self, mf.sessionId == self.mirroredSession else { return }
            self.frame = UIImage(data: mf.jpeg)
        }
    }

    func loadSessions() async {
        sessions = (try? await repo?.listSessions())?.filter { !$0.isSubagent } ?? []
        if selectedSession == nil { selectedSession = sessions.first?.id }
    }

    /// `mirror.start` is BIOMETRIC-tier.
    func start() async {
        guard let repo, let sid = selectedSession else { return }
        guard await Biometric.authenticate(reason: "Start screen mirror") else { return }
        do {
            let dims = try await repo.mirrorStart(sid)
            size = (dims.width, dims.height)
            mirroredSession = sid          // pin the target for stop / take-over / tap / frames
            mirroring = true
        } catch { errorText = error.localizedDescription }
    }

    func stop() async {
        guard let repo, let sid = mirroredSession else { return }
        try? await repo.mirrorStop(sid)
        mirroring = false
        mirroredSession = nil
        frame = nil
    }

    func takeOver() async {
        guard let repo, let sid = mirroredSession else { return }
        guard await Biometric.authenticate(reason: "Take over the computer") else { return }
        try? await repo.takeOverRequest(sid)
    }

    /// Map a tap in the displayed image to remote screen coordinates and send a click.
    func tap(at point: CGPoint, in viewSize: CGSize) {
        guard let repo, let sid = mirroredSession, mirroring, size.w > 0, size.h > 0,
              let img = frame else { return }
        // The image is scaledToFit; compute the letterboxed content rect.
        let scale = min(viewSize.width / img.size.width, viewSize.height / img.size.height)
        let shownW = img.size.width * scale, shownH = img.size.height * scale
        let originX = (viewSize.width - shownW) / 2, originY = (viewSize.height - shownH) / 2
        let localX = point.x - originX, localY = point.y - originY
        guard localX >= 0, localY >= 0, localX <= shownW, localY <= shownH else { return }
        let rx = Int(localX / shownW * CGFloat(size.w))
        let ry = Int(localY / shownH * CGFloat(size.h))
        Task { try? await repo.inputEvent(sessionId: sid, kind: "click", x: rx, y: ry, button: "left") }
    }
}
