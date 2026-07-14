# iphone_app — Cindro for iOS

A native **SwiftUI** client for the Cindro daemon, mirroring the Android app
(`android/`, package `com.cindro.app`) feature-for-feature over the **same wire
protocol** — the Contract C device WebSocket (`ws://<host>:8796/device/ws`), Ed25519
device pairing, and the Contract A request/response + event envelope. No daemon changes:
the phone is a thin client, exactly like the desktop, extension, and Android surfaces.

> **Status: unverified foundation.** This was authored on a non-macOS box, so it has
> **not been compiled or run** — no Xcode was available. The wire protocol, crypto, and
> architecture are ported directly from the working Android code; the SwiftUI layer is
> idiomatic but needs a first `xcodebuild` pass (CI does this on `macos-latest`) plus a
> device smoke test before it can be called done. Treat the parity table below as "coded,
> pending build verification," not "shipped."

## Build

The `.xcodeproj` is **not committed** — it's generated from [`project.yml`](project.yml)
with [XcodeGen](https://github.com/yonasstephen/xcodegen) so the project file can't drift
from the source tree (the same reason the Android app is pure Gradle). On a Mac:

```bash
brew install xcodegen          # once
cd iphone_app
xcodegen generate              # writes Cindro.xcodeproj
open Cindro.xcodeproj          # or: xcodebuild -scheme Cindro -destination 'platform=iOS Simulator,name=iPhone 15' test
```

Deployment target **iOS 16**. No third-party dependencies — everything is Apple SDK
(SwiftUI, Combine, CryptoKit, LocalAuthentication, AVFoundation, PhotosUI, Security).

## Architecture (maps 1:1 to Android)

| iOS (`Cindro/`) | Android (`com.cindro.app`) | Role |
|---|---|---|
| `App/AppState` | `JarvisApp` | Process-wide singletons (identity, stores, repository, file receiver) |
| `Crypto/DeviceIdentity` (CryptoKit `Curve25519.Signing`) | `crypto/DeviceIdentity` (Tink raw Ed25519) | Bare 32-byte pubkey / 64-byte detached sig; `sha256(pubkey)` first-16-hex device id |
| `Crypto/Keychain` | `data/SecretStore` (EncryptedSharedPreferences) | Stores the 32-byte seed in the iOS Keychain |
| `Data/PairingStore` (UserDefaults) | `data/PairingStore` (SharedPreferences) | host:port, paired, daemon fingerprint, device name |
| `Net/DeviceClient` (`URLSessionWebSocketTask`) | `net/DeviceClient` (OkHttp) | Long-lived authed socket: hello → challenge → sign → authed, id-correlated requests, reconnect backoff |
| `Net/PairingClient` | `net/PairingClient` | One-shot `pair_code` handshake |
| `Net/JarvisRepository` | `net/JarvisRepository` | The whole Contract A method catalog |
| `Protocol/Protocol` + `Protocol/Models` | `protocol/Protocol` + `protocol/Models` | Wire envelope + data models |
| `UI/*` (SwiftUI + `@Observable`/`ObservableObject` VMs) | `ui/*` (Compose + MVVM ViewModels) | Screens |

The handshake and envelope are byte-compatible with the Android client — the daemon can't
tell the two apart apart from the `name`/`hello` device label.

## Feature parity

| Feature | State | Notes |
|---|---|---|
| Ed25519 pairing (QR scan + manual) | ✅ ported | `PairView`, `QRScannerView` (AVFoundation), `PairPayload` `jarvis://pair?…` |
| Authed device socket + reconnect + identity-pin warning | ✅ ported | `DeviceClient` |
| Biometric app-open gate (fail-open) | ✅ ported | `Biometric` (LocalAuthentication), `GateView` |
| Chat: history, live event fold, send, optimistic echo | ✅ ported | `ChatView`, `ChatViewModel` |
| Blank-composer landing + first-message handoff | ✅ ported | `NewChatView`, `PendingFirstMessage` |
| Slash commands (`/dispatch`, `/clear`) | ✅ ported | `ChatViewModel.handleSlash` |
| Photo attach + vision send | ✅ ported | `PhotoPicker`, `ImageEncoding` |
| Tool-call / diff / approval / error cards | ✅ ported | `ChatItemRow`; approvals are biometric-gated |
| Drawer nav (13 destinations + recents) | ✅ ported | `MainShell`, `AppDrawer` |
| Sessions list (create/open/delete) | ✅ ported | `SessionsView` |
| Memory / Skills / Agents / Queue / MCP / Plugins | ✅ ported | list + core CRUD each |
| Phone permissions (capability map) | ✅ ported | `PhonePermissionsView` |
| Settings (device name, gate, permission level, unpair) | ✅ partial | subset of Android settings |
| Cross-device 2FA unlock (auth.challenge → approve) | ✅ ported | `ApproveView` |
| Files pushed to phone (share sheet) | ✅ ported | `FileReceiver`, `FilesView` |
| Computer: live mirror + tap-to-click + take-over | 🟡 basic | `ComputerView`; keyboard/drag/scroll input is a follow-up |
| Canvas / live widgets | 🟡 basic | `CanvasView` shows renders; the full `render_widget` DSL renderer is a follow-up |
| Voice (STT/TTS, push-to-talk, "Hey Cindro" wake) | ⛔ follow-up | daemon methods wired in the repository; UI not built |
| Home-screen widgets (WidgetKit) | ⛔ follow-up | Android uses App Widgets; iOS equivalent is WidgetKit |
| Background socket + push notifications | ⛔ platform gap | see below |

### Known platform gaps (not laziness — iOS constraints)

- **Background connection & notifications.** Android keeps the socket alive with a
  `dataSync` foreground service and posts *local* notifications with no Firebase. iOS does
  **not** allow a persistent background socket; real push needs **APNs** (the daemon's
  `push.register` path exists but is build-gated off). Until APNs is wired, the phone only
  receives `session.opened` / `file.offer` / `auth.challenge` while the app is foregrounded.
- **"Hey Cindro" wake word.** Android runs a mic foreground service; iOS has no equivalent
  always-listening background mode. This would become an in-app `SFSpeechRecognizer` mode
  with explicit UI, or be dropped.
- **Unsigned builds.** CI produces an **unsigned** `.ipa` (installable via AltStore /
  Sideloadly / a dev cert), mirroring Android's debug-signed APK. Signed TestFlight/App
  Store builds need Apple signing secrets — see `.github/workflows/ios-build.yml`.

## CI / releases

- **`.github/workflows/ios-build.yml`** — on a PR into `main`: `xcodegen generate` +
  `xcodebuild test` on the iOS Simulator. On a `v*` tag (created by `auto-release.yml` on
  merge to `main`): archive an unsigned device build, package `Cindro-<ver>.ipa`, and
  attach it to the GitHub Release — the same merge-is-the-release flow as the `.exe`, the
  AppImage, and the `.apk`.
- Runs on **GitHub-hosted `macos-latest`** (Actions minutes), the one deliberate exception
  to the repo's self-hosted-only CI rule, because iOS needs Xcode on macOS and the
  self-hosted fleet is Windows + Linux only.

## Security notes

- The Ed25519 seed lives in the **Keychain** (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
  not synced to iCloud) — the iOS analogue of Android's Keystore-backed store.
- The device channel is cleartext `ws://` on the LAN / Tailscale tailnet; it's
  authenticated + signed end-to-end (Ed25519), so an ATS exception is set in `Info.plist`
  exactly mirroring `android/.../network_security_config.xml`.
- BIOMETRIC-tier daemon calls (`settings.set`, `mirror.start`, `take_over.request`,
  `approval.respond`, `policy.add`, `mcp.add`) require a Face ID prompt in the calling
  ViewModel before the request, matching the Android tiering.
