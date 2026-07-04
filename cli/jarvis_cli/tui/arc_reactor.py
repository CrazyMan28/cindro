"""ArcReactorWidget — a terminal recreation of the desktop GUI's spinning-
wheel reactor (desktop/qml/ArcReactor.qml), not a generic spinner.

The QML draws, on a per-pixel Canvas: 36 rim tick marks rotating slowly
clockwise (every 3rd one longer), 6 short arc segments rotating faster
counter-clockwise, a 3-point triangle frame rotating slowly clockwise, a
pulsing filled core with a small bright "hot center" dot, and — in
"thinking" mode — 3 dots orbiting the whole assembly. This module mirrors
that exact structure (same radii fractions, same rotation directions, same
periods) but plots it into a monospace character grid via trigonometry
instead of hand-drawn ASCII art, so it reads as the SAME reactor rather
than a different, simpler animation.
"""

from __future__ import annotations

import math

from rich.text import Text
from textual.reactive import reactive
from textual.widgets import Static

# Theme.qml colors (desktop/qml/Theme.qml) — kept identical so the terminal
# reactor uses the same two cyans as the GUI one.
ACCENT = "#3DD6FF"         # Theme.accent — rings + core
ACCENT_BRIGHT = "#7FF4FF"  # Theme.accentBright — hot center + thinking dots


def _dir_char(dx: float, dy: float) -> str:
    """Pick a box-drawing character whose orientation best matches the
    on-screen direction (dx, dy) — used so ring ticks/arcs/edges read as
    radial or tangential strokes instead of undifferentiated dots. `dy`
    must already be aspect-corrected (i.e. in grid units) so the choice
    reflects the actual rendered slope, not the "real" (square) one."""
    if dx == 0.0 and dy == 0.0:
        return "•"
    adx, ady = abs(dx), abs(dy)
    if ady < adx * 0.5:
        return "━"
    if adx < ady * 0.5:
        return "┃"
    return "╲" if dx * dy > 0 else "╱"


