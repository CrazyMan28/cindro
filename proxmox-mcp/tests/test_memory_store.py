from proxmox_mcp.memory_store import MemoryStore


def test_remember_and_recall_most_recent_first(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.remember("tuned VM 104 to 6 cores", tags="tune", now_ms=1000)
    store.remember("checked in, nothing congested", tags="checkin", now_ms=2000)
    results = store.recall(limit=10)
    assert [r["text"] for r in results] == [
        "checked in, nothing congested", "tuned VM 104 to 6 cores",
    ]


def test_recall_full_text_search(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.remember("bumped memory on VM 106 due to congestion", now_ms=1000)
    store.remember("skipped VM 107, blocklisted", now_ms=2000)
    results = store.recall(query="congestion")
    assert len(results) == 1
    assert "VM 106" in results[0]["text"]


def test_since_returns_only_newer_rows_oldest_first(tmp_path):
    store = MemoryStore(tmp_path / "memory.db")
    store.remember("first", now_ms=1000)
    store.remember("second", now_ms=2000)
    store.remember("third", now_ms=3000)
    rows = store.since(after_ms=1000)
    assert [r["text"] for r in rows] == ["second", "third"]
