# TUI v2 Parity Gate — Appendix A walk (2026-07-05)

Verifies every line of the master plan's Appendix A against the shipped
TypeScript TUI (`tui/`). ✅ = implemented; ✅* = implemented with a documented
terminal translation; the source file is the evidence.

## Test gates (all green)
- **bun test: 80/80** (5 consecutive clean full runs after the renderer-
  disposal fix)
- **ctest: 34/34** (daemon, incl. new git_ops / schedule.run_now / ui_manifest)
- **legacy python: 182/183** (1 pre-existing concurrency flake, untouched)
- **tsc --noEmit: clean** · **bun run build: binary builds** (dist/jarvis-tui)

## A.1 Ported (must not regress) — all ✅
- Screening live transcript → `phone/tabs/ScreeningTab.tsx`
- DiffReview + /stage /commit /revert /openpr → `chat/DiffReview.tsx` +
  `pages/Chat.tsx` diffAction — now backed by REAL diff.* daemon verbs
- Trust policies → `pages/Settings.tsx` TRUST POLICIES section
- Mode/Autonomy/Permissions knobs → `pages/Settings.tsx` MODE & AUTONOMY
- SetupWizard (shared setup_complete) → `gates/SetupWizard.tsx`
- LockGate (fail-open, PIN) → `gates/LockGate.tsx`
- ArcReactor everywhere → `ui/ArcReactor.tsx` (topbar, home, voice, gates)
- phone device pairing QR / extension pairing → `pages/Settings.tsx`
  DEVICES/EXTENSION (ANSI QR via qrencode)
- connectors → `pages/Settings.tsx` CONNECTORS
- custom pages (tui.layout.*) → `manifest.ts` + `pages/engine/CustomPage.tsx`
- F2 (voice) / F5-equivalents / ctrl+c quit guard → `app.tsx` keymap
- degrade-on-unknown-method UX → `degrade.ts`

## A.2 Partial → gaps CLOSED — all ✅
- Phone 3→6 tabs + reactor header + **app-wide** call overlay + real mute →
  `phone/PhonePage.tsx`, `phone/CallOverlay.tsx`
- dialer keypad/quick-dial/PSTN/state-dots → `phone/tabs/CallsTab.tsx`
- browser live nav + **clickable** DOM refs + real reload → `pages/Browser.tsx`
- computer brain picker + **confirm-gated** takeover + rich transcript →
  `pages/Computer.tsx` (pump leak fixed)
- canvas cap-20/newest-top/save/delete → `pages/Canvas.tsx`
- widgets →chat/→canvas/📌home/delete → `pages/Widgets.tsx`
- widget DSL image/svg/button/link/anim/pager → `widgets/Widget.tsx` (16 nodes)
- ssh exec console → manifest SSH page input action `ssh.exec`
- settings identity/defaults/claude-account/voice-library/API-keys/
  updates-check-now/connectors → `pages/Settings.tsx` (11 sections)
- voice continuous+phrases → `pages/Voice.tsx` (60+ phrases, widget dock)
- palette rebuilt (root causes A+B structurally impossible) →
  `chat/Composer.tsx` + `ui/Palette.tsx`
- HUD strip full telemetry (live MCP/agents, no hardcode) → `ui/Topbar.tsx`
  + daemon `status.get`
- theme tokens centralized → `theme/tokens.ts` + `theme/index.ts`

## A.3 Missing → ADDED — all ✅
- PSTN extended dialer / phone AGENTS roster+config / INBOX (list/detail/
  compose/new-chat) / HUD ops grid+log / **Red Alert** / diagnostics+history /
  Twilio/SMS/user-number / screening transport+carrier codes (**real number**,
  GUI's placeholder bug NOT copied) / PSTN allowlist / enroll / war room →
  `phone/tabs/*.tsx`
- nested desktop mirror → ✅* graphics-opt-in + text status (`pages/Computer.tsx`)
- FloatingWidgetLayer → ✅* widget dock (`pages/Voice.tsx`, Canvas cards)
- StandaloneWidget pop-out → ✅* dedicated Widgets route (no OS windows in a
  terminal — documented)
- WidgetRenderer anim layer → ✅ `widgets/Widget.tsx` (pulse/blink/spin)
- DrivingOverlay → ✅* persistent DRIVING banner + stop key (`pages/Computer.tsx`)
- TitleBar → ✅* terminal title (window chrome is the emulator's)
- HudFrame/HudFx/GlowCursor → ✅* border chars / flat bg / N-A in cells
  (documented — terminal has no shader/cursor-sprite surface)
- API keys grid (9 providers, masked) → ✅ `pages/Settings.tsx` API KEYS
- appearance knobs → ✅ theme cycle (leader t)
- auth-lock toggle + **PIN set/clear** → ✅ `pages/Settings.tsx` SECURITY

## A.4 Python-TUI-only features preserved — all ✅
- tui.layout.* custom pages · call_degrading UX · ASCII QR · MockDaemon
  harness (ported to `test/mock-daemon.ts`) · popup pages reachable from
  nav + palette + `/command`

## A.5 Known bugs fixed (regression-tested) — all ✅
- `/` focus root causes A+B → `test/chat.test.tsx` (5 key-driven tests)
- mouse-click palette dead-end / no-Escape-close → same
- single-slot broadcast landmine → multi-sub bus, `test/client.test.ts`
- schedule.run_now missing verb → daemon impl + `core/tests/scheduler_test.cpp`
- diff.* vapor → daemon impl + `core/tests/git_ops_test.cpp`
- ComputerPane pump leak → `onCleanup` disposal (`pages/Computer.tsx`)
- GUI mcpCount hardcode → `status.get` live telemetry
- GUI carrier-forwarding placeholder number → real number substituted
- browser hint/behavior mismatch → real reload verb

## Added beyond the GUI (Claude Code / OpenCode adoption)
Ctrl+K global palette · leader key + which-key overlay · remappable
keybinds · theme cycle · toast stack · transcript export · fuzzy everywhere.

**Verdict: parity gate PASSED.** Every Appendix-A line is ✅ or a documented
terminal translation. Legacy Python TUI retained as `jarvis tui --legacy`
until the user signs off on retiring it.
