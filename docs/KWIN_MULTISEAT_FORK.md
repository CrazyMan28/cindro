# Orin × KWin multi-seat fork — notes & spec (DO NOT LOSE)

> Created 2026-06-23 on the user's explicit instruction: "fork KDE, add all the
> features I wanted; first create notes on what the bug was and what I wanted so
> you don't forget." This file is the durable spec. A pointer lives in the
> auto-memory ([[jarvis-monorepo]]).

## STATUS (2026-07-10) — KEYBOARD FIXED: modifiers now tracked per seat

- ✅ **Keyboard-commands bug FIXED** (fork commit `ce0cea6`, branch `jarvis`).
  Symptom (user report): agent mouse worked on its own screen, but its
  *keyboard commands* "did something somewhere else". Root cause: the jarvis
  seat **never sent `wl_keyboard.modifiers`** — `JarvisSeat::key()` forwarded
  raw keycodes only, and Wayland clients do NOT derive modifier state from raw
  keys (the compositor must send it, per seat). So every client saw
  `modifiers=0` forever: `ctrl+v` typed a literal `v`, `ctrl+a` typed `a`,
  `shift+x` gave lowercase. Stock KWin does this in
  `keyboard_input.cpp` (`Xkb::updateKey` before the key event,
  `Xkb::forwardModifiers` after); the fork's DBus path skipped all of it.
  Fix in `src/jarvisseat.{h,cpp}`: the JarvisSeat owns its **own
  `xkb_state`** built from the same keymap it copies to the seat, updates it
  on every `key()`, and forwards changed `depressed/latched/locked/layout`
  after each key — same ordering as seat0. (Never reuse seat0's `Xkb`: that
  would mix the user's held modifiers into the agent's typing.)
- ✅ Also fixed while in there: keymap is now ensured **before the first
  keyboard focus** (an `enter` on a keymap-less keyboard is skipped/useless —
  this could eat keys entirely), with a default rules-based keymap fallback
  when seat0 has no keyboard (headless/`--virtual` runs); `refocusAt` logs the
  hit-tested window on change so routing is visible in the journal.
- ✅ Engine hardening (`computer-use/computer_use_mcp/jarvis_seat.py`):
  `available()` no longer caches a negative probe forever (was
  `lru_cache` — one probe before KWin registered the iface would silently
  exile ALL real-screen input to the shared-seat ydotool path = mixing).
  Negatives re-probe after 30 s; positives stick.
- ✅ **Verified nested** (`build/bin/kwin_wayland --virtual --width 1280
  --height 800 --no-lockscreen --socket <name> -- wev`, drive
  `/JarvisSeat` on the nested instance's **unique bus name** via
  `busctl --user list | grep <pid>`): with the fix, wev shows
  `modifiers depressed: Shift` after shift press, `utf8: 'A'` for shift+a,
  `depressed: Control` for ctrl — with the old lib, no modifiers event ever
  follows any key. Nested-test gotchas: pass `--no-lockscreen` (the nested
  KSldApp sees the logind session lock and covers the output with an internal
  greeter window that swallows every jarvis hit-test), and wrap the client in
  a script that runs `stdbuf -oL` (kwin's arg parser eats the flags, and
  block-buffered stdout loses the evidence).
- ⚠️ **Deploy staged, NOT yet live**: the built lib must be installed via
  `~/projects/kwin-jarvis-fork/deploy-libkwin.sh` (backup + atomic rename —
  auto-mode blocked overwriting the live compositor lib, and the running
  session keeps the old mmap anyway) and loads on the **next login** into
  "Plasma (Orin KWin fork)". After relogin, run the live smoke:
  `cd computer-use && env -u PYTHONPATH .venv/bin/python3 ../scripts/jarvis_seat_type_check.py`
  (types a mixed-case string + ctrl+d EOF into a scratch terminal via the
  jarvis seat only, then checks the file).
