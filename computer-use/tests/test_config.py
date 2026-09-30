"""Tests for auto-Tailscale-IP detection in load_config()."""

import socket
from pathlib import Path

import pytest
import yaml

from computer_use_mcp import config as cfg_mod


def _write_config(tmp_path: Path, data: dict) -> Path:
    p = tmp_path / "config.yaml"
    p.write_text(yaml.dump(data), encoding="utf-8")
    return p


@pytest.fixture(autouse=True)
def _patch_config_file(tmp_path, monkeypatch):
    monkeypatch.setattr(cfg_mod, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(cfg_mod, "CONFIG_FILE", tmp_path / "config.yaml")


def test_detect_tailscale_ip_returns_none_when_socket_fails(monkeypatch):
    def boom(*a, **k):
        raise OSError("no route")

    monkeypatch.setattr(socket, "socket", boom)
    assert cfg_mod._detect_tailscale_ip() is None


def test_detect_tailscale_ip_returns_none_when_ip_not_tailscale(monkeypatch, tmp_path):
    class _FakeSock:
        def __init__(self, *a, **k): pass
        def settimeout(self, t): pass
        def connect(self, addr): pass
        def getsockname(self): return ("192.168.1.5", 0)
        def __enter__(self): return self
        def __exit__(self, *a): pass

    monkeypatch.setattr(socket, "socket", lambda *a, **k: _FakeSock())
    assert cfg_mod._detect_tailscale_ip() is None


def test_detect_tailscale_ip_returns_tailscale_ip(monkeypatch):
    class _FakeSock:
        def __init__(self, *a, **k): pass
        def settimeout(self, t): pass
        def connect(self, addr): pass
        def getsockname(self): return ("100.101.102.103", 0)
        def __enter__(self): return self
        def __exit__(self, *a): pass

    monkeypatch.setattr(socket, "socket", lambda *a, **k: _FakeSock())
    assert cfg_mod._detect_tailscale_ip() == "100.101.102.103"


def test_load_config_uses_tailscale_ip_when_advertise_host_is_default(tmp_path, monkeypatch):
    _write_config(tmp_path, {
        "bearer_token": "tok",
        "host": "0.0.0.0",
        "port": 8794,
        "advertise_host": "127.0.0.1",
    })
    monkeypatch.setattr(cfg_mod, "_detect_tailscale_ip", lambda: "100.77.88.99")
    result = cfg_mod.load_config()
    assert result["advertise_host"] == "100.77.88.99"


def test_load_config_respects_explicit_advertise_host(tmp_path, monkeypatch):
    _write_config(tmp_path, {
        "bearer_token": "tok",
        "advertise_host": "192.168.0.50",
    })
    monkeypatch.setattr(cfg_mod, "_detect_tailscale_ip", lambda: "100.77.88.99")
    result = cfg_mod.load_config()
    # User set an explicit value — Tailscale auto-detect must not override it
    assert result["advertise_host"] == "192.168.0.50"


def test_load_config_keeps_loopback_when_tailscale_absent(tmp_path, monkeypatch):
    _write_config(tmp_path, {"bearer_token": "tok", "advertise_host": "127.0.0.1"})
    monkeypatch.setattr(cfg_mod, "_detect_tailscale_ip", lambda: None)
    result = cfg_mod.load_config()
    assert result["advertise_host"] == "127.0.0.1"
