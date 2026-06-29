#pragma once

// VoiceLibrary — the user's named cloned voices.
//
// Mistral Voxtral clones a voice ZERO-SHOT per request from a short reference
// clip (`ref_audio`); there is no saved-voice_id. So a "voice" here is just a
// named reference clip on disk plus a manifest row. Clips live exactly where the
// daemon's resolver already looks:
//   ~/.config/jarvis/voices/<slug>_ref.<ext>   (ext: mp3|wav|opus|flac|ogg)
// and a sibling manifest tracks names + which one is the default:
//   ~/.config/jarvis/voices/voices.json  ->  { "default": "<slug>", "voices": [ ... ] }
//
// The DEFAULT voice's slug is what gets used everywhere Jarvis speaks (desktop
// TTS, the phone app's spoken replies, and phone calls). "jarvice" is seeded as
// the initial default so today's single cloned voice keeps working unchanged.
//
// This class owns the manifest + clip files (CRUD, slugging, optional ffmpeg
// clean/trim). It is a pure file-store (no network), unit-tested hermetically.

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>
#include <optional>

namespace jarvis {

struct VoiceEntry {
    QString id;        // stable id (== slug)
    QString name;      // display name ("Dad's voice")
    QString slug;      // filesystem slug ("dads_voice" -> dads_voice_ref.<ext>)
    QString ext;       // mp3|wav|opus|flac|ogg
    QString source;    // "seed" | "record" | "upload"
    bool raw = false;  // stored without the ffmpeg clean/trim pass
    QString createdAt; // ISO-8601

    // The voice slug to hand to voice.tts: "jarvice" for the seed, else
    // "clone:<slug>" (both resolve to <slug>_ref.<ext> via the daemon resolver).
    QString voiceSlug() const;
    QJsonObject toJson(bool isDefault) const;
};

class VoiceLibrary {
public:
    VoiceLibrary() = default;

    static QString defaultDir(); // ~/.config/jarvis/voices
    void setDir(const QString &dir) { m_dir = dir; }
    QString dir() const;
    QString manifestPath() const;

    QString lastError() const { return m_lastError; }

    // Load the manifest. If it is absent but reference clips already exist on
    // disk (e.g. today's jarvice_ref.mp3), seed a manifest from them so nothing
    // is lost and "jarvice" becomes the default. Never throws.
    void load();

    QVector<VoiceEntry> list() const { return m_voices; }
    QString defaultSlug() const { return m_default; } // a voiceSlug() value
    std::optional<VoiceEntry> find(const QString &id) const; // by id OR voiceSlug

    // JSON array for voice.list_voices: each entry
    // {id:<voiceSlug>, label:<name>, custom:true, slug, source, raw, is_default}.
    QJsonArray toListJson() const;

    // --- mutations (each persists the manifest) ----------------------------
    // Create-or-replace a voice from raw audio bytes. clean=true runs the ffmpeg
    // clean/trim pipeline -> mp3 (the same one scripts/jarvice_voice.py uses);
    // if ffmpeg is missing it silently falls back to storing the bytes as-is.
    // clean=false stores the bytes verbatim (transcoding only if the container
    // isn't one the resolver understands). Returns the new entry (nullopt on a
    // hard write error; see lastError()).
    std::optional<VoiceEntry> createClone(const QString &name, const QByteArray &audio,
                                          const QString &format, bool clean,
                                          const QString &source = QStringLiteral("upload"));

    bool removeClone(const QString &id); // deletes clip + row; repairs the default
    bool setDefault(const QString &id);  // id/voiceSlug must exist
    // Mirror an arbitrary default voice slug (clone:x / jarvice / a stock slug)
    // without manifest validation — the daemon uses this to keep the library's
    // cached default in lockstep with the tts_voice setting (the real default,
    // which may legitimately be a stock voice that isn't in the library).
    bool setDefaultSlug(const QString &voiceSlug);
    bool rename(const QString &id, const QString &name);

    // Absolute path to a voice's clip on disk, accepting "jarvice", "clone:foo",
    // a bare slug, or an id. Empty if no clip exists (a stock voice). Mirrors the
    // daemon's file convention so the two never diverge.
    QString clipPath(const QString &voiceOrId) const;
    QString defaultClipPath() const; // clip for the current default (empty if stock)

    static QString slug(const QString &name);
    static QStringList clipExtensions(); // {mp3,wav,opus,flac,ogg}
    // Map a requested audio format/extension to a stored clip extension; returns
    // empty if it isn't one of clipExtensions().
    static QString normalizeExt(const QString &format);

private:
    bool save();
    void seedFromDisk();
    QString uniqueSlug(const QString &base) const;
    // Run the ffmpeg clean/trim into outMp3 (true on success). No-op false if
    // ffmpeg is unavailable or fails.
    static bool ffmpegClean(const QString &inPath, const QString &outMp3, bool filters);
    // Repair m_default after a removal so it always points at a real voice (or a
    // stock fallback). Returns true if the default changed.
    bool repairDefault();

    QString m_dir;     // overrides defaultDir() when set (tests)
    QString m_default; // voiceSlug() of the default (e.g. "jarvice" / "clone:x")
    QVector<VoiceEntry> m_voices;
    QString m_lastError;
};

} // namespace jarvis
