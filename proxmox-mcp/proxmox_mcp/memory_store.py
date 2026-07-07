"""Local, durable memory for the Proxmox agent: a small SQLite+FTS5 db that
lives on the Proxmox host itself (config.MEMORY_DB), not on the user's
laptop. This is what makes the agent's decision history survive the laptop
being off — the daemon's proxmox.report RPC syncs rows OUT of this db into
the laptop's own agent-scoped memory (agent="proxmox-<hostname>") on request;
this module never talks to the laptop directly.

Column names deliberately match the laptop's memories table
(text, tags, created) so that sync is a straight copy, no transformation.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE IF NOT EXISTS memories ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " text TEXT NOT NULL,"
        " tags TEXT NOT NULL DEFAULT '',"
        " created INTEGER NOT NULL)"
    )
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5("
        " text, tags, content='memories', content_rowid='id')"
    )
    # Keep the FTS index in sync on insert (this table is append-only —
    # decisions are never edited or deleted, so no update/delete triggers).
    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN"
        " INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);"
        " END"
    )
    conn.commit()
    return conn


class MemoryStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._conn = _connect(db_path)

    def remember(self, text: str, tags: str = "", now_ms: int | None = None) -> int:
        ts = now_ms if now_ms is not None else int(time.time() * 1000)
        cur = self._conn.execute(
            "INSERT INTO memories (text, tags, created) VALUES (?, ?, ?)",
            (text, tags, ts),
        )
        self._conn.commit()
        return cur.lastrowid

    def recall(self, query: str = "", limit: int = 20) -> list[dict]:
        if query.strip():
            rows = self._conn.execute(
                "SELECT m.id, m.text, m.tags, m.created FROM memories_fts f"
                " JOIN memories m ON m.id = f.rowid"
                " WHERE memories_fts MATCH ? ORDER BY m.created DESC LIMIT ?",
                (query, limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT id, text, tags, created FROM memories ORDER BY created DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [{"id": r[0], "text": r[1], "tags": r[2], "created": r[3]} for r in rows]

    def since(self, after_ms: int, limit: int = 500) -> list[dict]:
        """Rows created strictly after `after_ms`, oldest first — the feed
        proxmox.report syncs into the laptop's own memory store."""
        rows = self._conn.execute(
            "SELECT id, text, tags, created FROM memories WHERE created > ?"
            " ORDER BY created ASC LIMIT ?",
            (after_ms, limit),
        ).fetchall()
        return [{"id": r[0], "text": r[1], "tags": r[2], "created": r[3]} for r in rows]

    def close(self) -> None:
        self._conn.close()
