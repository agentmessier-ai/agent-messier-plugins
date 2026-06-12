"""Phase 5 — a human-editable strategy.md, mtime-cached, injected into the
decision prompt (~1k char cap). present→appears, edited(mtime)→refreshes,
absent→no block."""
import os
import sys
import time

import pytest

client = sys.modules["hsoccer.client"]
decide = sys.modules["hsoccer.decide"]

VIEW = {
    "phase": "live", "team": "home", "score": {"home": 0, "away": 0},
    "mine": [{"id": "home-9", "number": 9, "pos": {"x": 0, "y": 0}, "hasBall": True}],
    "ball": {"pos": {"x": 0, "y": 0}, "owner": "home-9"},
    "opponents": [],
}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # reset the mtime cache between tests
    client._strategy_cache.clear()
    yield


def _strategy_file(monkeypatch, tmp_path):
    p = tmp_path / "strategy.md"
    monkeypatch.setenv("AGENTNET_SOCCER_STRATEGY_FILE", str(p))
    return p


def test_strategy_absent_returns_empty(monkeypatch, tmp_path):
    _strategy_file(monkeypatch, tmp_path)
    assert client.strategy() == ""


def test_strategy_present_is_read(monkeypatch, tmp_path):
    p = _strategy_file(monkeypatch, tmp_path)
    p.write_text("Press high. Keep possession.", "utf-8")
    assert "Press high" in client.strategy()


def test_strategy_is_capped(monkeypatch, tmp_path):
    p = _strategy_file(monkeypatch, tmp_path)
    p.write_text("x" * 5000, "utf-8")
    assert len(client.strategy()) <= 1000


def test_strategy_refreshes_on_mtime_change(monkeypatch, tmp_path):
    p = _strategy_file(monkeypatch, tmp_path)
    p.write_text("first plan", "utf-8")
    assert "first plan" in client.strategy()
    # rewrite with a strictly newer mtime — the cache must refresh
    time.sleep(0.01)
    p.write_text("second plan", "utf-8")
    os.utime(p, (time.time() + 5, time.time() + 5))
    out = client.strategy()
    assert "second plan" in out and "first plan" not in out


def test_build_messages_injects_strategy_block(monkeypatch, tmp_path):
    p = _strategy_file(monkeypatch, tmp_path)
    p.write_text("Park the bus. Counter on the break.", "utf-8")
    msgs = decide.build_messages(VIEW)
    blob = "\n".join(m["content"] for m in msgs)
    assert "standing instructions" in blob.lower()
    assert "Park the bus" in blob


def test_build_messages_no_block_when_absent(monkeypatch, tmp_path):
    _strategy_file(monkeypatch, tmp_path)  # points at a non-existent file
    msgs = decide.build_messages(VIEW)
    blob = "\n".join(m["content"] for m in msgs)
    assert "standing instructions" not in blob.lower()
