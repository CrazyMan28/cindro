// Unit test for VoiceLibrary — the named cloned-voice manifest + clip store.
// Uses an isolated $HOME so it never touches the user's real
// ~/.config/jarvis/voices. Hermetic: raw clip bytes with clean=false, so it
// never shells out to ffmpeg or the network.

#include "jarvis/Config.h"
#include "jarvis/VoiceLibrary.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QTemporaryDir>

#include <cstdio>

static int g_failures = 0;

static void check(bool cond, const char *what)
{
    if (!cond) {
        std::fprintf(stderr, "  FAIL: %s\n", what);
        ++g_failures;
    } else {
        std::fprintf(stderr, "  ok:   %s\n", what);
    }
}

static QString voicesDir()
{
    return jarvis::Config::configDir() + QStringLiteral("/voices");
}

static void writeClip(const QString &fileName, const QByteArray &bytes)
{
    QDir().mkpath(voicesDir());
    QFile f(voicesDir() + QStringLiteral("/") + fileName);
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        f.write(bytes);
        f.close();
    }
}

int main()
{
    QTemporaryDir home;
    if (!home.isValid()) {
        std::fprintf(stderr, "FAIL: could not create temp HOME\n");
        return 1;
    }
    qputenv("HOME", home.path().toUtf8());
    qunsetenv("XDG_CONFIG_HOME");

    const QByteArray dummy("\x52\x49\x46\x46 not-real-audio-but-fine-for-store-test", 44);

    // --- 1) Seed from disk: a pre-existing jarvice_ref.mp3 becomes "Orin" ----
    // (the on-disk slug stays "jarvice" for back-compat; only the user-facing
    // display name follows the product rebrand.)
    {
        writeClip(QStringLiteral("jarvice_ref.mp3"), dummy);
        jarvis::VoiceLibrary lib;
        lib.load();
        const auto voices = lib.list();
        check(voices.size() == 1, "seed: exactly one voice discovered on disk");
        check(!voices.isEmpty() && voices.front().slug == QStringLiteral("jarvice"),
              "seed: discovered slug is jarvice");
        check(!voices.isEmpty() && voices.front().name == QStringLiteral("Orin"),
              "seed: jarvice gets the display name 'Orin'");
        check(lib.defaultSlug() == QStringLiteral("jarvice"),
              "seed: jarvice is the default");
        check(QFile::exists(lib.manifestPath()),
              "seed: voices.json manifest was written");
    }

    // --- 2) A second load reads the manifest (does NOT reseed) ----------------
    {
        jarvis::VoiceLibrary lib;
        lib.load();
        check(lib.list().size() == 1, "reload: manifest read back (no reseed dup)");
        check(lib.defaultSlug() == QStringLiteral("jarvice"), "reload: default persists");
    }

    // --- 3) createClone (raw .wav): slug, ext, file, voiceSlug ----------------
    {
        jarvis::VoiceLibrary lib;
        lib.load();
        const auto e = lib.createClone(QStringLiteral("Dad's Voice"), dummy,
                                       QStringLiteral("wav"), /*clean=*/false,
                                       QStringLiteral("record"));
        check(e.has_value(), "createClone returns an entry");
        check(e && e->slug == QStringLiteral("dads_voice"),
              "createClone slugs \"Dad's Voice\" -> dads_voice");
        check(e && e->ext == QStringLiteral("wav"), "createClone keeps the wav ext (raw)");
        check(e && e->raw == true, "raw clip is flagged raw");
        check(e && e->voiceSlug() == QStringLiteral("clone:dads_voice"),
              "custom voiceSlug is clone:<slug>");
        check(QFile::exists(voicesDir() + QStringLiteral("/dads_voice_ref.wav")),
              "clip file dads_voice_ref.wav written");
        check(lib.list().size() == 2, "library now has 2 voices");
    }

    // --- 4) set-default + persistence + clipPath resolution -------------------
    {
        jarvis::VoiceLibrary lib;
        lib.load();
        check(lib.list().size() == 2, "reload sees both voices");
        check(lib.setDefault(QStringLiteral("clone:dads_voice")),
              "setDefault(clone:dads_voice) succeeds");
        check(lib.defaultSlug() == QStringLiteral("clone:dads_voice"),
              "default is now the custom voice");
        const QString cp = lib.clipPath(QStringLiteral("clone:dads_voice"));
        check(cp.endsWith(QStringLiteral("dads_voice_ref.wav")),
              "clipPath resolves clone:dads_voice -> the wav");
        check(lib.defaultClipPath() == cp, "defaultClipPath matches the default clip");

        jarvis::VoiceLibrary lib2;
        lib2.load();
        check(lib2.defaultSlug() == QStringLiteral("clone:dads_voice"),
              "default persists across reload");
    }

    // --- 5) create-or-replace by slug (same name re-records in place) ---------
    {
        jarvis::VoiceLibrary lib;
        lib.load();
        const int before = lib.list().size();
        lib.createClone(QStringLiteral("Dad's Voice"), dummy, QStringLiteral("wav"), false);
        check(lib.list().size() == before, "re-record same name replaces (no dup)");
    }

    // --- 6) remove the default -> default repairs back to jarvice -------------
    {
        jarvis::VoiceLibrary lib;
        lib.load();
        check(lib.removeClone(QStringLiteral("clone:dads_voice")),
              "removeClone(default) succeeds");
        check(!QFile::exists(voicesDir() + QStringLiteral("/dads_voice_ref.wav")),
              "removed clip file is gone");
        check(lib.defaultSlug() == QStringLiteral("jarvice"),
              "default repaired back to jarvice after removing the default");
        check(lib.list().size() == 1, "only jarvice remains");
    }

    // --- 7) remove the last voice -> default falls back to a stock voice ------
    {
        jarvis::VoiceLibrary lib;
        lib.load();
        check(lib.removeClone(QStringLiteral("jarvice")), "removeClone(jarvice) succeeds");
        check(lib.list().isEmpty(), "library empty after removing jarvice");
        check(lib.defaultSlug() == QStringLiteral("en_paul_neutral"),
              "empty library => default falls back to en_paul_neutral (TTS never breaks)");
        check(lib.defaultClipPath().isEmpty(),
              "stock default has no clip path (uses the named stock voice)");
    }

    // --- 8) slug helper edge cases -------------------------------------------
    {
        check(jarvis::VoiceLibrary::slug(QStringLiteral("Dad's Voice")) ==
                  QStringLiteral("dads_voice"),
              "slug: apostrophe dropped, space -> underscore");
        check(jarvis::VoiceLibrary::slug(QStringLiteral("  My  Cool//Voice.. ")) ==
                  QStringLiteral("my_cool_voice"),
              "slug: collapses separators, trims edges");
        check(jarvis::VoiceLibrary::slug(QStringLiteral("!!!")) == QStringLiteral("voice"),
              "slug: all-symbols -> 'voice'");
        check(jarvis::VoiceLibrary::normalizeExt(QStringLiteral("MP3")) ==
                  QStringLiteral("mp3"),
              "normalizeExt MP3 -> mp3");
        check(jarvis::VoiceLibrary::normalizeExt(QStringLiteral("m4a")).isEmpty(),
              "normalizeExt m4a -> empty (needs transcode)");
    }

    if (g_failures == 0) {
        std::fprintf(stderr, "\nPASS voice_library_test\n");
        return 0;
    }
    std::fprintf(stderr, "\nFAIL voice_library_test (%d failures)\n", g_failures);
    return 1;
}
