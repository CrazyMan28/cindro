#pragma once

#include <QImage>
#include <QMutex>
#include <QQuickImageProvider>

// FrameProvider — a QQuickImageProvider that hands the latest agent-desktop
// video frame to QML. The Bridge pushes JPEG bytes (decoded to a QImage) here as
// they arrive from the per-session computer-use engine's GET /video/frame
// endpoint (Wave 5 live preview of the nested agent desktop). QML renders it via
//   Image { source: "image://jarvisframe/agent?<seq>" }
// where <seq> is bumped on every new frame so the cache is bypassed.
//
// Access is guarded by a mutex because the network reply runs on the Bridge's
// thread while the QML render thread pulls frames through requestImage().
class FrameProvider : public QQuickImageProvider
{
public:
    FrameProvider()
        : QQuickImageProvider(QQuickImageProvider::Image)
    {
    }

    // Replace the current frame. Returns true if the bytes decoded to an image.
    bool setFrame(const QByteArray &jpeg)
    {
        QImage img;
        if (!img.loadFromData(jpeg))
            return false;
        QMutexLocker lock(&m_mutex);
        m_frame = std::move(img);
        m_hasFrame = true;
        return true;
    }

    void clear()
    {
        QMutexLocker lock(&m_mutex);
        m_frame = QImage();
        m_hasFrame = false;
    }

    bool hasFrame() const
    {
        QMutexLocker lock(&m_mutex);
        return m_hasFrame;
    }

    // QQuickImageProvider — the id/query string is ignored (we only ever serve the
    // single latest frame); the ?<seq> query exists purely to defeat QML's cache.
    QImage requestImage(const QString &id, QSize *size,
                        const QSize &requestedSize) override
    {
        Q_UNUSED(id);
        QMutexLocker lock(&m_mutex);
        QImage out = m_hasFrame ? m_frame : placeholder();
        if (size)
            *size = out.size();
        if (requestedSize.isValid() && !requestedSize.isEmpty()
            && requestedSize != out.size()) {
            out = out.scaled(requestedSize, Qt::KeepAspectRatio,
                             Qt::SmoothTransformation);
        }
        return out;
    }

private:
    static QImage placeholder()
    {
        // A small transparent tile shown before the first frame lands.
        QImage img(16, 16, QImage::Format_ARGB32);
        img.fill(Qt::transparent);
        return img;
    }

    mutable QMutex m_mutex;
    QImage m_frame;
    bool m_hasFrame = false;
};