class ArcReactorWidget(Static):
    """Three independently-rotating rings around a pulsing core, plotted
    into a character grid via cos/sin — the terminal analog of
    ArcReactor.qml. Set `.thinking = True` to layer the orbiting "thinking"
    dots on top (mirrors the QML's `thinking` property); `.spinning`
    freezes the three rings in place while the core keeps pulsing (and the
    thinking dots keep orbiting, if enabled) — same gating as the QML,
    where the core's SequentialAnimation is keyed only on `visible`, not
    `spinning`.
    """

    # ---- periods (ms), lifted straight from Theme.qml -----------------
    RING_SLOW_MS = 14000.0                 # Theme.ringSlow  — outer ticks
    RING_FAST_MS = 9000.0                  # Theme.ringFast  — middle arcs
    RING_INNER_MS = RING_SLOW_MS * 1.4     # 19600 — inner triangle
    PULSE_MS = 2200.0                      # Theme.pulse — core pulse
    ORBIT_MS = 1400.0                      # thinking-dot orbit (fixed in QML)

    TICK_MS = 100                          # animation tick rate

    # Terminal character cells are roughly twice as tall as they are wide
    # (a common monospace metric is ~10px wide x 18px tall: 10/18 ≈ 0.555).
    # Every polar->grid conversion below squashes its vertical (row)
    # component by this ratio so rings/core read as round circles rather
    # than tall eggs.
    CHAR_ASPECT = 10.0 / 18.0

    thinking: reactive[bool] = reactive(False)

    def __init__(
        self,
        size: int = 13,
        spinning: bool = True,
        thinking: bool = False,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.reactor_size = max(5, int(size))
        self.spinning = spinning
        self.thinking = thinking

        self._cols = self.reactor_size
        self._rows = max(3, round(self.reactor_size * self.CHAR_ASPECT))

        # rotation accumulators, degrees, mirroring the QML's own sense of
        # direction: outer/inner increase (clockwise), middle decreases
        # (counter-clockwise).
        self._outer_angle = 0.0
        self._middle_angle = 0.0
        self._inner_angle = 0.0
        self._orbit_angle = 0.0
        self._pulse_elapsed_ms = 0.0

        self._timer = None

        # lock the widget to exactly its computed character grid so the
        # trig-plotted shapes aren't stretched/cropped by layout.
        self.styles.width = self._cols
        self.styles.height = self._rows

    def on_mount(self) -> None:
        self._timer = self.set_interval(self.TICK_MS / 1000.0, self._tick)

    def pause(self) -> None:
        """Pause the ~100ms tick timer — call this alongside `.display =
        False` whenever the reactor is hidden (e.g. a tab loses focus), so a
        widget nobody can see doesn't keep ticking/re-rendering forever."""
        if self._timer is not None:
            self._timer.pause()

    def resume(self) -> None:
        """Resume the tick timer — call this alongside `.display = True`."""
        if self._timer is not None:
            self._timer.resume()

    def _tick(self) -> None:
        self._advance(self.TICK_MS)
        self.refresh()

    def _advance(self, dt_ms: float) -> None:
        """Advance all animation clocks by dt_ms. Factored out of the
        interval callback so tests can drive it deterministically without
        real-time waits."""
        if self.spinning:
            self._outer_angle = (self._outer_angle + 360.0 * dt_ms / self.RING_SLOW_MS) % 360.0
            self._middle_angle = (self._middle_angle - 360.0 * dt_ms / self.RING_FAST_MS) % 360.0
            self._inner_angle = (self._inner_angle + 360.0 * dt_ms / self.RING_INNER_MS) % 360.0
        # pulse runs regardless of spinning — QML gates it on `visible` only.
        self._pulse_elapsed_ms = (self._pulse_elapsed_ms + dt_ms) % self.PULSE_MS
        if self.thinking:
            self._orbit_angle = (self._orbit_angle + 360.0 * dt_ms / self.ORBIT_MS) % 360.0

    def render(self) -> Text:
        return self._render_grid()

    # ---- the actual QML->grid recreation -------------------------------

    def _render_grid(self) -> Text:
        cols, rows = self._cols, self._rows
        grid = [[" "] * cols for _ in range(rows)]
        styles = [[""] * cols for _ in range(rows)]

        cx = (cols - 1) / 2.0
        cy = (rows - 1) / 2.0
        # "available" radius — mirrors the QML canvas's `r = min(w,h)/2 - 1`.
        r = max(1.0, cols / 2.0 - 1.0)
        aspect = self.CHAR_ASPECT

        def plot(real_x: float, real_y: float, ch: str, style: str) -> None:
            col = round(cx + real_x)
            row = round(cy + real_y * aspect)
            if 0 <= row < rows and 0 <= col < cols:
                grid[row][col] = ch
                styles[row][col] = style

        # ---- outer ring: 36 rim ticks, every 3rd longer, slow CW -------
        outer_rot = math.radians(self._outer_angle)
        ticks = 36
        for i in range(ticks):
            a = (i / ticks) * math.pi * 2 + outer_rot
            long = i % 3 == 0
            r0 = r * (0.80 if long else 0.88)
            r1 = r * 0.96
            dx, dy = math.cos(a), math.sin(a) * aspect  # radial direction
            ch = _dir_char(dx, dy)
            style = ACCENT if long else f"dim {ACCENT}"
            steps = 2 if long else 1
            for s in range(steps + 1):
                rr = r0 + (r1 - r0) * (s / steps)
                plot(math.cos(a) * rr, math.sin(a) * rr, ch, style)

        # ---- middle ring: 6 arc segments, radius 0.66r, fast CCW --------
        middle_rot = math.radians(self._middle_angle)
        segs = 6
        seg_step = math.pi * 2 / segs
        r_mid = r * 0.66
        samples = 4
        for i in range(segs):
            a0 = i * seg_step + 0.18 + middle_rot
            a1 = a0 + seg_step - 0.55
            for s in range(samples + 1):
                a = a0 + (a1 - a0) * (s / samples)
                dx, dy = -math.sin(a), math.cos(a) * aspect  # tangential
                ch = _dir_char(dx, dy)
                plot(math.cos(a) * r_mid, math.sin(a) * r_mid, ch, f"bold {ACCENT}")

        # ---- inner triangle frame: radius 0.42r, slow CW ----------------
        inner_rot = math.radians(self._inner_angle)
        r_in = r * 0.42
        verts = []
        for i in range(3):
            a = (i / 3) * math.pi * 2 - math.pi / 2 + inner_rot
            verts.append((math.cos(a) * r_in, math.sin(a) * r_in))
        for i in range(3):
            x0, y0 = verts[i]
            x1, y1 = verts[(i + 1) % 3]
            edge_dx = x1 - x0
            edge_dy = (y1 - y0) * aspect
            ch = _dir_char(edge_dx, edge_dy)
            length = math.hypot(edge_dx, edge_dy)
            steps = max(2, int(length * 1.5))
            for s in range(steps + 1):
                t = s / steps
                plot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, ch, ACCENT)

        # ---- core: filled pulsing disc + smaller constant hot center ---
        # Sequential 0.82->1.12->0.82 InOutSine over PULSE_MS collapses to
        # a plain cosine of the same period/amplitude/midpoint.
        t = self._pulse_elapsed_ms / self.PULSE_MS
        scale = 0.97 - 0.15 * math.cos(2 * math.pi * t)
        core_r_base = self.reactor_size * 0.15   # QML: coreWrap width*0.5 = size*0.15
        core_r = core_r_base * scale             # the pulsing Rectangle's own scale
        hot_r = core_r_base * 0.5                # QML: hot dot is size*0.075, NOT scaled
        core_style = f"bold {ACCENT}" if scale >= 0.97 else ACCENT
        for row in range(rows):
            for col in range(cols):
                real_dx = col - cx
                real_dy = (row - cy) / aspect
                dist = math.hypot(real_dx, real_dy)
                if dist <= hot_r:
                    grid[row][col] = "●"
                    styles[row][col] = f"bold {ACCENT_BRIGHT}"
                elif dist <= core_r:
                    grid[row][col] = "●"
                    styles[row][col] = core_style

        # ---- thinking: 3 dots orbiting the whole reactor, on top -------
        if self.thinking:
            orbit_r = self.reactor_size * 0.52
            for i in range(3):
                theta = self._orbit_angle + i * 120.0
                a = math.radians(theta - 90.0)  # 0 == straight up, like QML
                plot(math.cos(a) * orbit_r, math.sin(a) * orbit_r, "•", f"bold {ACCENT_BRIGHT}")

        text = Text(no_wrap=True)
        for row_idx in range(rows):
            for col_idx in range(cols):
                text.append(grid[row_idx][col_idx], style=styles[row_idx][col_idx] or None)
            if row_idx < rows - 1:
                text.append("\n")
        return text
