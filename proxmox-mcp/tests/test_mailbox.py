"""Question/task mailboxes: pending/consume semantics, bounds, dedupe,
tolerance to malformed lines, and the tasks-specific age-based pruning."""

import json

from proxmox_mcp import mailbox


def test_question_round_trip(tmp_path):
    mb = mailbox.questions_mailbox(tmp_path)
    added = mb.add_request({"vmid": 104, "question": "What is VM 104 for?",
                            "options": ["CI", "Web"]}, 1000, id_suffix="104")
    assert added["ok"] is True and added["qid"].startswith("q-1000-104")
    assert [q["question"] for q in mb.pending()] == ["What is VM 104 for?"]

    mb.add_reply(added["qid"], {"answer": "CI runner"}, 2000)
    assert mb.pending() == []  # answered -> no longer pending

    consumed = mb.consume()
    assert len(consumed) == 1
    assert consumed[0]["answer"] == "CI runner"
    assert consumed[0]["replied_at"] == 2000
    assert consumed[0]["vmid"] == 104
    assert mb.consume() == []  # drained


def test_max_pending_and_dedupe(tmp_path):
    mb = mailbox.questions_mailbox(tmp_path)
    for i in range(3):
        assert mb.add_request({"vmid": i, "question": f"q{i}", "options": []},
                              1000 + i, max_pending=3)["ok"] is True
    full = mb.add_request({"vmid": 9, "question": "q9", "options": []},
                          2000, max_pending=3)
    assert full["ok"] is False and "queue full" in full["reason"]

    mb.add_reply(mb.pending()[0]["qid"], {"answer": "a"}, 3000)
    dup = mb.add_request({"vmid": 1, "question": "q1", "options": []},
                         4000, max_pending=3, dedupe_fields=("vmid", "question"))
    assert dup["ok"] is False and "duplicate" in dup["reason"]


def test_malformed_lines_skipped(tmp_path):
    mb = mailbox.questions_mailbox(tmp_path)
    mb.add_request({"vmid": 1, "question": "ok?", "options": []}, 1000)
    with open(mb.requests_file, "a") as f:
        f.write("{not json\n\n[1,2,3]\n")
    assert len(mb.pending()) == 1  # good row survives the garbage


def test_consume_keeps_unanswered_and_prunes_orphan_replies(tmp_path):
    mb = mailbox.questions_mailbox(tmp_path)
    a = mb.add_request({"vmid": 1, "question": "a?", "options": []}, 1000)
    mb.add_request({"vmid": 2, "question": "b?", "options": []}, 1001)
    mb.add_reply(a["qid"], {"answer": "yes"}, 2000)
    mb.add_reply("q-does-not-exist", {"answer": "orphan"}, 2001)

    consumed = mb.consume()
    assert [c["qid"] for c in consumed] == [a["qid"]]
    assert [q["question"] for q in mb.pending()] == ["b?"]
    replies = [json.loads(l) for l in mb.replies_file.read_text().splitlines()] \
        if mb.replies_file.exists() else []
    assert replies == []  # matched + orphan replies both pruned


def test_tasks_reply_flow_and_prune(tmp_path):
    mb = mailbox.tasks_mailbox(tmp_path)
    t = mb.add_request({"kind": "ask", "text": "what runs on 104?"}, 1000)
    assert t["ok"] is True and t["rid"].startswith("t-1000")
    assert mb.has_request(t["rid"]) is True
    assert mb.get_reply(t["rid"]) is None

    mb.add_reply(t["rid"], {"reply": "nginx + a CI runner"}, 2000)
    reply = mb.get_reply(t["rid"])
    assert reply["reply"] == "nginx + a CI runner"
    assert mb.pending() == []  # replied -> not pending
    # reply stays readable (laptop may not have polled yet)...
    assert mb.prune_replied(now_ms=2000 + 3600_000, max_age_ms=24 * 3600_000) == 0
    assert mb.get_reply(t["rid"]) is not None
    # ...until it ages out
    assert mb.prune_replied(now_ms=2000 + 25 * 3600_000, max_age_ms=24 * 3600_000) == 1
    assert mb.get_reply(t["rid"]) is None
    assert mb.has_request(t["rid"]) is False


def test_id_collision_gets_suffix(tmp_path):
    mb = mailbox.tasks_mailbox(tmp_path)
    a = mb.add_request({"kind": "ask", "text": "one"}, 1000)
    b = mb.add_request({"kind": "ask", "text": "two"}, 1000)
    assert a["rid"] != b["rid"]
