"""Hermetic tests for hermes-agent-soccer — a fake pitch transport, a temp
HERMES_HOME, no network. Run: pytest extensions/hermes-agent-soccer/tests
"""
import json
import sys

import pytest

# conftest.py loads the dashed plugin dir as the `hsoccer` package
client = sys.modules["hsoccer.client"]
tools = sys.modules["hsoccer.tools"]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AGENTNET_SOCCER_URL", "http://pitch.test:3010")
    monkeypatch.delenv("AGENTNET_API_KEY", raising=False)
    monkeypatch.setenv("AGENTNET_SOCCER_TEAM", "hermes-test")
    yield


def fake(monkeypatch, routes):
    """routes: dict (method, path-prefix) -> response dict OR PitchError."""
    calls = []

    def _req(method, path, body=None, *, seat_token=None, timeout=8.0):
        calls.append({"method": method, "path": path, "body": body, "seat_token": seat_token})
        for (m, prefix), resp in routes.items():
            if m == method and path.startswith(prefix):
                if isinstance(resp, client.PitchError):
                    raise resp
                return resp
        raise client.PitchError(404, f"no fake route for {method} {path}")

    monkeypatch.setattr(client, "request", _req)
    return calls


def test_matches_lists_and_filters(monkeypatch):
    fake(monkeypatch, {("GET", "/matches"): {"matches": [
        {"id": "m1", "status": "live", "teamSize": 5, "score": {"home": 1, "away": 0},
         "teams": {"home": {"name": "Blue"}, "away": {"name": "Red"}}, "sides": {"home": "a", "away": "b"}, "watchers": 3},
        {"id": "m2", "status": "waiting", "teamSize": 5, "score": {"home": 0, "away": 0},
         "teams": {"home": {"name": "Solo"}, "away": {}}, "sides": {"home": "a", "away": None}},
    ]}})
    out = json.loads(tools.soccer_matches({}))
    assert out["ok"] and out["count"] == 2 and out["live"] == 1
    assert out["matches"][0]["id"] == "M1"            # catalog designation
    assert out["matches"][1]["openSeat"] is True
    out2 = json.loads(tools.soccer_matches({"status": "waiting"}))
    assert out2["count"] == 1 and out2["matches"][0]["id"] == "M2"


def test_join_persists_state(monkeypatch):
    calls = fake(monkeypatch, {("POST", "/quickmatch"): {
        "matchId": "m7", "team": "home", "playerIds": ["home-9", "home-10"],
        "ready": False, "did": "hermes-test", "token": "seat-xyz"}})
    out = json.loads(tools.soccer_join({"teamSize": 5, "name": "蓝鹰", "nation": "NL"}))
    assert out["ok"] and out["matchId"] == "M7" and out["yourPlayers"] == ["home-9", "home-10"]
    # identity forwarded
    assert calls[0]["body"]["identity"] == {"name": "蓝鹰", "nation": "NL"}
    # state was written for the next tool call
    st = client.load_state()
    assert st["matchId"] == "m7" and st["token"] == "seat-xyz" and st["players"] == ["home-9", "home-10"]


def test_observe_requires_join(monkeypatch):
    fake(monkeypatch, {})
    out = json.loads(tools.soccer_observe({}))
    assert out["ok"] is False and "soccer_join" in out["error"]


def test_observe_clears_state_when_match_gone(monkeypatch):
    client.save_state({"matchId": "m9", "agentId": "hermes-test", "players": ["home-9"], "token": "t"})
    fake(monkeypatch, {("GET", "/matches/m9/agents/"): client.PitchError(404, "no claim for agent")})
    out = json.loads(tools.soccer_observe({}))
    assert out["ok"] is False and "ended or reset" in out["error"]
    assert client.load_state() == {}            # cleared so a stale match doesn't wedge the agent


def test_play_defaults_single_player_and_sends_token(monkeypatch):
    client.save_state({"matchId": "m7", "agentId": "hermes-test", "players": ["home-9"], "token": "seat-xyz"})
    calls = fake(monkeypatch, {("POST", "/matches/m7/players/home-9/action"): {"ok": True}})
    out = json.loads(tools.soccer_play({"type": "shoot", "say": "GOAL INCOMING"}))
    assert out["ok"] and out["player"] == "home-9" and out["said"] == "GOAL INCOMING"
    assert calls[0]["seat_token"] == "seat-xyz"          # seat auth replayed
    assert calls[0]["body"]["type"] == "shoot"


def test_play_requires_player_when_many(monkeypatch):
    client.save_state({"matchId": "m7", "agentId": "hermes-test", "players": ["home-9", "home-10"], "token": "t"})
    fake(monkeypatch, {})
    out = json.loads(tools.soccer_play({"type": "run"}))
    assert out["ok"] is False and "pass 'player'" in out["error"]


def test_play_rejects_foreign_player(monkeypatch):
    client.save_state({"matchId": "m7", "agentId": "hermes-test", "players": ["home-9"], "token": "t"})
    fake(monkeypatch, {})
    out = json.loads(tools.soccer_play({"player": "away-3", "type": "run"}))
    assert out["ok"] is False and "not your player" in out["error"]


def test_play_converts_dir_array_to_xy_object(monkeypatch):
    # The pitch wire format is dir:{x,y}; the model answers our schema with
    # [x,y]. Shipping the raw array made dir.x undefined server-side → NaN
    # positions (the m8 corner pile-up). The tool must convert.
    client.save_state({"matchId": "m7", "agentId": "hermes-test", "players": ["home-9"], "token": "t"})
    calls = fake(monkeypatch, {("POST", "/matches/m7/players/home-9/action"): {"ok": True}})
    out = json.loads(tools.soccer_play({"type": "run", "dir": [0.8, -0.2], "distance": 15}))
    assert out["ok"]
    assert calls[0]["body"]["dir"] == {"x": 0.8, "y": -0.2}
    assert calls[0]["body"]["distance"] == 15


def test_play_run_defaults_distance(monkeypatch):
    client.save_state({"matchId": "m7", "agentId": "hermes-test", "players": ["home-9"], "token": "t"})
    calls = fake(monkeypatch, {("POST", "/matches/m7/players/home-9/action"): {"ok": True}})
    out = json.loads(tools.soccer_play({"type": "run", "dir": [1, 0]}))
    assert out["ok"]
    assert calls[0]["body"]["distance"] == 20  # sane default, never absent


def test_play_run_without_dir_is_rejected_client_side(monkeypatch):
    client.save_state({"matchId": "m7", "agentId": "hermes-test", "players": ["home-9"], "token": "t"})
    fake(monkeypatch, {})
    out = json.loads(tools.soccer_play({"type": "run"}))
    assert out["ok"] is False and "dir" in out["error"]
