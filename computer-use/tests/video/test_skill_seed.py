"""skill_seed.seed() is the engine-startup path that installs the builtin
"video" skill + its two slash commands into jarvisd. All of these tests
monkeypatch daemon_client.call with an in-memory recorder standing in for
jarvisd — no real daemon involved."""

from __future__ import annotations

import pytest

from computer_use_mcp.video import skill_seed


class FakeDaemon:
    """Records every daemon_client.call() and answers skills.get/command.list
    from a tiny in-memory store, mirroring jarvisd's real semantics closely
    enough for seed() to exercise: skills.get raises when absent,
    command.create raises on a name collision (no update verb server-side)."""

    def __init__(self, skill_body: str | None = None, commands: list[str] = ()):
        self.calls: list[tuple[str, dict]] = []
        self.skill_body = skill_body
        self.command_names = set(commands)

    def __call__(self, method: str, params: dict | None = None, timeout: float = 15.0):
        params = params or {}
        self.calls.append((method, params))
        if method == "skills.get":
            if self.skill_body is None:
                raise RuntimeError("no_skill")
            return {"frontmatter": {"name": params["name"]}, "body": self.skill_body}
        if method == "skills.create":
            self.skill_body = params["body"]
            return {"ok": True, "path": "/fake/path"}
        if method == "command.list":
            return {"commands": [{"name": n} for n in sorted(self.command_names)]}
        if method == "command.create":
            if params["name"] in self.command_names:
                raise RuntimeError("invalid_command: already exists")
            self.command_names.add(params["name"])
            return {"ok": True}
        if method == "command.remove":
            self.command_names.discard(params["name"])
            return {"ok": True}
        raise AssertionError(f"unexpected method {method!r}")

    def calls_of(self, method: str) -> list[dict]:
        return [p for m, p in self.calls if m == method]


class AlwaysDownDaemon:
    """Every call fails, like jarvisd not being reachable at all."""

    def __call__(self, method: str, params: dict | None = None, timeout: float = 15.0):
        raise RuntimeError("jarvisd control call failed: connection refused")


@pytest.fixture()
def patch_daemon(monkeypatch):
    def _patch(fake):
        monkeypatch.setattr(skill_seed.daemon_client, "call", fake)
        return fake
    return _patch


# --- constants sanity --------------------------------------------------------

def test_skill_body_mentions_all_six_tools():
    for tool in ("video_info", "video_analyze", "video_watch", "video_detail",
                 "video_setup", "video_configure"):
        assert tool in skill_seed.SKILL_BODY


def test_skill_body_mentions_the_over_30s_analyze_rule():
    body_lower = skill_seed.SKILL_BODY.lower()
    assert "30 second" in body_lower or "30s" in body_lower
    assert "video_analyze" in skill_seed.SKILL_BODY


def test_skill_body_starts_with_version_marker():
    assert skill_seed.SKILL_BODY.startswith("[video skill v1]")


def test_command_names_match_spec():
    assert skill_seed.WATCH_VIDEO_COMMAND_NAME == "watch-video"
    assert skill_seed.SETUP_VIDEO_COMMAND_NAME == "setup-video-vision"


# --- fresh daemon: everything missing ---------------------------------------

def test_fresh_daemon_creates_skill_and_both_commands(patch_daemon):
    fake = patch_daemon(FakeDaemon(skill_body=None, commands=[]))

    result = skill_seed.seed()

    assert result["skill"] == "created"
    assert result["commands"] == {"watch-video": "created", "setup-video-vision": "created"}

    skill_creates = fake.calls_of("skills.create")
    assert len(skill_creates) == 1
    assert skill_creates[0]["name"] == skill_seed.SKILL_NAME
    assert skill_creates[0]["group"] == "builtin"
    assert "video" in skill_creates[0]["tags"]
    assert skill_creates[0]["body"] == skill_seed.SKILL_BODY

    command_creates = fake.calls_of("command.create")
    assert {c["name"] for c in command_creates} == {"watch-video", "setup-video-vision"}
    for c in command_creates:
        assert c["action_kind"] == "prompt"
    # no remove calls when nothing pre-existed
    assert fake.calls_of("command.remove") == []


