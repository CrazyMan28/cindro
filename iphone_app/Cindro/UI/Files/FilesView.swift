import SwiftUI

/// Files Cindro pushed to the phone. Port of Android `ui/files/FilesScreen.kt` (reads the
/// process-wide `FileReceiver`, shares via the system share sheet).
struct FilesView: View {
    @ObservedObject var receiver: FileReceiver
    @State private var shareURL: URL?

    var body: some View {
        List(receiver.files) { f in
            Button { shareURL = f.url } label: {
                HStack {
                    Image(systemName: "doc")
                    VStack(alignment: .leading) {
                        Text(f.name)
                        if let size = f.size { Text("\(size) bytes").font(.caption2).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Image(systemName: "square.and.arrow.up").foregroundStyle(.tint)
                }
            }
        }
        .overlay { if receiver.files.isEmpty { ContentUnavailableCompat(text: "No files received yet") } }
        .navigationTitle("Files")
        .sheet(item: Binding(get: { shareURL.map { ShareItem(url: $0) } }, set: { shareURL = $0?.url })) { item in
            ShareSheet(items: [item.url])
        }
    }
}

private struct ShareItem: Identifiable { let url: URL; var id: URL { url } }

/// Minimal `UIActivityViewController` wrapper.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
