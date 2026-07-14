import SwiftUI

/// Every drawer destination. Order mirrors Android `AppDrawerDestinations` (AppDrawer.kt).
enum Route: String, CaseIterable, Identifiable {
    case chatHome, sessions, canvas, computer, phonePermissions
    case skills, agents, queue, mcp, plugins, memory, files, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .chatHome: return "New chat"
        case .sessions: return "Chats"
        case .canvas: return "Canvas"
        case .computer: return "Computer"
        case .phonePermissions: return "Phone permissions"
        case .skills: return "Skills"
        case .agents: return "Agents"
        case .queue: return "Queue"
        case .mcp: return "MCP servers"
        case .plugins: return "Plugins"
        case .memory: return "Memory"
        case .files: return "Files"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .chatHome: return "square.and.pencil"
        case .sessions: return "bubble.left.and.bubble.right"
        case .canvas: return "paintpalette"
        case .computer: return "display"
        case .phonePermissions: return "phone.badge.checkmark"
        case .skills: return "wand.and.stars"
        case .agents: return "person.2"
        case .queue: return "list.bullet.rectangle"
        case .mcp: return "server.rack"
        case .plugins: return "puzzlepiece.extension"
        case .memory: return "brain.head.profile"
        case .files: return "folder"
        case .settings: return "gearshape"
        }
    }
}

/// The main app shell: a NavigationStack for pushed chats + a custom sliding drawer.
/// SwiftUI has no first-party drawer, so this is a ZStack overlay (drawer edge-swipe is
/// disabled implicitly since the drawer is button-driven).
struct MainShell: View {
    @EnvironmentObject var app: AppState
    @State private var route: Route = .chatHome
    @State private var path: [String] = []      // pushed chat session ids
    @State private var drawerOpen = false

    private var repo: JarvisRepository { app.repository }

    var body: some View {
        ZStack(alignment: .leading) {
            NavigationStack(path: $path) {
                rootContent
                    .navigationDestination(for: String.self) { sid in
                        ChatView(sessionId: sid, repo: repo)
                    }
                    .toolbar {
                        ToolbarItem(placement: .navigationBarLeading) {
                            Button { withAnimation { drawerOpen = true } } label: {
                                Image(systemName: "line.3.horizontal")
                            }
                        }
                    }
            }

            if drawerOpen {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { withAnimation { drawerOpen = false } }
                AppDrawer(repo: repo, current: route, onSelect: select, onOpenSession: openSession)
                    .frame(width: 300)
                    .transition(.move(edge: .leading))
            }
        }
        .onReceive(app.$openSessionId.compactMap { $0 }) { sid in
            openSession(sid)
            app.openSessionId = nil
        }
    }

    @ViewBuilder private var rootContent: some View {
        switch route {
        case .chatHome:        NewChatView(repo: repo, onOpenSession: openSession)
        case .sessions:        SessionsView(repo: repo, onOpenSession: openSession)
        case .canvas:          CanvasView(store: app.widgetStore)
        case .computer:        ComputerView()
        case .phonePermissions: PhonePermissionsView(repo: repo)
        case .skills:          SkillsView(repo: repo)
        case .agents:          AgentsView(repo: repo, onOpenSession: openSession)
        case .queue:           QueueView(repo: repo)
        case .mcp:             McpView(repo: repo)
        case .plugins:         PluginsView(repo: repo)
        case .memory:          MemoryView(repo: repo)
        case .files:           FilesView(receiver: app.fileReceiver)
        case .settings:        SettingsView(repo: repo)
        }
    }

    private func select(_ r: Route) {
        withAnimation { drawerOpen = false }
        path.removeAll()          // drawer nav replaces the root (matches navigateFromDrawer)
        route = r
    }

    private func openSession(_ sid: String) {
        withAnimation { drawerOpen = false }
        if path.last != sid { path.append(sid) }
    }
}
