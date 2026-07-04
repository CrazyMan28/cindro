"""Shared CSS boilerplate for the TUI's full-screen ``ModalScreen`` popups.

``LockGateScreen``, ``SetupWizardScreen``, ``VoiceModeScreen``, and
``QuickViewScreen`` (lock_gate.py / setup_wizard.py / voice_mode.py /
quick_view.py) each independently redeclared the same screen-level
``align: center middle`` + near-black backdrop, and three of the four
(everything but QuickView, whose box is shaped completely differently)
also redeclared the same auto-height, ``1 2``-padded box-container shape.

This module holds ONLY that literal, already-duplicated CSS — deliberately
NOT a shared base class. LockGateScreen and SetupWizardScreen have NO
escape-to-dismiss by design; a common base class would risk accidentally
reintroducing that behavior by way of shared bindings/handlers. Plain CSS
text carries no behavior at all, so it is safe.

Why functions and not one flat string constant: Textual's ``SCOPED_CSS``
mechanism auto-restricts any selector inside a widget class's OWN
``DEFAULT_CSS`` whose leading token isn't that exact class's name — it
silently rewrites e.g. a bare ``ModalScreen { ... }`` rule embedded in
``LockGateScreen.DEFAULT_CSS`` into an ancestor-scoped descendant selector
that can never match the screen itself (there's no different-node ancestor
of the same type). A rule can only ever target "the screen itself" from
within that screen's own DEFAULT_CSS if its selector literally starts with
that screen's own class name — confirmed empirically against Textual 8.2.5
(see the `App.run_test()` check run alongside this change). Hence these
return already-substituted text rather than one static template string.

Usage — concatenate into each screen's own ``DEFAULT_CSS``, shared rules
first, screen-specific rules last (screen-specific rules for the same
selector still layer on top/win for any property they repeat, per the
normal CSS cascade):

    from jarvis_cli.tui.modal_base import modal_screen_css, modal_box_css

    class SomeScreen(ModalScreen[None]):
        DEFAULT_CSS = modal_screen_css("SomeScreen") + modal_box_css(
            "SomeScreen", "some-box") + \"\"\"
        SomeScreen > #some-box {
            width: 60;
        }
        \"\"\"
"""

from __future__ import annotations


def modal_screen_css(screen_name: str, *, background: str = "#06090d") -> str:
    """The screen-level backdrop shared by every full-screen modal popup:
    dims everything mounted underneath and centers the popup's own box on
    top of it. Identical across LockGateScreen, SetupWizardScreen, and
    VoiceModeScreen; QuickViewScreen passes its own ``background`` (a
    60%-opacity backdrop) instead of relying on the default.
    """
    return f"""
{screen_name} {{
    align: center middle;
    background: {background};
}}
"""


def modal_box_css(screen_name: str, box_id: str) -> str:
    """The auto-height, ``1 2``-padded box shape shared by LockGateScreen's
    #lock-box, SetupWizardScreen's #wizard-box, and VoiceModeScreen's
    #voice-box. Each screen still sets its own box's width (and
    SetupWizardScreen layers on a max-height + border) via its own
    ``{screen_name} > #{box_id} {{ ... }}`` rule declared after this.
    """
    return f"""
{screen_name} > #{box_id} {{
    height: auto;
    padding: 1 2;
}}
"""
