# Jarvis — Voice Mode, Generative Renderer, KDE Widget & Connectors (Roadmap)

Status: **PLANNED / not yet built.** Captured 2026-06-24 from the user's vision so it
isn't forgotten. Build incrementally; **test each piece before claiming done.**

This sits on top of the existing Jarvis monorepo (`~/projects/computer_use`):
Qt6/C++ daemon `jarvisd` + `jarvis-sidebar` desktop, Python computer-use engine,
Android app, Chrome extension. Voice plumbing ALREADY exists: daemon `voice.stt` /
`voice.tts` (Mistral Voxtral), phone `VoiceController` + voice settings. We extend
from there.

---

## 1. Voice Mode ("the spinny thing")  — talk to Jarvis, hands-free
A dedicated **voice interface**: a central animated **orb / spinner** you talk into.
- **STT + TTS loop**: push-to-talk (or wake/always-listen) → STT → Jarvis turn →
  TTS spoken reply. The orb reacts: idle pulse, listening (ripple on mic level),
  thinking (spin + the whimsical phrases — see the funny-status work), speaking
  (waveform). Esc / tap to stop.
- **Surfaces**: (a) a full-window mode in `jarvis-sidebar` (a `VoiceMode.qml`
  overlay/page centered on the orb), and (b) launchable from the KDE widget (§3).
- **Commands it must nail**: "what's on my screen / my main?" → screenshot the real
  screen → Jarvis summarizes aloud. "Summarize this." "Open X." etc.
- **Reuse**: daemon `voice.stt`/`voice.tts`; add a desktop `VoiceController` (mirror
  the Android one) + mic capture (QtMultimedia `QAudioSource`) + playback.

## 2. Generative Renderer — Jarvis pops up CUSTOM widgets around the orb
The headline feature: Jarvis can **render custom UI on the fly**, arranged around the
orb in Voice Mode (and in the app).
- Example: say **"show me a duck"** → Jarvis emits widget code → a **custom duck
  widget** appears next to the orb. "Show my calendar" → a calendar card. "Graph
  this" → a chart.
- **Mechanism (safest path)**: Jarvis returns a **widget spec** the app renders. Two
  options to evaluate:
  1. **Constrained QML**: Jarvis emits a *restricted* QML snippet; the app loads it
     via `Qt.createQmlObject` / a `Loader` into a sandboxed item. RISK: arbitrary QML
     = code exec — must whitelist allowed types (no `Process`, no file/network), run
     in a locked-down context. Prefer a **vetted component library** Jarvis composes
     from (Card, Text, Image, Chart, List, Canvas-draw) via a JSON spec, NOT raw QML.
  2. **JSON widget DSL** (recommended v1): Jarvis returns `{widget:"duck", props:{…}}`
     or a small declarative tree (`{type:"column", children:[…]}`) that a trusted
     QML renderer interprets. Safe, deterministic, extensible. "Show me a duck" maps
     to a `canvas`/`image` node Jarvis fills in.
- **Transport**: a new normalized brain event kind `widget` (or an MCP tool
  `render_widget(spec)`) the daemon forwards to the app; the app mounts it around the
  orb / in a "canvas" panel. Widgets are dismissable, stackable.
- **Same renderer reused** in the Chrome side panel and phone where feasible.

## 3. KDE Plasma Widget (plasmoid)
A native **Plasma 6 applet** (`kde-applet/` in the plan) that:
- Shows Jarvis status + a button to **toggle the sidebar** and to **launch Voice Mode**.
- Optional: tiny orb in the panel that pulses when Jarvis is active.
- Plasmoid = QML `metadata.json` + `main.qml`; talks to `jarvisd` control WS.

## 4. Voice picker in Settings
- A **TTS voice selector** in desktop + phone Settings. Daemon `voice.tts` already
  takes a `voice` param; add `voice.list_voices` (enumerate Voxtral/engine voices) and
  persist the choice (SettingsStore `tts_voice`). Wire the existing phone voice
  settings + add to desktop SettingsPage.

## 5. Connectors — Google Drive / Docs / Calendar / Gmail (+ more)
Let Jarvis read/act on the user's Google services.
- **Path**: add them as **MCP servers** (OAuth-backed) the user enables in Settings —
  fits the existing MCP registry + the new "paste/enable MCP" flow. Either use
  existing community Google MCP servers or a small OAuth bridge.
- Commands: "what's on my calendar", "summarize this doc", "draft an email", "find my
  file X in Drive". Calendar feeds the "today" digest.
- Gate writes (send email / edit doc) behind the approval tier.

## 6. "What's on my screen" + ambient summaries (voice)
- Voice command → real-screen screenshot (real_screen MCP) → Jarvis vision summary →
  spoken + a widget card. Ties Voice Mode + Renderer + computer-use together.

---

## Suggested build order (each its own wave, tested before the next)
1. **Voice picker in Settings** (small; foundation for voice) + `voice.list_voices`.
2. **Desktop Voice Mode v1**: orb + STT/TTS loop + "what's on my screen" summary.
3. **Generative Renderer v1**: JSON widget DSL + a `render_widget` MCP tool / `widget`
   event + a safe QML interpreter with a starter component set (card/text/image/
   canvas/list/chart) → "show me a duck".
4. **KDE plasmoid** (toggle sidebar + launch Voice Mode).
5. **Google connectors** (Calendar first, then Docs/Drive/Gmail) via OAuth MCP.
6. **Renderer v2**: richer components, Jarvis-authored canvas drawings, persistence.

## Risks / decisions to settle first
- **Renderer security**: do NOT eval arbitrary QML/JS from the model. Commit to the
  JSON DSL + vetted component set. Revisit only if the DSL proves too limiting.
- **Always-listen vs push-to-talk**: start push-to-talk (privacy + simplicity).
- **STT/TTS latency + voice quality**: measure Voxtral round-trip; consider local STT
  if too slow.
- **Google OAuth**: tokens are secrets → SettingsStore secrets.json (0600), never git.

See [[jarvis-monorepo]] and [[kwin-multiseat-fork]] for the surrounding architecture.
