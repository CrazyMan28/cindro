#pragma once

// SecretCipher — OS-backed at-rest protection for secrets.json.
//
// jarvisd starts unattended (systemd --user on Linux, no login prompt), so
// whatever protects secrets.json must unlock with NO password. That rules out
// a user-entered master key; instead we lean on whatever the OS already ties
// to the logged-in user account:
//   - Windows: DPAPI (CryptProtectData/CryptUnprotectData) — always present,
//     no extra install, transparently bound to the Windows user.
//   - Linux: freedesktop Secret Service (libsecret) — gnome-keyring/kwalletd,
//     when a keyring daemon is reachable. On a headless box with no session
//     bus (or when libsecret wasn't available at build time), available()
//     returns false and SettingsStore falls back to today's plaintext+chmod
//     0600 rather than lose or block on secrets.
//
// protect()/unprotect() operate on the WHOLE serialized secrets.json JSON
// blob, not per-key — SettingsStore treats this as one opaque envelope.
#include <QByteArray>
#include <QString>

namespace jarvis {

class SecretCipher {
public:
    // Human-readable id of the backend written into the on-disk envelope
    // ("dpapi" / "secretservice" / "none"), so a stored file is self-describing.
    static QString backendName();

    // Best-effort probe: can protect()/unprotect() actually work right now?
    // DPAPI: always true on Windows. Secret Service: true only if a keyring
    // daemon answers on the session/system bus.
    static bool available();

    // Protect `plaintext` (the secrets.json JSON bytes) for at-rest storage.
    // Returns the bytes to persist to disk on success, empty on failure. On
    // Linux this may store the real bytes in the Secret Service and return
    // just a small marker — the disk file never holds the plaintext either way.
    static QByteArray protect(const QByteArray &plaintext);

    // Reverse of protect(): recovers the plaintext given what protect() wrote
    // to disk. Sets *ok=false and returns empty on failure (wrong user/machine,
    // locked/missing keyring item, corrupted blob, ...) — callers must NOT
    // treat that as "no secrets configured".
    static QByteArray unprotect(const QByteArray &stored, bool *ok);
};

} // namespace jarvis
