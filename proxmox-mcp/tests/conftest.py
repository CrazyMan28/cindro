"""Hermetic fixtures: every test gets its own tmp config/state dirs so
nothing ever touches /etc or /var/lib, and no test ever shells out to a real
qm/pvesh binary."""

import pytest


@pytest.fixture(autouse=True)
def tmp_dirs(monkeypatch, tmp_path):
    monkeypatch.setenv("PROXMOX_AGENT_CONFIG_DIR", str(tmp_path / "etc"))
    monkeypatch.setenv("PROXMOX_AGENT_STATE_DIR", str(tmp_path / "var"))
    monkeypatch.setenv("PROXMOX_MCP_TOKEN", "test-inbound-token")
    monkeypatch.setenv("PROXMOX_MCP_PORT", "8799")
    yield
