# Jarvis — Computer Use: what it is, how it works, how it compares

> **File:** `/home/kihi2024/projects/computer_use/docs/COMPUTER_USE.md`
> **Repo root (`pwd`):** `/home/kihi2024/projects/computer_use`
> **Engine on:** `:8794` (computer-use MCP) · per-session nested engines on `:8810+`
> **Last verified live:** 2026-06-23 (KDE Wayland, 3 monitors, unlocked session)

---

## ✅ Status — what's built & verified

- [x] **Computer-use engine is a real MCP server** (`:8794`, v0.2.0) — `/health` ok, KDE active, ydotoold + Chrome extension connected
- [x] **Now the UPGRADED monorepo engine** serves `:8794` (was the legacy `~/projects/mcp/computer_use` copy — repointed `computer-use-mcp.service`)
- [x] **Brain drives the hands via MCP, no buttons** — chat auto-spawns a desktop and the model calls the tools (verified for claude + codex)
- [x] **Type A — nested "agent" desktop (co-work):** per-session headless Sway + isolated engine; input goes to the nested compositor, never your real seat
- [x] **Type B — real-screen takeover:** approval-gated, glowing cursor + "Jarvis is using your computer · Esc to cancel" banner **on all 3 monitors** (overlay surfaces verified per-output; pointer feed verified end-to-end)
- [x] **Type C — in-browser (Chrome CDP bridge):** `browser_*` tools (navigate/click/type/eval/snapshot/screenshot)
- [x] **Multi-monitor correct:** engine maps the full virtual desktop (bbox `6400×1570`); overlay maps global→per-monitor and culls the glow off-screen
- [x] **Re-exported through Jarvis-MCP** (`:8797`, 37 computer-use tools incl. `ask_user`) and registered into codex + claude CLIs
- [x] **Brain isolation (Wave 6)** — the co-work brain sees ONLY the nested engine, never your global MCP servers / real desktop. codex: private `CODEX_HOME` + `--ignore-user-config`; claude: `--strict-mcp-config`. *Verified live: codex "open chrome" lands on the nested `HEADLESS-1`, never touches your real KDE/Chrome; no hand-desktop, no FAULTs.*
- [x] **Chrome isolation (Wave 6)** — agent-mode chromium launches get a private `--user-data-dir`, so they open inside the agent desktop instead of hijacking your real Chrome window.
- [x] **Conversation memory (Wave 6)** — both brains resume their thread/session each turn (codex `exec resume`, claude `--resume`). *Verified: turn 2 recalls turn 1.*
- [x] **Queued follow-ups (Wave 6)** — a message sent while the brain is mid-turn is queued + flushed on completion (no more "brain is busy").
- [x] **`ask_user` tool (Wave 6)** — the model asks YOU a question with tappable answers (chat card) instead of hardcoding choices. *Verified: ask-bus round-trip PASS.*
- [x] **Self-management via MCP (Wave 7)** — the model can **schedule** (`schedule_task`/`list_schedules`/`cancel_schedule`), write its own **memory** (`remember`/`recall`/`forget`), and author its own **skills** (`create_skill`/`list_skills`/`invoke_skill`) — all MCP tools on the engine, proxied to jarvisd. *Verified live: codex remembered a fact + scheduled a recurring task, both landed in the daemon.*
- [x] **No more "desktop tool not allowed" cancel (Wave 7)** — any codex session with a computer-use MCP is forced into the no-approval/full-access drive contract + isolated config, so it never auto-cancels a tool call. *Verified: fresh session opened + played Spotify, no fault.*
- [ ] **Visual confirmation of the glow/banner pixels** — *cannot* be screenshotted (wlr-layer-shell + nested video are uncapturable); needs **your eyes**. Bigger blue cursor now shows on the real-screen overlay AND over the agent-desktop video (Computer page) with a "Jarvis is using this desktop" banner.
- [ ] **Dedicated UI-grounding model** (see "What next") — currently relies on the brain's own vision
- [ ] **WebRTC (smooth 30fps) phone video** — today it's MJPEG (~5–10fps)

---

## 1. What "computer use" actually is

"Computer use" = giving an AI model **hands and eyes on a real computer**: it can **see** the screen (screenshots / a video stream) and **act** on it (move the mouse, click, type, scroll, drag, run keys, drive a browser). The loop is:

```
screenshot ──► model looks at pixels ──► decides an action ──► tool call (click x,y / type) ──► screen changes ──► screenshot ──► …
```

The model isn't given special OS access — it works the way a person does: look at the screen, point, click, type. That's what makes it general (it can use *any* app, not just ones with an API) and also what makes it fragile (it depends on the model correctly *reading* the pixels).

---

## 2. How Jarvis's computer use works

Jarvis keeps the proven Python/FastMCP engine and wraps it in a daemon. Concretely:

**Eyes (capture)**
- wlroots/nested desktops: `grim` / `wlr-screencopy`
- KDE real screen: `spectacle` fallback (grim is unreliable on KWin)
- Live: the engine serves `/video/frame` (one JPEG) and `/video/stream` (MJPEG) — this is what the phone watches

