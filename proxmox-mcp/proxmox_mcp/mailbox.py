"""Non-blocking jsonl mailboxes between the headless agent and the user.

Two instances of the same shape:
  questions: agent asks  -> questions.jsonl ; user answers -> answers.jsonl
  tasks:     user asks   -> agent_tasks.jsonl ; agent replies -> agent_replies.jsonl

The request side is written by ONE party and consumed by the other; the reply
side is appended by the answering party (for questions that's the local
daemon over outpost.exec — line-per-record O_APPEND, no rewrite). consume()
joins matched pairs, then atomically rewrites the request file minus the
matched rows and prunes replies that no longer match any pending request.
There is a tiny window where a reply appended DURING that rewrite is lost —
acceptable here because both reply paths are human-driven and re-sendable
(the question just stays pending and the user answers again). Malformed
lines are skipped individually, never fatal (same stance as
state_store.load_blocklist).
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def read_jsonl(path: Path) -> list[dict]:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    rows = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(row) + "\n")


def rewrite_jsonl(path: Path, rows: list[dict]) -> None:
    if not rows:
        try:
            path.unlink()
        except OSError:
            pass
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(r) + "\n" for r in rows))
    os.replace(tmp, path)


class Mailbox:
    def __init__(self, requests_file: Path, replies_file: Path,
                 id_field: str, id_prefix: str):
        self.requests_file = requests_file
        self.replies_file = replies_file
        self.id_field = id_field
        self.id_prefix = id_prefix

    def _new_id(self, now_ms: int, suffix: str = "") -> str:
        base = f"{self.id_prefix}-{now_ms}" + (f"-{suffix}" if suffix else "")
        existing = {r.get(self.id_field) for r in read_jsonl(self.requests_file)}
        rid, n = base, 1
        while rid in existing:
            rid = f"{base}.{n}"
            n += 1
        return rid

    def add_request(self, fields: dict, now_ms: int, *, id_suffix: str = "",
                    max_pending: int = 0, dedupe_fields: tuple = ()) -> dict:
        pending = self.pending()
        if max_pending and len(pending) >= max_pending:
            return {"ok": False, "reason": f"queue full ({max_pending} pending)"}
        if dedupe_fields:
            key = tuple(fields.get(f) for f in dedupe_fields)
            for row in pending:
                if tuple(row.get(f) for f in dedupe_fields) == key:
                    return {"ok": False, "reason": "duplicate of a pending request",
                            self.id_field: row.get(self.id_field)}
        rid = self._new_id(now_ms, id_suffix)
        row = {self.id_field: rid, **fields, "at": now_ms}
        append_jsonl(self.requests_file, row)
        return {"ok": True, self.id_field: rid}

    def _replies_by_id(self) -> dict[str, dict]:
        out = {}
        for row in read_jsonl(self.replies_file):
            rid = row.get(self.id_field)
            if rid:
                out[rid] = row  # last reply for an id wins
        return out

    def pending(self) -> list[dict]:
        """Requests that have no reply yet."""
        replies = self._replies_by_id()
        return [r for r in read_jsonl(self.requests_file)
                if r.get(self.id_field) and r.get(self.id_field) not in replies]

    def get_reply(self, rid: str) -> dict | None:
        return self._replies_by_id().get(rid)

    def has_request(self, rid: str) -> bool:
        return any(r.get(self.id_field) == rid for r in read_jsonl(self.requests_file))

    def prune_replied(self, now_ms: int, max_age_ms: int) -> int:
        """Drop request+reply pairs whose reply is older than max_age_ms.
        Used by the TASKS mailbox, where consume() doesn't apply: the reply
        must stay readable until the laptop side has polled it, so cleanup
        is age-based instead of fetch-based."""
        requests = read_jsonl(self.requests_file)
        replies = self._replies_by_id()
        keep, removed = [], 0
        for req in requests:
            reply = replies.get(req.get(self.id_field))
            if reply and now_ms - (reply.get("at") or 0) > max_age_ms:
                removed += 1
                continue
            keep.append(req)
        if removed:
            rewrite_jsonl(self.requests_file, keep)
            keep_ids = {r.get(self.id_field) for r in keep}
            rewrite_jsonl(self.replies_file,
                           [r for r in read_jsonl(self.replies_file)
                            if r.get(self.id_field) in keep_ids])
        return removed

    def add_reply(self, rid: str, fields: dict, now_ms: int) -> dict:
        append_jsonl(self.replies_file, {self.id_field: rid, **fields, "at": now_ms})
        return {"ok": True, self.id_field: rid}

    def consume(self) -> list[dict]:
        """Matched request+reply pairs, merged (reply's `at` becomes
        `replied_at`). Removes matched requests; prunes replies that no
        longer match any remaining request."""
        requests = read_jsonl(self.requests_file)
        replies = self._replies_by_id()
        matched, remaining = [], []
        for req in requests:
            rid = req.get(self.id_field)
            reply = replies.get(rid) if rid else None
            if reply is None:
                remaining.append(req)
                continue
            merged = dict(req)
            for k, v in reply.items():
                if k == self.id_field:
                    continue
                merged["replied_at" if k == "at" else k] = v
            matched.append(merged)
        if matched:
            rewrite_jsonl(self.requests_file, remaining)
            keep_ids = {r.get(self.id_field) for r in remaining}
            rewrite_jsonl(self.replies_file,
                           [r for r in read_jsonl(self.replies_file)
                            if r.get(self.id_field) in keep_ids])
        return matched


def questions_mailbox(state_dir: Path) -> Mailbox:
    return Mailbox(state_dir / "questions.jsonl", state_dir / "answers.jsonl",
                   id_field="qid", id_prefix="q")


def tasks_mailbox(state_dir: Path) -> Mailbox:
    return Mailbox(state_dir / "agent_tasks.jsonl", state_dir / "agent_replies.jsonl",
                   id_field="rid", id_prefix="t")
