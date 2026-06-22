"""Clipboard via wl-copy/wl-paste (data-control protocol — works without
focus on both KWin and sway), routed to the requested session's display."""

import subprocess

from computer_use_mcp import session


def copy(text: str, which: str = "active") -> None:
    info = session.get_session(which)
    # wl-copy forks a child that keeps serving the clipboard; captured pipes
    # would wait for that child forever, so send output to /dev/null.
    proc = subprocess.run(
        ["wl-copy"], input=text.encode(), stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=10, env=info.env(),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"wl-copy failed (rc={proc.returncode})")


def paste(which: str = "active") -> str:
    info = session.get_session(which)
    proc = subprocess.run(
        ["wl-paste", "--no-newline"], capture_output=True, timeout=10, env=info.env(),
    )
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace").strip()
        if "nothing is copied" in err.lower():
            return ""
        raise RuntimeError(f"wl-paste failed: {err}")
    return proc.stdout.decode(errors="replace")
