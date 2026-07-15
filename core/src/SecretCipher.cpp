#include "jarvis/SecretCipher.h"

#if defined(Q_OS_WIN)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN 1
#endif
#ifndef NOMINMAX
#define NOMINMAX 1
#endif
#include <windows.h>
#include <wincrypt.h>
#elif defined(Q_OS_LINUX) && defined(JARVIS_HAVE_LIBSECRET)
extern "C" {
#include <libsecret/secret.h>
}
#endif

namespace jarvis {

#if defined(Q_OS_WIN)

// ---- Windows: DPAPI --------------------------------------------------------
// Bound to the logged-in Windows user; no separate password to manage, and no
// extra install (Crypt32 ships with every Windows install).

QString SecretCipher::backendName() { return QStringLiteral("dpapi"); }

bool SecretCipher::available() { return true; }

QByteArray SecretCipher::protect(const QByteArray &plaintext)
{
    DATA_BLOB in;
    in.pbData = reinterpret_cast<BYTE *>(const_cast<char *>(plaintext.constData()));
    in.cbData = static_cast<DWORD>(plaintext.size());
    DATA_BLOB out{};
    // CRYPTPROTECT_UI_FORBIDDEN: never show a UI prompt — jarvisd runs headless.
    if (!CryptProtectData(&in, L"Cindro secrets.json", nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &out))
        return {};
    const QByteArray result(reinterpret_cast<const char *>(out.pbData), int(out.cbData));
    LocalFree(out.pbData);
    return result;
}

QByteArray SecretCipher::unprotect(const QByteArray &stored, bool *ok)
{
    if (ok)
        *ok = false;
    if (stored.isEmpty())
        return {};
    DATA_BLOB in;
    in.pbData = reinterpret_cast<BYTE *>(const_cast<char *>(stored.constData()));
    in.cbData = static_cast<DWORD>(stored.size());
    DATA_BLOB out{};
    if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr,
                            CRYPTPROTECT_UI_FORBIDDEN, &out))
        return {};
    const QByteArray result(reinterpret_cast<const char *>(out.pbData), int(out.cbData));
    LocalFree(out.pbData);
    if (ok)
        *ok = true;
    return result;
}

#elif defined(Q_OS_LINUX) && defined(JARVIS_HAVE_LIBSECRET)

// ---- Linux: freedesktop Secret Service (libsecret) -------------------------
// One fixed item per install ("purpose"="secrets_json") — there is exactly one
// secrets.json, so no per-install handle needs to round-trip through the file.
// The disk envelope just needs to know to look here instead of decoding a blob.

namespace {
const SecretSchema *cindroSchema()
{
    static const SecretSchema schema = {
        "org.cindro.jarvis.secrets", SECRET_SCHEMA_NONE,
        { { "purpose", SECRET_SCHEMA_ATTRIBUTE_STRING } }
    };
    return &schema;
}
} // namespace

QString SecretCipher::backendName() { return QStringLiteral("secretservice"); }

bool SecretCipher::available()
{
    GError *error = nullptr;
    SecretService *service = secret_service_get_sync(SECRET_SERVICE_NONE, nullptr, &error);
    const bool ok = service != nullptr && error == nullptr;
    if (service)
        g_object_unref(service);
    if (error)
        g_error_free(error);
    return ok;
}

QByteArray SecretCipher::protect(const QByteArray &plaintext)
{
    GError *error = nullptr;
    const gboolean ok = secret_password_store_sync(
        cindroSchema(), SECRET_COLLECTION_DEFAULT, "Cindro API keys (secrets.json)",
        plaintext.constData(), nullptr, &error, "purpose", "secrets_json", nullptr);
    if (error) {
        g_error_free(error);
        return {};
    }
    // The real bytes live in the keyring; the disk file just needs a marker
    // that says "look there" (see SettingsStore's envelope format).
    return ok ? QByteArray("secretservice") : QByteArray();
}

QByteArray SecretCipher::unprotect(const QByteArray &stored, bool *ok)
{
    Q_UNUSED(stored);
    if (ok)
        *ok = false;
    GError *error = nullptr;
    gchar *password = secret_password_lookup_sync(
        cindroSchema(), nullptr, &error, "purpose", "secrets_json", nullptr);
    if (error) {
        g_error_free(error);
        return {};
    }
    if (!password)
        return {};
    const QByteArray result(password);
    secret_password_free(password);
    if (ok)
        *ok = true;
    return result;
}

#else

// ---- No OS-backed mechanism available at build/run time --------------------
// SettingsStore falls back to today's plaintext+chmod-0600 behavior.

QString SecretCipher::backendName() { return QStringLiteral("none"); }
bool SecretCipher::available() { return false; }
QByteArray SecretCipher::protect(const QByteArray &) { return {}; }
QByteArray SecretCipher::unprotect(const QByteArray &, bool *ok)
{
    if (ok)
        *ok = false;
    return {};
}

#endif

} // namespace jarvis
