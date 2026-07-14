import UIKit

/// Encode a picked image into a `PendingImage` (downscaled JPEG b64). Port of Android
/// `ui/util/ImageEncoding.kt` — keeps payloads small before sending over the socket.
enum ImageEncoding {
    static func encode(_ image: UIImage, maxDimension: CGFloat = 1600, quality: CGFloat = 0.8) -> PendingImage? {
        let resized = image.downscaled(maxDimension: maxDimension)
        guard let data = resized.jpegData(compressionQuality: quality) else { return nil }
        return PendingImage(mime: "image/jpeg", b64: data.base64EncodedString(), preview: resized)
    }
}

extension UIImage {
    func downscaled(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxDimension, longest > 0 else { return self }
        let scale = maxDimension / longest
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in draw(in: CGRect(origin: .zero, size: newSize)) }
    }
}
