import Foundation
import Combine

/// A file Cindro pushed to the phone (`file.offer`), written to the cache dir.
struct ReceivedFile: Identifiable {
    let id: String
    let name: String
    let url: URL
    let mime: String?
    let size: Int?
}

/// Process-wide sink for `file.offer` events: inline-b64 payloads are written to
/// `caches/downloads` (name-sanitized) and exposed for the Files screen + share sheet.
/// Port of Android `files/FileReceiver.kt`.
@MainActor
final class FileReceiver: ObservableObject {
    @Published private(set) var files: [ReceivedFile] = []
    private var cancellable: AnyCancellable?

    init(offers: PassthroughSubject<FileOffer, Never>) {
        cancellable = offers.receive(on: RunLoop.main).sink { [weak self] in self?.ingest($0) }
    }

    private func ingest(_ offer: FileOffer) {
        guard let b64 = offer.b64, let data = Data(base64Encoded: b64) else { return }
        let safeName = offer.name.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "..", with: "_")
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(safeName)
        do {
            try data.write(to: url)
            files.insert(ReceivedFile(id: offer.id.isEmpty ? safeName : offer.id,
                                      name: offer.name, url: url, mime: offer.mime, size: offer.size), at: 0)
        } catch {
            // best-effort; a failed write just doesn't appear in the list
        }
    }
}
