"""Pinged: named watch rules the headless agent evaluates every tick.

Two trigger kinds:
  condition — free-text, JUDGED BY THE AGENT ("the CI runner on VM 104 looks
              stuck"); returned by due_rules() on every tick.
  schedule  — "HH:MM" local time, decided deterministically HERE (due when
              the time has passed today and this rule wasn't already checked
              at/after today's trigger time) — the agent never has to reason
              about clocks.

record() must be called for every rule the agent handled, fired or not:
last_checked_at is what stops a due schedule rule from re-firing every
5-minute tick for the rest of the day, and it doubles as the liveness signal
the user sees in the UI. Fired events append to a capped jsonl the daemon
polls for inbox pings.
"""

from __future__ import annotations

import time
from pathlib import Path

from proxmox_mcp import mailbox, state_store

_EVENTS_CAP = 200


def load_rules(rules_file: Path) -> list[dict]:
    data = state_store.load_json(rules_file, {"rules": []})
    rules = data.get("rules", []) if isinstance(data, dict) else []
    return [r for r in rules if isinstance(r, dict) and r.get("id")]


def save_rules(rules_file: Path, rules: list[dict]) -> None:
    state_store.save_json(rules_file, {"rules": rules})


def _valid_time(hhmm: str) -> bool:
    parts = (hhmm or "").split(":")
    if len(parts) != 2:
        return False
    try:
        hh, mm = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    return 0 <= hh <= 23 and 0 <= mm <= 59


def add_rule(rules_file: Path, *, name: str, action: str, now_ms: int,
             vmid: int = 0, condition: str = "", time_of_day: str = "") -> dict:
    """Exactly one of condition / time_of_day. Returns {ok, rule} or
    {ok:False, error}."""
    if not (name or "").strip() or not (action or "").strip():
        return {"ok": False, "error": "name and action are required"}
    if bool(condition.strip()) == bool(time_of_day.strip()):
        return {"ok": False,
                "error": "give exactly one trigger: condition (free text) OR "
                        "time_of_day (HH:MM)"}
    if time_of_day.strip() and not _valid_time(time_of_day.strip()):
        return {"ok": False, "error": f"time_of_day must be HH:MM, got {time_of_day!r}"}
    rules = load_rules(rules_file)
    rid = f"p-{now_ms}"
    n = 1
    while any(r["id"] == rid for r in rules):
        rid = f"p-{now_ms}.{n}"
        n += 1
    trigger = ({"type": "condition", "condition": condition.strip()}
               if condition.strip()
               else {"type": "schedule", "time": time_of_day.strip()})
    rule = {"id": rid, "name": name.strip(), "vmid": int(vmid), "trigger": trigger,
            "action": action.strip(), "enabled": True, "created_at": now_ms,
            "last_checked_at": None, "last_fired_at": None, "last_result": ""}
    rules.append(rule)
    save_rules(rules_file, rules)
    return {"ok": True, "rule": rule}


def remove_rule(rules_file: Path, rule_id: str) -> dict:
    rules = load_rules(rules_file)
    remaining = [r for r in rules if r.get("id") != rule_id]
    if len(remaining) == len(rules):
        return {"ok": False, "error": f"no rule with id {rule_id!r}"}
    save_rules(rules_file, remaining)
    return {"ok": True, "removed": rule_id}


def _schedule_due(rule: dict, now_ms: int) -> bool:
    hhmm = (rule.get("trigger") or {}).get("time", "")
    if not _valid_time(hhmm):
        return False
    hh, mm = (int(x) for x in hhmm.split(":"))
    local = time.localtime(now_ms / 1000)
    today_trigger_ms = int(time.mktime(
        (local.tm_year, local.tm_mon, local.tm_mday, hh, mm, 0, 0, 0, -1)) * 1000)
    if now_ms < today_trigger_ms:
        return False
    return (rule.get("last_checked_at") or 0) < today_trigger_ms


def due_rules(rules_file: Path, now_ms: int) -> list[dict]:
    """Every enabled condition rule (the agent judges those each tick) plus
    any schedule rule whose time has come today."""
    due = []
    for rule in load_rules(rules_file):
        if not rule.get("enabled", True):
            continue
        kind = (rule.get("trigger") or {}).get("type", "")
        if kind == "condition" or (kind == "schedule" and _schedule_due(rule, now_ms)):
            due.append(rule)
    return due


def record(rules_file: Path, events_file: Path, rule_id: str, fired: bool,
           result: str, now_ms: int) -> dict:
    rules = load_rules(rules_file)
    for rule in rules:
        if rule.get("id") != rule_id:
            continue
        rule["last_checked_at"] = now_ms
        rule["last_result"] = (result or "").strip()
        if fired:
            rule["last_fired_at"] = now_ms
            _append_event(events_file, {
                "eid": f"e-{now_ms}-{rule_id}", "rule_id": rule_id,
                "name": rule.get("name", ""), "vmid": rule.get("vmid", 0),
                "fired_at": now_ms, "result": (result or "").strip(),
            })
        save_rules(rules_file, rules)
        return {"ok": True, "rule": rule}
    return {"ok": False, "error": f"no rule with id {rule_id!r}"}


def _append_event(events_file: Path, event: dict) -> None:
    mailbox.append_jsonl(events_file, event)
    # Cap the file so years of daily rules can't grow it unbounded.
    rows = mailbox.read_jsonl(events_file)
    if len(rows) > _EVENTS_CAP:
        mailbox.rewrite_jsonl(events_file, rows[-_EVENTS_CAP:])


def events(events_file: Path, limit: int = 50) -> list[dict]:
    rows = mailbox.read_jsonl(events_file)[-limit:]
    rows.reverse()  # newest first
    return rows
