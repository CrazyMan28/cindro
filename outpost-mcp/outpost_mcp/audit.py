"""Best-effort local audit sink for outpost-mcp.

External Claude Code / Codex sessions call the outpost_* tools directly (the
client-setup.sh path) with no jarvisd anywhere in the loop, so jarvisd's own
audit log (core/include/jarvis/AuditLog.h) never sees these calls. This gives
every gated action (exec, screenshot, revoke) its own durable local record,
independent of whether jarvisd is running or even installed.

One JSON object per line, newest last, at
~/.config/jarvis/outpost_mcp_audit.jsonl (0600, created on first write).

Logging happens once per action, at the AgentHub.exec/screenshot and
MachineRegistry.revoke layer -- NOT also at the outpost_* MCP tool wrappers
or the /api/* HTTP routes, since both of those funnel through the same call
sites and logging at both would duplicate every entry.

Best-effort: a write failure (disk full, permissions, read-only fs) is
swallowed here and must never break the action it's auditing.
"""

import json
import os
import time
from pathlib import Path
from typing import Any


def _audit_file() -> Path:
    # Mirrors config.OUTPOST_CONFIG_DIR's own default, but resolved fresh on
    # every call (rather than once at import) so it honors OUTPOST_CONFIG_DIR
    # even when set after outpost_mcp.config was first imported -- e.g. in
    # tests, which set the env var per-test via an autouse fixture.
    base = os.environ.get("OUTPOST_CONFIG_DIR") or str(Path.home() / ".config" / "jarvis")
    return Path(base) / "outpost_mcp_audit.jsonl"


def record(action: str, machine_id: str, machine_name: str = "", ok: bool = True,
           detail: str = "") -> None:
    """Append one audit line. Best-effort: swallows all errors."""
    entry: dict[str, Any] = {
        "ts": int(time.time() * 1000),
        "action": action,
        "machine_id": machine_id,
        "machine_name": machine_name,
        "ok": ok,
        "detail": detail,
    }
    try:
        path = _audit_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        is_new = not path.exists()
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        if is_new:
            os.chmod(path, 0o600)
    except OSError:
        pass
