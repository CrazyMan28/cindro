"""MachineRegistry — the paired-machine store (~/.config/jarvis/outpost_machines.json).

Row shape mirrors core/include/jarvis/DeviceRegistry.h's DeviceRow:
{id, name, os, transport, status, last_seen, paired_at} plus a private
token_sha256 (per-machine bearer, SHA-256 hashed — plaintext is never stored)."""

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Optional

from outpost_mcp import audit, config

_PUBLIC_KEYS = ("id", "name", "os", "transport", "status", "last_seen", "paired_at")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class MachineRegistry:
    def __init__(self, path: Optional[Path] = None):
        self._path = Path(path) if path else config.MACHINES_FILE
        self._machines: list[dict[str, Any]] = []
        self.load()

    def load(self) -> None:
        try:
            data = json.loads(self._path.read_text())
            self._machines = data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            self._machines = []

    def _persist(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._machines, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(self._path)

    @staticmethod
    def _public(m: dict[str, Any]) -> dict[str, Any]:
        return {k: m.get(k) for k in _PUBLIC_KEYS}

    def add(self, name: str, os_name: str, transport: str = "ws") -> dict[str, Any]:
        mid = secrets.token_hex(8)
        raw = secrets.token_urlsafe(32)
        row = {
            "id": mid,
            "name": name or mid,
            "os": os_name,
            "transport": transport,
            "status": "offline",
            "last_seen": 0,
            "paired_at": int(time.time() * 1000),
            "token_sha256": _hash_token(raw),
        }
        self._machines.append(row)
        self._persist()
        return {"row": row, "token": raw}

    def list(self) -> list[dict[str, Any]]:
        return [self._public(m) for m in self._machines]

    def get(self, machine: str) -> Optional[dict[str, Any]]:
        for m in self._machines:
            if m["id"] == machine or m["name"] == machine:
                return m
        return None

    def by_token(self, token: str) -> Optional[dict[str, Any]]:
        h = _hash_token(token)
        for m in self._machines:
            if hmac.compare_digest(m.get("token_sha256", ""), h):
                return m
        return None

    def set_status(self, machine_id: str, status: str, seen: bool = True) -> None:
        for m in self._machines:
            if m["id"] == machine_id:
                m["status"] = status
                if seen:
                    m["last_seen"] = int(time.time() * 1000)
                self._persist()
                return

    def revoke(self, machine: str) -> bool:
        m = self.get(machine)
        if not m:
            return False
        self._machines = [x for x in self._machines if x["id"] != m["id"]]
        self._persist()
        audit.record("revoke", m["id"], m["name"], ok=True)
        return True
