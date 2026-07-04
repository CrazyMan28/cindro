"""QuickViewScreen: a reusable inline popup overlay over the main app —
mount, assert visible, Escape dismisses it and the app keeps running."""

from __future__ import annotations

from textual.widgets import Static

from jarvis_cli.tui.app import JarvisTui
from jarvis_cli.tui.quick_view import QuickViewScreen


async def test_quick_view_pushes_and_shows_the_pane():
    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.1)
        screen = QuickViewScreen("Hello Pane", lambda: Static("hello", id="quick-hello"))
        await app.push_screen(screen)
        await pilot.pause(0.1)

        assert app.screen is screen
        assert screen in app.screen_stack
        assert screen.query_one("#quick-hello", Static) is not None


async def test_escape_dismisses_the_overlay_and_app_keeps_running():
    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.1)
        screen = QuickViewScreen("Hello Pane", lambda: Static("hello"))
        await app.push_screen(screen)
        await pilot.pause(0.1)
        assert app.screen is screen

        await pilot.press("escape")
        await pilot.pause(0.1)

        assert screen not in app.screen_stack
        assert app.is_running
        # underneath the overlay is the main app screen again (not crashed).
        assert app.screen is not screen


async def test_dismissing_overlay_does_not_change_the_active_main_tab():
    """Closing the overlay must return the user to whatever tab was active
    underneath (e.g. Chat) — the overlay must not touch the main
    TabbedContent's active tab."""
    from textual.widgets import TabbedContent
    from jarvis_cli.tui.screens import MemoryPane

    app = JarvisTui()
    async with app.run_test() as pilot:
        await pilot.pause(0.1)
        tabbed = app.query_one(TabbedContent)
        tabbed.active = "tab-chat"
        await pilot.pause(0.05)

        screen = QuickViewScreen("Memory", lambda: MemoryPane(id="memory-quick"))
        await app.push_screen(screen)
        await pilot.pause(0.1)

        await pilot.press("escape")
        await pilot.pause(0.1)

        assert tabbed.active == "tab-chat"
