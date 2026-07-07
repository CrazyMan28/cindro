"""Hermetic fixtures: every test gets its own tmp config dir (isolated
outpost_machines.json + token) and a fixed inbound bearer."""

import pytest


@pytest.fixture(autouse=True)
def tmp_config(monkeypatch, tmp_path):
    monkeypatch.setenv("OUTPOST_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("OUTPOST_MCP_TOKEN", "test-inbound-token")
    monkeypatch.setenv("OUTPOST_ADVERTISE_HOST", "127.0.0.1")
    monkeypatch.setenv("OUTPOST_MCP_PORT", "8798")
    yield