**Hands (input)** — three different injectors depending on the target:
- **Real seat:** a virtual **uinput absolute pointer** (evdev) for the mouse + **ydotool** for the keyboard → pixel-accurate, works under both KDE and Sway
- **Nested agent desktop:** `swaymsg seat - cursor …` for the pointer + `zwp_virtual_keyboard_v1` for keys → isolated inside the nested compositor (ydotool/uinput can't reach it)
- **Browser:** Chrome DevTools Protocol via a small MV3 extension

**Coordinate spaces** (you can address pixels three ways):
- `image` — coordinates measured on the **last screenshot** (default; staleness-checked)
- `desktop` — **global** virtual-desktop pixels across all monitors
- `output:NAME` — pixels relative to one monitor's top-left (e.g. `output:HDMI-A-1`)

**Tools** (~32): `desktop_screenshot`, `mouse_move/click/drag`, `scroll`, `type_text`, `key_press`, `window_list/activate/set/close`, `clipboard_get/set`, `app_launch/list`, `session_info`, `desktop_calibrate`, plus the `browser_*` family.

---

## 3. The three TYPES in Jarvis (and why)

| Type | Where it acts | Isolation | When to use |
|---|---|---|---|
| **A · Nested agent desktop** | A headless Sway it spawns per session | **Total** — its own compositor/seat; you keep your screen | Co-work in parallel; let it grind while you work |
| **B · Real-screen takeover** | Your actual desktop (real seat) | None — *your* cursor; gated + glowing banner + Esc | "Do this *here*, on my screen, now" |
| **C · Browser (CDP)** | A Chrome tab | Tab-scoped, DOM-accurate | Web tasks where DOM beats pixels |

Type A is the headline feature — most local "computer use" tools only do Type B (drive your one real screen), so the agent fights you for the cursor.

---

## 4. Types of computer use *in general* (Jarvis vs. the other approaches)

There are roughly **five architectural families**. Jarvis is primarily **#1 + #4**, with **#5** for the browser:

1. **Screenshot + coordinate (pixel/VLM)** — model sees pixels, clicks x,y. Most general, app-agnostic. *What Jarvis + Anthropic/OpenAI computer use do.* Weakness: accuracy depends entirely on the model's vision.
2. **Accessibility tree / UI automation API** — read the OS's a11y tree (AT-SPI / UIAutomation), act on named elements. More reliable, less general; breaks on custom-drawn UIs.
3. **DOM / browser-protocol (CDP/Playwright)** — for web only: select real elements, no guessing. Very reliable *but web-only*. *Jarvis Type C.*
4. **Virtual/remote display (VNC / nested compositor / VM)** — give the agent its **own** display to act in. Isolation + parallelism + safe to record. *Jarvis Type A (nested Sway).* Operator/Cua use cloud VMs for the same reason.
5. **Raw input injection (xdotool/ydotool/uinput)** — low-level key/mouse events with no model in the loop; the building block the above sit on. *Jarvis uses uinput/ydotool under the hood.*

**The trade-off:** pixel/VLM (#1) is the most general but least precise; a11y/DOM (#2/#3) is precise but narrow. Jarvis hedges by doing pixel for the desktop **and** CDP for the browser, and by adding a virtual display (#4) for safety.

---

## 5. Other computer-use options out there

**Hosted / commercial**
- **Anthropic Computer Use (Claude)** — the reference pixel+coordinate API; runs in a sandbox/VM you host.
- **OpenAI Operator / Computer-Using Agent (CUA)** — cloud-VM browser agent.
- **OpenAI Codex (desktop/cloud)** — coding co-worker; the takeover look Jarvis matches.
- **Google Project Mariner** — Chrome-based agent.

**Open source — desktop/OS**
- **UI-TARS (ByteDance)** + **UI-TARS-desktop** — a *dedicated UI-grounding VLM*; strongest at "where exactly to click."
- **OmniParser (Microsoft)** — turns a screenshot into labeled clickable elements (a grounding *helper*, pairs with any LLM).
- **Agent-S / Agent-S2 (Simular)** — agentic computer-use framework.
- **Open Interpreter (OS mode)**, **self-operating-computer**, **Agent.exe** — simpler local drivers.
- **c/ua ("Cua")**, **Skyvern** — sandboxed VM / workflow-oriented.

**Open source — browser-only**
- **browser-use**, **Playwright/Puppeteer MCP**, **Selenium**, **Stagehand**.

**Raw layer**
- **ydotool / xdotool / uinput / wlroots virtual-pointer** — the input primitives (Jarvis builds on these).

---

## 6. How good is it? — **7.5 / 10**

**Where it's strong (the harness):**
- ✅ Genuinely **isolated co-work** (nested compositor) — rare for a *local* tool; most only drive your one screen.
- ✅ **Works on both KDE (KWin) and Sway/wlroots**, pixel-accurate via uinput — broad Linux Wayland coverage.
- ✅ **Multi-monitor correct** (global mapping + per-output overlay), **visible+gated takeover**, **phone streaming**, **browser CDP**, **exposed as its own MCP**.
- ✅ Real engineering hygiene: per-session engines, ready-gates, orphan sweeps, audit log, injection gating.

**Where it's average / honest gaps:**
- ⚠️ **Grounding = the brain's own vision.** Clicking accuracy is only as good as Claude/GPT reading the screenshot. No dedicated grounding model (UI-TARS/OmniParser) yet → misclicks on dense/custom UIs.
- ⚠️ **Capture quirks on KDE** (grim unreliable → spectacle; locked sessions blank). Video is MJPEG, not WebRTC.
- ✅ **Any brain drives it** — **codex (gpt-5.5), claude, and api** all work via the model picker. The daemon auto-launches codex with `--sandbox danger-full-access -c approval_policy="never"`, so it does **not** auto-cancel MCP calls (that only happened with a narrower sandbox we don't use). Verified live: codex **and** claude both grim-proven (`/tmp/autospawn_{codex,claude}.png`). The `api` brain drives too for any tool-call-capable model.
- ⚠️ **Glow/banner pixels unverified by automation** (layer-shell uncapturable) — needs human eyes.

**Why not higher:** the *intelligence* of acting is delegated to a general VLM, so it can't match a purpose-built grounding model on raw click precision. **Why not lower:** the surrounding system (isolation, multi-compositor, multi-monitor, phone, MCP-in/out, safety) is well past what a "codex + computer-use MCP" setup gives you.

---

## 6b. `session.opened` — new sessions surface everywhere

Creating a session from **any** surface (phone, desktop, MCP/headless, or the
scheduler) now broadcasts an **unsolicited** frame so the apps OPEN/FOCUS that
session's chat — `session.create` no longer only answers its caller. This mirrors
the existing `auth.event` / `file.offer` fan-out, so it is low-risk and
self-consistent.

**The frame (identical on both channels):**

```json
{"v":1,"event":"session.opened","data":{"session_id":"<id>","title":"<title>"}}
```

**Where it fires:** in `ControlServer::createSession()` at the single shared
success exit (after the brain is wired and the session is fully live), so it
covers BOTH the control-WS caller path and the scheduler path. All early-error
returns are above that point, so the event only fires on a real, live session.

**Which channels:**
- **Control WS** (`broadcastSessionOpened`) → every connected desktop control
  client. The desktop's `Bridge` opens that session (loading its history) and
  `Main.qml` raises/focuses the window + navigates to the Chat page (index 0).
  A desktop-initiated create is guarded (`sid != m_sessionId`) so it does not
  double-open its own echo.
  **No sidebar running ⇒ no-op:** if `jarvis-sidebar` isn't running there is no
  control-WS client subscribed, so the daemon's broadcast simply reaches nobody.
- **Device WS** (`DeviceServer::onSessionOpened`) → **every authed phone**. Unlike
  `file.offer` this is **not** gated on `subscribedSessions`: a brand-new session
  id can't be subscribed yet, so it is delivered to all authed devices. A
  foreground app collects it and deep-links into `Routes.chat(session_id)`.
- **FCM (optional)** → a `kind:"session_opened"` data push (`{title:"New session",
  body:<title>, data:{kind:"session_opened", session_id}}`) to every registered
  push token, so a backgrounded phone can surface the new chat. Tapping the
  notification deep-links into that session's chat via the existing
  `EXTRA_SESSION_ID` path (no special-casing in `JarvisNotifier`).

**Proof:** `scripts/session_opened_ws.py` connects to the control WS, calls
`session.create`, and asserts an unsolicited `session.opened` frame arrives whose
`data.session_id` matches the returned id (`=== session.opened PASS ===`).

---

## 7. What next

1. **Add a grounding pass** — pipe screenshots through **OmniParser** (or distill **UI-TARS**) to hand the brain *labeled* elements instead of raw pixels → biggest single accuracy win.
2. **WebRTC video** (xdg-desktop-portal ScreenCast → GStreamer `webrtcbin`) for smooth 30fps phone viewing.
3. *(optional)* **codex app-server protocol** instead of `codex exec` — codex already drives computer-use fine via `exec` + the full-access sandbox; the app-server would just give richer streaming/approvals, not new capability.
4. **Self-healing actions** — verify each click landed (diff before/after screenshot) and retry/replan on failure.
5. **A capture path that survives lock/layer-shell** so the takeover overlay can be self-verified without a human.
6. **Per-element a11y (AT-SPI) hints** on KDE to complement pixels (hybrid #1+#2).

---

*Honest note: the per-tool-call capability (move/click/type) is the same MCP whether you use Jarvis or plain codex/claude. Jarvis's value is the **environment + control surface** around those calls — isolation, visibility, phone reach, orchestration, and being callable by other agents.*
