"""Structural tests for ArcReactorWidget — the terminal recreation of the
desktop GUI's ArcReactor.qml spinner. No pixel/visual assertions: just that
it mounts cleanly, renders something non-empty, `.thinking` toggles without
error, and the animation clocks actually advance (with `spinning` gating
verified the same way the QML gates its RotationAnimators)."""

from __future__ import annotations

import pytest
from rich.text import Text
from textual.app import App, ComposeResult

from jarvis_cli.tui.arc_reactor import ArcReactorWidget


class _Harness(App):
    def __init__(self, **widget_kwargs) -> None:
        super().__init__()
        self.widget_kwargs = widget_kwargs

    def compose(self) -> ComposeResult:
        yield ArcReactorWidget(id="reactor", **self.widget_kwargs)


@pytest.mark.asyncio
async def test_mounts_without_error():
    app = _Harness()
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        assert widget is not None


@pytest.mark.asyncio
async def test_render_returns_nonempty_grid():
    app = _Harness()
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        rendered = widget.render()
        assert isinstance(rendered, Text)
        plain = rendered.plain
        assert plain.strip() != ""
        # grid should be size rows tall (minus newlines) and non-trivial.
        lines = plain.split("\n")
        assert len(lines) == widget._rows
        assert all(len(line) == widget._cols for line in lines)


@pytest.mark.asyncio
async def test_thinking_toggle_does_not_error():
    app = _Harness()
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        widget.thinking = True
        await pilot.pause()
        widget.render()
        widget.thinking = False
        await pilot.pause()
        widget.render()


@pytest.mark.asyncio
async def test_angles_advance_after_direct_tick():
    app = _Harness()
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        before = (widget._outer_angle, widget._middle_angle, widget._inner_angle,
                  widget._pulse_elapsed_ms)
        widget._advance(widget.TICK_MS)
        after = (widget._outer_angle, widget._middle_angle, widget._inner_angle,
                 widget._pulse_elapsed_ms)
        assert before != after
        assert all(a != b for a, b in zip(before, after))


@pytest.mark.asyncio
async def test_angles_advance_via_real_interval_timer():
    app = _Harness()
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        before = widget._outer_angle
        # let the real set_interval timer fire at least once.
        await pilot.pause(widget.TICK_MS / 1000.0 * 3)
        assert widget._outer_angle != before


@pytest.mark.asyncio
async def test_spinning_false_freezes_rings_but_not_pulse_or_orbit():
    app = _Harness(spinning=False, thinking=True)
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        outer_before = widget._outer_angle
        middle_before = widget._middle_angle
        inner_before = widget._inner_angle
        pulse_before = widget._pulse_elapsed_ms
        orbit_before = widget._orbit_angle

        widget._advance(widget.TICK_MS)

        assert widget._outer_angle == outer_before
        assert widget._middle_angle == middle_before
        assert widget._inner_angle == inner_before
        # pulse and (since thinking=True) orbit keep running regardless of spinning.
        assert widget._pulse_elapsed_ms != pulse_before
        assert widget._orbit_angle != orbit_before


@pytest.mark.asyncio
async def test_default_and_custom_size_constructors():
    app = _Harness(size=21, spinning=True, thinking=False)
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        assert widget.reactor_size == 21
        assert widget._cols == 21
        # height scaled down from width by the char-aspect ratio, not 1:1.
        assert widget._rows < widget._cols
        rendered = widget.render()
        assert rendered.plain.strip() != ""


@pytest.mark.asyncio
async def test_pause_stops_the_real_interval_timer_from_advancing():
    """Perf fix: a hidden (`.display = False`) reactor must not keep
    ticking/re-rendering forever in the background — .pause() stops the
    ~100ms set_interval timer from firing at all."""
    app = _Harness()
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        widget.pause()
        before = (widget._outer_angle, widget._middle_angle,
                  widget._inner_angle, widget._pulse_elapsed_ms)
        # let several real tick intervals elapse — none should land.
        await pilot.pause(widget.TICK_MS / 1000.0 * 5)
        after = (widget._outer_angle, widget._middle_angle,
                 widget._inner_angle, widget._pulse_elapsed_ms)
        assert after == before


@pytest.mark.asyncio
async def test_resume_after_pause_lets_the_timer_advance_again():
    app = _Harness()
    async with app.run_test() as pilot:
        await pilot.pause()
        widget = app.query_one("#reactor", ArcReactorWidget)
        widget.pause()
        await pilot.pause(widget.TICK_MS / 1000.0 * 3)
        frozen = widget._outer_angle

        widget.resume()
        await pilot.pause(widget.TICK_MS / 1000.0 * 5)
        assert widget._outer_angle != frozen


@pytest.mark.asyncio
async def test_pause_and_resume_are_safe_before_mount():
    """pause()/resume() must not raise if called before on_mount has set up
    the timer (e.g. a caller toggling .display on a not-yet-mounted widget)."""
    widget = ArcReactorWidget()
    widget.pause()
    widget.resume()
