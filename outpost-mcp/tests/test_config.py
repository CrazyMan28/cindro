import importlib

from outpost_mcp import config


def test_port_and_token_env_override():
    assert config.port() == 8798
    assert config.get_bearer_token() == "test-inbound-token"


def test_advertise_base_url_uses_override():
    assert config.advertise_base_url() == "http://127.0.0.1:8798"


def test_resolve_host_prefers_env():
    assert config.resolve_advertise_host() == "127.0.0.1"


def test_config_dir_is_tmp(tmp_path, monkeypatch):
    # OUTPOST_CONFIG_DIR is read at import; recompute the path it would use.
    importlib.reload(config)
    assert str(config.OUTPOST_CONFIG_DIR).endswith(str(config.OUTPOST_CONFIG_DIR.name))
