from outpost_mcp.registry import MachineRegistry, _hash_token


def test_add_returns_token_once_and_hashes_at_rest(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    res = reg.add("Alice-PC", "windows")
    token = res["token"]
    row = res["row"]
    assert row["id"] and row["name"] == "Alice-PC" and row["os"] == "windows"
    assert row["status"] == "offline" and row["transport"] == "ws"
    assert row["token_sha256"] == _hash_token(token)
    # public list never leaks the hash
    assert "token_sha256" not in reg.list()[0]


def test_get_by_name_or_id(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    row = reg.add("box", "linux")["row"]
    assert reg.get("box")["id"] == row["id"]
    assert reg.get(row["id"])["name"] == "box"
    assert reg.get("nope") is None


def test_by_token_and_status(tmp_path):
    reg = MachineRegistry(tmp_path / "m.json")
    res = reg.add("box", "linux")
    found = reg.by_token(res["token"])
    assert found and found["id"] == res["row"]["id"]
    assert reg.by_token("wrong") is None
    reg.set_status(res["row"]["id"], "online")
    assert reg.list()[0]["status"] == "online"
    assert reg.list()[0]["last_seen"] > 0


def test_revoke_and_persist(tmp_path):
    path = tmp_path / "m.json"
    reg = MachineRegistry(path)
    row = reg.add("box", "linux")["row"]
    assert reg.revoke("box") is True
    assert reg.revoke("box") is False
    # a fresh registry reading the same file sees the deletion
    assert MachineRegistry(path).list() == []