# --- everything already present, same version -> no writes ------------------

def test_everything_present_same_version_issues_zero_create_calls(patch_daemon):
    fake = patch_daemon(FakeDaemon(
        skill_body=skill_seed.SKILL_BODY,
        commands=[skill_seed.WATCH_VIDEO_COMMAND_NAME, skill_seed.SETUP_VIDEO_COMMAND_NAME],
    ))

    result = skill_seed.seed()

    assert result["skill"] == "exists"
    assert result["commands"] == {"watch-video": "exists", "setup-video-vision": "exists"}
    assert fake.calls_of("skills.create") == []
    assert fake.calls_of("command.create") == []
    assert fake.calls_of("command.remove") == []


# --- version bump in the constant vs. the installed body -> update path -----

def test_version_bump_triggers_update_of_skill_and_commands(patch_daemon):
    stale_body = "[video skill v0]\nold guidance, superseded."
    fake = patch_daemon(FakeDaemon(
        skill_body=stale_body,
        commands=[skill_seed.WATCH_VIDEO_COMMAND_NAME, skill_seed.SETUP_VIDEO_COMMAND_NAME],
    ))

    result = skill_seed.seed()

    assert result["skill"] == "updated"
    assert result["commands"] == {"watch-video": "updated", "setup-video-vision": "updated"}

    assert len(fake.calls_of("skills.create")) == 1
    # commands have no update verb server-side -> remove then recreate
    removed = {p["name"] for p in fake.calls_of("command.remove")}
    recreated = {p["name"] for p in fake.calls_of("command.create")}
    assert removed == {"watch-video", "setup-video-vision"}
    assert recreated == {"watch-video", "setup-video-vision"}


def test_force_reseeds_even_when_version_matches(patch_daemon):
    fake = patch_daemon(FakeDaemon(
        skill_body=skill_seed.SKILL_BODY,
        commands=[skill_seed.WATCH_VIDEO_COMMAND_NAME, skill_seed.SETUP_VIDEO_COMMAND_NAME],
    ))

    result = skill_seed.seed(force=True)

    assert result["skill"] == "updated"
    assert result["commands"] == {"watch-video": "updated", "setup-video-vision": "updated"}
    assert len(fake.calls_of("skills.create")) == 1
    assert len(fake.calls_of("command.create")) == 2


def test_force_creates_when_nothing_present(patch_daemon):
    fake = patch_daemon(FakeDaemon(skill_body=None, commands=[]))

    result = skill_seed.seed(force=True)

    assert result["skill"] == "created"
    assert result["commands"] == {"watch-video": "created", "setup-video-vision": "created"}


# --- one command missing while the other is present + version matches ------

def test_only_missing_command_is_created(patch_daemon):
    patch_daemon(FakeDaemon(
        skill_body=skill_seed.SKILL_BODY,
        commands=[skill_seed.WATCH_VIDEO_COMMAND_NAME],  # setup-video-vision missing
    ))

    result = skill_seed.seed()

    assert result["skill"] == "exists"
    assert result["commands"]["watch-video"] == "exists"
    assert result["commands"]["setup-video-vision"] == "created"


# --- daemon completely unreachable -> error dict, never raises -------------

def test_daemon_down_returns_error_dict_and_never_raises(patch_daemon):
    patch_daemon(AlwaysDownDaemon())

    result = skill_seed.seed()  # must not raise

    assert result["skill"].startswith("error:")
    assert result["commands"]["watch-video"].startswith("error:")
    assert result["commands"]["setup-video-vision"].startswith("error:")


def test_daemon_down_with_force_also_never_raises(patch_daemon):
    patch_daemon(AlwaysDownDaemon())

    result = skill_seed.seed(force=True)

    assert result["skill"].startswith("error:")
    assert result["commands"]["watch-video"].startswith("error:")
    assert result["commands"]["setup-video-vision"].startswith("error:")