- ℹ️ Known limitations (accepted, by design or deferred): XWayland targets —
  X has ONE core keyboard focus following the user's activity, so agent keys
  into an X11 app can land at the user's focused X window (nothing X11 runs
  here in practice — checked: only xwaylandvideobridge; for X11 Chrome use
  the extension/CDP path). Runtime layout switches don't reach the jarvis
  seat (keymap copied once per session — relogin picks up a new layout). The
  jarvis seat's Caps/Num lock state is deliberately independent of seat0
  (the user's CapsLock must never mutate agent typing), and auto-repeat is
  off (rate 0) — the agent always sends discrete press/release pairs.

## STATUS (2026-06-26) — SHIPPED: agent drives the real KDE screen, clicks work

- ✅ Fork is the **real session compositor** ("Plasma (Orin KWin fork)" session via
  `~/.local/bin/jarvis-kwin-launch.sh`; stock "Plasma" = always-safe SDDM fallback).
- ✅ Engine `input.py` real-screen path drives `org.kde.KWin.JarvisSeat` (move/click/
  type) on the independent `jarvis` seat — **never** the user's `seat0`.
- ✅ **Click bug FIXED.** Symptom: agent move worked but ~95% of clicks didn't
  register on Qt apps. Root cause (found via `WAYLAND_DEBUG=1` on a test client):
  `JarvisSeat::refocusAt` passed the surface-LOCAL offset as `notifyPointerEnter`'s
  3rd arg, but that arg is the surface's **GLOBAL ORIGIN** (KWin builds
  `translate(-surfacePosition)` from it) → clients received `pos - local` =
  out-of-bounds → every click dropped. Fix: pass `pos - local`. Added an **atomic
  `pointerClick`** (refocus+motion+press+release in one DBus call); `input.py`
  routes clicks through it (the separate move+press+release path raced). Verified
  live: System Settings navigates reliably via the jarvis seat.
- ✅ Driving glow follows the jarvis pointer (`GlowCursor`, shrunk 84→56 so it
  doesn't block the model's screenshot view).
- ⚠️ **Deploy gotcha:** never `ninja install` while the fork is the LIVE compositor
  — it overwrites the mmap'd `libkwin.so` and SIGSEGVs the running session. Build is
  safe; install via **atomic rename** (`cp …/libkwin.so.6.7.0 dst.new && mv -f
  dst.new dst`) then **relogin** to load it. See the auto-memory
  `kwin-fork-install-crashes-live-compositor`.

## STATUS (2026-06-23) — multi-seat PROVEN in the fork
- ✅ KWin v6.7.0 cloned (`~/projects/kwin-jarvis-fork`), configured, **fully built**
  (`build/bin/kwin_wayland`), runs **nested** (`--wayland-display wayland-0 --socket <name>`).
- ✅ **2nd seat added + VERIFIED**: `wayland_server.cpp` creates `m_jarvisSeat =
  new SeatInterface(m_display, "jarvis", ...)`; `src/jarvisseat.{h,cpp}` is the
  `org.kde.KWin.JarvisSeat` DBus controller (movePointer/pointerButton/key/keyModifiers →
  hit-test via `input()->findToplevel` + `mapToInputSurface`, drive the jarvis seat directly).
  Compiles + links clean. `wayland-info` on the nested instance shows **TWO wl_seats: `seat0`
  AND `jarvis`** → the agent has its own independent pointer+keyboard at the compositor level.
- ✅ (was "REMAINING", all DONE 2026-06-26 — see the SHIPPED status above): (1)
  `input.py` wired to the JarvisSeat DBus; (2) fork deployed as the real compositor
  with stock fallback; (3) glow follows the jarvis pointer; (4) end-to-end verified —
  agent clicks+types with its own cursor, user's seat untouched.

## THE BUG (what's broken today)

When the Orin agent drives the user's **real KDE screen**, its input **mixes with
the user's** because everything shares **one Wayland seat**:

1. The agent's pointer/keyboard goes through a single `uinput` device that lands on
   **seat0** — the same seat as the user's physical mouse + keyboard.
2. A Wayland **seat = exactly one pointer focus + one keyboard focus + one drawn
   cursor**. So there is physically only ONE cursor and ONE "where keystrokes go."
