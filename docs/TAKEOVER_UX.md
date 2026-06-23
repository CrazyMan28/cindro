# Take-over UX — "Jarvis is using your computer" (MATCH the Codex look)

Reference: user's screenshot of Codex desktop (Windows). TWO signals make it UNMISTAKABLE the agent
is driving — replicate both, exactly, in Jarvis (cyan-accented to match the HUD theme):

## 1. Top-center pill banner
A dark, rounded, slightly translucent pill near the TOP-CENTER of the screen:
`⚡ Jarvis is using your computer  ·  Esc to cancel`
- Near-black pill (rgba ~ #0A0E16 @ 0.92), white text, a 1px cyan (#29E7FF) hairline + soft glow,
  a separator dot, "Esc to cancel" slightly dimmed. (Codex shows "Codex is using your computer · Esc
  to cancel".)
- **Esc cancels the take-over immediately** and returns control.

## 2. Glowing cursor (the thing the user circled)
The agent pointer is drawn with a soft **blue/cyan radial GLOW HALO** (~36-44px, ~40% opacity,
blurred) centered on the pointer, plus a distinct Jarvis arrow sprite — visibly different from the
user's normal cursor. It **moves smoothly (lerp) to each agent position and pulses subtly** so you can
follow it.

## Where it renders
- **DESKTOP real-screen take-over (target=real):** upgrade `desktop/qml/DrivingOverlay.qml` — a
  FULL-SCREEN, input-transparent (click-through), top-layer LayerShellQt **Overlay** surface that draws
  (a) the top-center pill + Esc-to-cancel, (b) the glowing cursor halo + Jarvis sprite tracking the
  agent pointer from the `agent_pointer` bus (`~/.local/share/jarvis/agent_pointer.jsonl` / in-proc
  queue emitted by `input.py`). Esc (global, while active) -> daemon `take_over.cancel`. Optionally also
  switch the system XCURSOR theme to a warning theme for the duration (secondary signal).
- **CHROME take-over:** the Computer Use Bridge extension **content script injects a fixed-position
  glowing-cursor element** (same cyan glow + halo) that animates to the agent's click/move/scroll
  TARGET coordinates (the engine pushes target x,y to the extension over the WS bridge on each action),
  plus a small in-page chip "⚡ Jarvis is using this tab". So inside Chrome the mouse is visibly
  different AND moves to what it's doing — matching Codex's in-page cursor.
- **Agent NESTED desktop (co-work mode):** already uses the loud Bibata-Modern-Ice cursor; ALSO render
  the same banner + glow into the frames the phone/desktop live-stream, so the phone view is equally clear.

## Rules
- Take-over to START is biometric-approval-gated (unchanged). The banner + glow are ALWAYS shown for the
  entire duration of any real-screen or Chrome take-over.
- Esc cancels from desktop (global) and from the page (in-Chrome). Cancelling stops input + hides the overlay.
