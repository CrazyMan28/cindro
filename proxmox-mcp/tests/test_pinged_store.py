"""Pinged rules: trigger validation, the deterministic schedule due-check,
record/event semantics, and the events cap."""

import json
import time

from proxmox_mcp import pinged_store


def _ms(year=2026, mon=1, day=15, hour=10, minute=0):
    """Deterministic local-time now_ms regardless of when tests run."""
    return int(time.mktime((year, mon, day, hour, minute, 0, 0, 0, -1)) * 1000)


def _rules(tmp_path):
    return tmp_path / "pinged.json", tmp_path / "pinged_events.jsonl"


def test_add_rule_validation(tmp_path):
    rules_file, _ = _rules(tmp_path)
    assert pinged_store.add_rule(rules_file, name="", action="x", now_ms=1)["ok"] is False
    both = pinged_store.add_rule(rules_file, name="n", action="a", now_ms=1,
                                 condition="c", time_of_day="09:00")
    assert both["ok"] is False and "exactly one" in both["error"]
    neither = pinged_store.add_rule(rules_file, name="n", action="a", now_ms=1)
    assert neither["ok"] is False
    bad_time = pinged_store.add_rule(rules_file, name="n", action="a", now_ms=1,
                                     time_of_day="25:99")
    assert bad_time["ok"] is False and "HH:MM" in bad_time["error"]


def test_condition_rules_always_due(tmp_path):
    rules_file, events_file = _rules(tmp_path)
    added = pinged_store.add_rule(rules_file, name="runner-watch", action="check the runner",
                                  now_ms=1, vmid=104,
                                  condition="the CI runner looks stuck")
    assert added["ok"] is True
    rule_id = added["rule"]["id"]

    assert [r["id"] for r in pinged_store.due_rules(rules_file, _ms())] == [rule_id]
    # recording (fired or not) does NOT stop a condition rule from being due next tick
    pinged_store.record(rules_file, events_file, rule_id, False, "looked fine", _ms())
    assert [r["id"] for r in pinged_store.due_rules(rules_file, _ms(minute=5))] == [rule_id]


def test_schedule_rule_due_once_per_day(tmp_path):
    rules_file, events_file = _rules(tmp_path)
    added = pinged_store.add_rule(rules_file, name="daily", action="check backups",
                                  now_ms=1, time_of_day="09:30")
    rule_id = added["rule"]["id"]

    assert pinged_store.due_rules(rules_file, _ms(hour=9, minute=0)) == []      # too early
    assert [r["id"] for r in pinged_store.due_rules(rules_file, _ms(hour=10))] == [rule_id]

    # handled at 10:00 (even not-fired) -> no longer due for the rest of the day
    pinged_store.record(rules_file, events_file, rule_id, False, "nothing to do",
                        _ms(hour=10))
    assert pinged_store.due_rules(rules_file, _ms(hour=11)) == []
    assert pinged_store.due_rules(rules_file, _ms(hour=23, minute=59)) == []
    # ...but due again after tomorrow's trigger time
    assert [r["id"] for r in pinged_store.due_rules(rules_file, _ms(day=16, hour=9, minute=45))] \
        == [rule_id]


def test_record_fired_appends_event_and_updates_rule(tmp_path):
    rules_file, events_file = _rules(tmp_path)
    added = pinged_store.add_rule(rules_file, name="watch", action="fix it",
                                  now_ms=1, vmid=104, condition="stuck")
    rule_id = added["rule"]["id"]

    result = pinged_store.record(rules_file, events_file, rule_id, True,
                                 "restarted gitea-runner", 5000)
    assert result["ok"] is True
    rule = pinged_store.load_rules(rules_file)[0]
    assert rule["last_fired_at"] == 5000 and rule["last_checked_at"] == 5000
    assert rule["last_result"] == "restarted gitea-runner"

    evs = pinged_store.events(events_file)
    assert len(evs) == 1 and evs[0]["rule_id"] == rule_id
    assert evs[0]["result"] == "restarted gitea-runner" and evs[0]["vmid"] == 104

    unknown = pinged_store.record(rules_file, events_file, "p-nope", True, "x", 1)
    assert unknown["ok"] is False


def test_not_fired_records_check_without_event(tmp_path):
    rules_file, events_file = _rules(tmp_path)
    added = pinged_store.add_rule(rules_file, name="watch", action="a",
                                  now_ms=1, condition="c")
    pinged_store.record(rules_file, events_file, added["rule"]["id"], False, "ok", 5000)
    rule = pinged_store.load_rules(rules_file)[0]
    assert rule["last_checked_at"] == 5000 and rule["last_fired_at"] is None
    assert pinged_store.events(events_file) == []


def test_remove_rule(tmp_path):
    rules_file, _ = _rules(tmp_path)
    added = pinged_store.add_rule(rules_file, name="n", action="a", now_ms=1,
                                  condition="c")
    assert pinged_store.remove_rule(rules_file, added["rule"]["id"])["ok"] is True
    assert pinged_store.load_rules(rules_file) == []
    assert pinged_store.remove_rule(rules_file, "p-nope")["ok"] is False


def test_events_capped_and_newest_first(tmp_path):
    rules_file, events_file = _rules(tmp_path)
    for i in range(210):
        pinged_store._append_event(events_file, {"eid": f"e-{i}", "fired_at": i})
    lines = events_file.read_text().splitlines()
    assert len(lines) == 200
    assert json.loads(lines[0])["eid"] == "e-10"  # oldest 10 trimmed
    evs = pinged_store.events(events_file, limit=5)
    assert [e["eid"] for e in evs] == ["e-209", "e-208", "e-207", "e-206", "e-205"]


def test_corrupt_rules_file_treated_as_empty(tmp_path):
    rules_file, _ = _rules(tmp_path)
    rules_file.write_text("{broken")
    assert pinged_store.load_rules(rules_file) == []