3. Symptoms the user reported (verbatim intent):
   - "when it moves its mouse and I'm moving mine, it puts my mouse where its is"
     (they fight over the one cursor).
   - "when it types, its mouse could be over the search bar but it types where MY
     mouse is" — i.e. text goes to the **real keyboard focus** (follows the user's
     cursor/active window), NOT where the agent clicked.
   - Earlier: the take-over overlay (OnDemand keyboard) **stole the agent's typed
     text** — already fixed by making the overlay fully input-transparent + no
     keyboard, but the underlying one-seat problem remains.

This is NOT an Orin bug — it's that **KWin only ever creates one `wl_seat`** and
its input pipeline is hardwired to it.

## ROOT CAUSE (the real reason, confirmed)

- **wlroots (Sway)** supports **multiple seats** — a 2nd named seat gets its own
  cursor + focus (wayvnc uses transient seats; the Orin nested agent desktop
  already gets a separate seat/cursor/keyboard this way → ZERO mixing there).
- **KWin (KDE)** instantiates a **single `SeatInterface`**; `InputRedirection` is a
  singleton routing all input to that one seat; it renders one cursor. There is **no
  code path to create a second seat**. KWin assumes one human at the machine.
- Therefore: on the user's real KWin screen a separate cursor is impossible **with
  stock KWin**. The protocol allows >1 seat; KWin just never built it.

## WHAT THE USER WANTS (the goal of the fork)

A **separate virtual mouse + keyboard ("its own hand") for the agent ON THE REAL
KDE WAYLAND SCREEN**, fully independent of the user's:
- Agent has its **own cursor** that does NOT move/fight the user's cursor.
- Agent's **typing goes where the AGENT clicked**, never where the user's focus is.
- The user can keep using their own mouse/keyboard **at the same time, no mixing**.
- **No X11** (user explicitly refused X11/MPX, which would otherwise solve this).
- **No KDE reinstall** — run a forked `kwin_wayland` as a drop-in compositor, with
  stock kwin as fallback.
- Routing the user already chose: **"my screen" → real; "your own" → agent desktop;
  ambiguous → ask via `ask_user`.** (Already implemented in the daemon preamble +
  the `real_screen`/`computer_use` MCP servers.)
- The glow **"⚡ Orin is using this computer"** banner + big blue cursor must
  **stay on the whole turn** (until the model is done or the user stops) and track
  the AGENT's separate cursor. (Overlay stay-on + per-output + click-through already
  done; it must follow the NEW agent-seat cursor once the fork lands.)
- Optional but wanted: a way to **stop** (Esc / a kill switch) — needs the `input`
  group OR the fork can expose a stop path.

## THE FORK PLAN (add multi-seat to KWin)

Target: KWin/Plasma **6.7.0** (the user's actually-installed version —
`kwin-6.7.0-1.fc44`; NOT 6.6.5). Open source (LGPL), repo
`invent.kde.org/plasma/kwin`. **Cloned to `~/projects/kwin-jarvis-fork`** (shallow,
tag v6.7.0).

