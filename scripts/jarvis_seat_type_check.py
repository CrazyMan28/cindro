#!/usr/bin/env python3
"""Live smoke: agent typing on the forked KWin's independent `jarvis` seat.

Verifies the 2026-07-10 modifier fix END TO END on the REAL compositor: launches
a scratch foot terminal running `cat > <tmpfile>`, focuses it with the JARVIS
seat only (never seat0), types a mixed-case string through the seat, sends
Enter, then ctrl+d (EOF). If the file holds the exact string, then keymap,
Shift (uppercase) and Ctrl (the EOF combo) all work on the agent seat, and
nothing needed the user's focus.

Run AFTER a relogin into "Plasma (Jarvis KWin fork)" (the atomic-rename install
only loads at login), with the screen UNLOCKED:

    cd computer-use && env -u PYTHONPATH .venv/bin/python3 ../scripts/jarvis_seat_type_check.py
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "computer-use"))

from computer_use_mcp import input as inp  # noqa: E402
from computer_use_mcp import jarvis_seat, windows  # noqa: E402

MARKER = "Jarvis seat OK: Aa Bb 42!"
OUT = Path("/tmp/jarvis-seat-type-check.txt")
UNIT = "jarvis-seat-type-check"


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    if not jarvis_seat.available():
        fail("JarvisSeat DBus iface absent — forked KWin not running?")
    OUT.unlink(missing_ok=True)
    subprocess.run(["systemctl", "--user", "reset-failed", UNIT],
                   capture_output=True)
    subprocess.run(
        ["systemd-run", "--user", f"--unit={UNIT}", "foot",
         "--title=JARVIS-SEAT-CHECK", "sh", "-c", f"exec cat > {OUT}"],
        check=True, capture_output=True,
    )
    try:
        rect = None
        for _ in range(50):
            time.sleep(0.2)
            for w in windows.list_windows("kde"):
                if w.get("error"):
                    # KWin scripting failed — surface the real cause, don't poll on.
                    fail(f"window_list backend error: {w['error']}")
                if w.get("title") == "JARVIS-SEAT-CHECK":
                    rect = w["rect"]
                    break
            if rect:
                break
        if not rect:
            fail("scratch terminal window never appeared")
        cx = rect["x"] + rect["w"] // 2
        cy = rect["y"] + rect["h"] // 2
        # available() is True (checked above), so click() takes the jarvis-seat
        # atomic-click branch — the shared-seat path is unreachable here.
        inp.click(cx, cy, coord_space="desktop", which="active")
        time.sleep(0.3)
        typed = inp.type_text(MARKER)
        if typed.get("method") != "jarvis-seat":
            fail(f"type_text did not use the jarvis seat: {typed}")
        inp.key_press("enter")
        inp.key_press("ctrl+d")  # EOF — exercises the Ctrl modifier
        for _ in range(20):
            time.sleep(0.2)
            if OUT.exists() and MARKER in OUT.read_text():
                print(f"PASS: {MARKER!r} landed via the jarvis seat "
                      "(keymap + Shift + Ctrl all good, user seat untouched)")
                return
        got = OUT.read_text() if OUT.exists() else "<no file>"
        fail(f"marker not found; file holds: {got!r} — Shift/Ctrl still broken "
             "or keys routed elsewhere (check `journalctl --user | grep JARVISSEAT`)")
    finally:
        subprocess.run(["systemctl", "--user", "stop", UNIT], capture_output=True)


if __name__ == "__main__":
    main()
