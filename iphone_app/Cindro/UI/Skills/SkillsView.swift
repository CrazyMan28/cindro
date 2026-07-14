import SwiftUI

/// Skills: list, pin, invoke, remove. Port of Android `ui/skills/SkillsScreen.kt`
/// (the "today" digest + create form are lightweight follow-ups).
struct SkillsView: View {
    let repo: JarvisRepository
    @StateObject private var vm: SkillsViewModel

    init(repo: JarvisRepository) {
        self.repo = repo
        _vm = StateObject(wrappedValue: SkillsViewModel(repo: repo))
    }

    var body: some View {
        List {
            ForEach(vm.skills) { skill in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(skill.name).fontWeight(.medium)
                        if skill.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(.tint) }
                        Spacer()
                        if skill.useCount > 0 { Text("\(skill.useCount)×").font(.caption2).foregroundStyle(.secondary) }
                    }
                    if let d = skill.description { Text(d).font(.caption).foregroundStyle(.secondary) }
                }
                .swipeActions {
                    Button { Task { await vm.togglePin(skill) } } label: {
                        Label(skill.pinned ? "Unpin" : "Pin", systemImage: "pin")
                    }.tint(.orange)
                    Button(role: .destructive) { Task { await vm.remove(skill) } } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
        .overlay { if vm.skills.isEmpty { ContentUnavailableCompat(text: "No skills") } }
        .navigationTitle("Skills")
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }
}

@MainActor
final class SkillsViewModel: ObservableObject {
    @Published var skills: [Skill] = []
    private let repo: JarvisRepository
    init(repo: JarvisRepository) { self.repo = repo }

    func load() async { skills = (try? await repo.skillsList()) ?? [] }
    func togglePin(_ s: Skill) async { try? await repo.skillPin(s.name, !s.pinned); await load() }
    func remove(_ s: Skill) async { try? await repo.skillRemove(s.name); await load() }
}