Changes required in KWin:
1. **Allow >1 `wl_seat`** — let KWin create a second `SeatInterface` named e.g.
   `jarvis` at runtime (today it's a singleton "seat0").
2. **Per-seat `InputRedirection`** — generalize the input router so pointer/keyboard
   **focus, enter/leave, and grabs are tracked per seat** (N seats, not 1).
3. **Second cursor rendering** — KWin draws one cursor; add a cursor layer/plane for
   the agent seat so its pointer is visible + independent.
4. **Injection protocol for the agent seat** — extend `org_kde_kwin_fake_input` /
   `zwp_virtual_keyboard_v1` (or a small custom Jarvis protocol) so the engine can
   feed pointer/keyboard events **to the `jarvis` seat specifically**, never seat0.
   The computer-use engine's `input.py` then targets this instead of host `uinput`.
5. **Focus model** — agent pointer enter/click drives the `jarvis` seat's pointer +
   keyboard focus on the SAME windows, independent of the user's seat. Handle apps
   that assume one seat (Qt6/GTK mostly cope; watch edge cases).

### Process / how to build + run it (no reinstall)
1. Clone KWin at the matching tag; stand up the full from-source build
   (Qt6 + KF6 + wayland/libinput/drm/etc. `-devel` deps — **needs `sudo dnf` once**,
   user must run the dnf line; that's the only hard blocker to starting).
2. Develop against a **nested KWin** (`kwin_wayland --windowed`) so a crash never
   touches the user's live session.
3. Implement #1–#5; prototype the `jarvis` seat + its cursor in the nested KWin.
4. Wire the engine `input.py` to inject into the `jarvis` seat (new injection path).
5. Point the user's session at the forked `kwin_wayland` (custom wayland-session
   entry or binary swap); **keep stock kwin as the fallback session**.
6. Maintain: rebase the fork on KWin updates.

### REFINED PLAN (LEAN — confirmed viable by reading the v6.7.0 API; NOT a 211-site refactor)
Key insight: **leave seat0 (the user) completely alone**; ADD a parallel `jarvis` seat and
**drive it directly** via its own API. No need to make `InputRedirection` seat-aware.
- **Create the 2nd seat:** in `WaylandServer::initDisplay()` right after
  `src/wayland_server.cpp:400`, add `m_jarvisSeat = new SeatInterface(m_display, "jarvis", m_display);`
  + a getter. It becomes a separate `wl_seat` global; clients bind a 2nd wl_pointer/wl_keyboard.
- **Drive it directly** (no InputRedirection changes) using `SeatInterface`'s public API
  (`src/wayland/seat.h`): `notifyPointerMotion/Enter/Leave/Button/Frame/Axis`,
  `setFocusedPointerSurface*`, `setFocusedKeyboardSurface`, `notifyKeyboardKey/Modifiers`,
  `setTimestamp`. For a move: hit-test the window under (x,y), `notifyPointerEnter(surface, …)`
  + `notifyPointerMotion`; for a click: `notifyPointerButton` + `notifyPointerFrame`; for typing:
  `setFocusedKeyboardSurface(surface)` + `notifyKeyboardKey(...)`. → text lands where the AGENT
  clicked, on the jarvis seat, **independent of seat0**.
- **Hit-test** the window/surface under the agent's global (x,y): reuse KWin's
  `InputRedirection::findToplevel(QPointF)` + `Window::surface()` + map global→surface-local
  (read-only reuse; the trickiest bit).
- **Injection IPC = DBus, NOT a new Wayland protocol** (avoids wayland-scanner codegen): add a
  small DBus iface on the forked kwin, e.g. `org.kde.KWin.JarvisSeat` with
  `movePointer(x,y)`, `pointerButton(btn,pressed)`, `key(keycode,pressed)`,
  `keyModifiers(...)`. The computer-use engine `input.py` real-screen path calls these via DBus
  instead of host `uinput`. (KWin already exposes DBus ifaces — see src/dbusinterface.* / the
  scripting + virtualkeyboard_dbus.*.)
- **Agent cursor visual = the existing Orin glow overlay** (the blue cursor the sidebar already
  draws), so KWin does NOT need to render a 2nd cursor. (Optional later: real KWin cursor via
  `Cursors::addCursor()`.)
- **Engine change:** `computer-use/computer_use_mcp/input.py` real path → call the JarvisSeat DBus
  instead of `_emit_abs`/ydotool when on the forked KWin; keep publishing session="real" for the
  glow. The daemon's `real_screen` MCP server then drives the jarvis seat → no mixing.

Scope of THIS lean version: ~a few hundred lines in kwin (2nd seat + DBus iface + hit-test glue) +
the engine input change. Far smaller than the full multi-seat refactor; the user's seat is never
touched so blast radius is much lower.

### IMPLEMENTATION RECIPE (exact API, ready to code once the base build is verified)
New file `src/jarvisseat.{h,cpp}` — a QObject DBus iface that owns/drives the jarvis seat:
```cpp
// jarvisseat.h
class JarvisSeat : public QObject {
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "org.kde.KWin.JarvisSeat")
public:
    JarvisSeat(KWin::SeatInterface *seat, QObject *parent=nullptr); // registers /JarvisSeat
public Q_SLOTS:                                  // Q_SCRIPTABLE DBus methods
    void movePointer(double gx, double gy);      // hit-test + enter/motion/frame on jarvis seat
    void pointerButton(uint button, bool pressed);
    void key(uint keycode, bool pressed);        // setFocusedKeyboardSurface + notifyKeyboardKey
    void keyModifiers(uint depressed, uint latched, uint locked, uint group);
private:
    KWin::SeatInterface *m_seat; QPointF m_pos;
};
```
movePointer(gx,gy) body (uses the SAME pattern KWin uses at input.cpp:2273):
```cpp
m_pos = QPointF(gx, gy);
Window *w = input()->findToplevel(m_pos);                       // InputRedirection::findToplevel
m_seat->setTimestamp(std::chrono::microseconds(/*now*/));
if (w && w->surface()) {
    auto [surface, local] = w->surface()->mapToInputSurface(w->mapToLocal(m_pos));
    m_seat->notifyPointerEnter(surface, m_pos, local);
    m_seat->notifyPointerMotion(m_pos);
    m_seat->notifyPointerFrame();
} else { m_seat->notifyPointerLeave(); m_seat->notifyPointerFrame(); }
```
pointerButton → `m_seat->notifyPointerButton(Qt::MouseButton(...), pressed?Pressed:Released); notifyPointerFrame();`
key → focus the surface under m_pos via `m_seat->setFocusedKeyboardSurface(surface)` then
`m_seat->notifyKeyboardKey(keycode, pressed?Pressed:Released, serial++)`.
- **wayland_server.cpp** (after :400): `m_jarvisSeat = new SeatInterface(m_display, QStringLiteral("jarvis"), m_display);`
  + `SeatInterface *jarvisSeat() const { return m_jarvisSeat; }` in the header.
- **Startup**: `new JarvisSeat(waylandServer()->jarvisSeat(), this);` (in DBusInterface ctor or main_wayland).
- **CMakeLists**: add `jarvisseat.cpp` to the kwin lib sources.
- **DBus reg pattern** (from dbusinterface.cpp:45): `QDBusConnection::sessionBus().registerObject("/JarvisSeat", this);`
- **Engine** (`computer-use/computer_use_mcp/input.py` real path): replace `_emit_abs`/ydotool with
  `qdbus`/`dbus-send` (or python-dbus) calls to `org.kde.KWin /JarvisSeat org.kde.KWin.JarvisSeat.movePointer …`.
  Keep `agent_bus.publish(..., session="real")` for the glow. Only do this when on the forked KWin
  (detect via the DBus iface existing).

### CODE MAP (v6.7.0, from a full source survey — the exact files to patch)
- **One seat created here:** `src/wayland_server.cpp:400` `m_seat = new SeatInterface(...)`;
  getter `WaylandServer::seat()` (`src/wayland_server.h:94`). Member `SeatInterface *m_seat`
  → must become a list/map keyed by name (`seat0`, `jarvis`). **211+ call sites** do
  `waylandServer()->seat()` assuming one — biggest surface.
- **Seat class:** `src/wayland/seat.{h,cpp}` (`SeatInterface`, owns one Pointer/Keyboard/Touch).
- **Input routing (singleton):** `src/input.{h,cpp}` `InputRedirection` (global `input()`),
  `pointer()/keyboard()/touch()`. Pointer focus → `src/pointer_input.cpp:~648`
  `seat->notifyPointerEnter(...)`; keyboard focus → `src/keyboard_input.cpp:259,262`
  `seat->setFocusedKeyboardSurface(...)`. Must become seat-aware (route per seat).
- **Cursor (FRIENDLY):** `src/cursor.{h,cpp}` — `Cursors` already holds `QList<Cursor*>` with
  `addCursor()`. Add the agent cursor here; per-seat *rendering* still needs the scene/output
  backend (`src/scene/workspacescene.*`, DRM/GL cursor plane).
- **Injection path:** `src/backends/fakeinput/fakeinputbackend.cpp` (`org_kde_kwin_fake_input`,
  ~15 methods) routes to one InputRedirection→seat. Extend it to bind a fake device to the
  `jarvis` seat. NOTE: `zwp_virtual_keyboard_v1` is NOT a server interface in KWin (only a DBus
  VirtualKeyboardManager) — so the agent-seat keyboard injection rides the fake_input/custom path.
- **Entry point / nested run:** `src/main_wayland.cpp` (`main`, opts `--virtual`,
  `--x11-display`, `--wayland-display`, `--width/--height`). **Safe dev:** run the fork NESTED
  under the user's KDE Wayland — `./kwin_wayland --wayland-display wayland-9 --width 1920 --height 1080`
  — so a crash never touches seat0/the live session.

### BUILD DEPS (Fedora 44 — USER must run this once; the only blocker to start compiling)
```
sudo dnf install cmake extra-cmake-modules \
  qt6-qtbase-devel qt6-qtdeclarative-devel qt6-qtwayland-devel qt6-qtsvg-devel qt6-qttools-devel \
  kf6-kconfig-devel kf6-kservice-devel kf6-kwindowsystem-devel kf6-ki18n-devel kf6-kcrash-devel \
  kf6-kdbusaddons-devel kf6-kglobalaccel-devel kf6-kguiaddons-devel kf6-kidletime-devel \
  kf6-kcolorscheme-devel kf6-kpackage-devel kf6-krunner-devel kf6-knotifications-devel \
  kdecoration-devel kwayland-devel plasma-wayland-protocols-devel breeze-devel aurorae-devel \
  wayland-devel wayland-protocols-devel libxkbcommon-devel libxkbcommon-x11-devel \
  mesa-libEGL-devel libepoxy-devel vulkan-devel libxcvt-devel libdrm-devel mesa-libgbm-devel lcms2-devel \
  libinput-devel libeis-devel systemd-devel libdisplay-info-devel \
  libxcb-devel xcb-util-devel xcb-util-keysyms-devel xcb-util-cursor-devel xcb-util-image-devel \
  xcb-util-renderutil-devel xwayland-devel libcanberra-devel libevdev-devel
```
Then build: `cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug && ninja -C build`
(package names are best-effort; the configure step will name any that differ).

### Honest cost / risk
- Realistically **weeks** of iterative work (slow compile→test loops; subtle
  per-seat focus/cursor bugs). Not hours.
- Blast radius = the **whole desktop** (KWin IS the compositor) → always test
  nested first; always keep stock-kwin fallback.

## FULL FEATURE WISHLIST (everything the user asked for this session — don't drop any)
- [x] Real-screen routing via a 2nd MCP server (`real_screen` = global :8794) — done.
- [x] kscreen-doctor hang → wl_output via pywayland — done.
- [x] spectacle screenshot auto-retry — done.
- [x] Overlay: all monitors, click-through, persists across virtual desktops,
      stays on whole turn, no keyboard steal — done.
- [x] Auto-arm overlay on real-screen activity — done.
- [x] `ask_user` when the screen is ambiguous (+ working chat card) — done.
- [x] schedule/memory/skills via MCP (engine tools) — done.
- [x] Memory page refresh-on-navigate — done.
- [x] In-Chrome glow + chip (extension content.js) — done (needs extension reload).
- [ ] **THE BIG ONE: separate agent cursor + keyboard on the REAL KDE screen, no
      mixing, no X11** → THIS FORK.
- [ ] After the fork: point the engine's real-screen input at the `jarvis` seat;
      make the glow follow the agent-seat cursor; expose a stop/Esc path.

## Fallback if the fork stalls (already working, no fork/X11)
The nested **Sway** agent desktop already gives the agent its own seat/cursor/
keyboard with **zero mixing**; make its live view full-screen on one monitor for a
"it has its own real screen" feel. (User wants the fork instead, but this is the
safety net.)
