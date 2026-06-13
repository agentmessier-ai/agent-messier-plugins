"""Behaviour of the GENERATED soccer tools (venue-agnostic-plugins.md) — built
by generate.generate_venue_tools from the soccer spec, exercised against a fake
pitch transport. The handlers are generic (routes/seat/actions from the spec);
soccer-specific client checks (run-needs-dir, foreign-player) are now the
SERVER's job, so they are intentionally absent here."""
import json
import sys

import pytest

client = sys.modules["hsoccer.client"]
gen = sys.modules["hsoccer.generate"]

SOCCER_SPEC = gen.DEFAULT_SPECS["agent-soccer"]
VENUE = {"id": "agent-soccer", "origin": "pitch", "specUrl": "/spec"}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("AGENTNET_SOCCER_URL", "http://pitch.test:3010")
    monkeypatch.delenv("AGENTNET_API_KEY", raising=False)
    monkeypatch.setenv("AGENTNET_SOCCER_TEAM", "hermes-test")
    yield


def fake(monkeypatch, routes):
    calls = []

    def _req(method, path, body=None, *, seat_token=None, timeout=8.0, base=None, caller_did=None):
        calls.append({"method": method, "path": path, "body": body, "seat_token": seat_token, "base": base})
        for (m, prefix), resp in routes.items():
            if m == method and path.startswith(prefix):
                if isinstance(resp, client.PitchError):
                    raise resp
                return resp
        raise client.PitchError(404, f"no fake route for {method} {path}")

    monkeypatch.setattr(client, "request", _req)
    return calls


def tool(name):
    for t in gen.generate_venue_tools(VENUE, SOCCER_SPEC):
        if t[0] == name:
            return t[2]  # handler
    raise AssertionError(f"no generated tool {name}")


def test_matches_lobby_lists_and_filters(monkeypatch):
    fake(monkeypatch, {("GET", "/matches"): {"matches": [
        {"id": "m1", "status": "live"}, {"id": "m2", "status": "waiting"}]}})
    out = json.loads(tool("soccer_matches")({}))
    assert out["ok"] and out["count"] == 2
    out2 = json.loads(tool("soccer_matches")({"status": "waiting"}))
    assert out2["count"] == 1 and out2["rows"][0]["id"] == "m2"


def test_join_persists_seat_and_flat_state(monkeypatch):
    fake(monkeypatch, {("POST", "/quickmatch"): {
        "matchId": "m7", "team": "home", "playerIds": ["home-9", "home-10"],
        "did": "hermes-test", "token": "seat-xyz"}})
    out = json.loads(tool("soccer_join")({"teamSize": 5, "name": "蓝鹰", "nation": "NL"}))
    assert out["ok"] and out["joined"] == "m7" and out["yours"] == ["home-9", "home-10"]
    # generic join writes the per-venue seat AND flat state (watcher back-compat)
    st = client.load_state()
    assert st["seats"]["agent-soccer"]["id"] == "m7"
    assert st["matchId"] == "m7" and st["token"] == "seat-xyz"


def test_observe_substitutes_the_route_template(monkeypatch):
    client.save_state({"seats": {"agent-soccer": {"id": "m7", "agentId": "hermes-test", "controls": ["home-9"], "token": "t"}}})
    calls = fake(monkeypatch, {("GET", "/matches/m7/agents/hermes-test/state"): {"tick": 5, "mine": []}})
    out = json.loads(tool("soccer_observe")({}))
    assert out["ok"] and out["view"]["tick"] == 5
    assert calls[0]["path"] == "/matches/m7/agents/hermes-test/state"  # routes.state, substituted


def test_observe_reports_match_gone(monkeypatch):
    client.save_state({"seats": {"agent-soccer": {"id": "m9", "agentId": "hermes-test", "controls": ["home-9"]}}})
    fake(monkeypatch, {("GET", "/matches/m9/agents/"): client.PitchError(404, "no claim")})
    out = json.loads(tool("soccer_observe")({}))
    assert out["ok"] is False and "join again" in out["error"]


def test_act_validates_enum_defaults_player_and_sends_token(monkeypatch):
    client.save_state({"seats": {"agent-soccer": {"id": "m7", "agentId": "hermes-test", "controls": ["home-9"], "token": "seat-xyz"}}})
    calls = fake(monkeypatch, {("POST", "/matches/m7/players/home-9/action"): {"ok": True}})
    out = json.loads(tool("soccer_play")({"type": "shoot", "say": "GOAL"}))
    assert out["ok"] and out["type"] == "shoot"
    assert calls[0]["path"] == "/matches/m7/players/home-9/action"  # {playerId} ← first controlled
    assert calls[0]["seat_token"] == "seat-xyz"
    assert calls[0]["body"]["say"] == "GOAL"


def test_act_rejects_unpublished_action(monkeypatch):
    client.save_state({"seats": {"agent-soccer": {"id": "m7", "agentId": "hermes-test", "controls": ["home-9"], "token": "t"}}})
    fake(monkeypatch, {})
    out = json.loads(tool("soccer_play")({"type": "teleport"}))
    assert out["ok"] is False and "must be one of" in out["error"]


def test_act_coerces_dir_array_to_xy(monkeypatch):
    client.save_state({"seats": {"agent-soccer": {"id": "m7", "agentId": "hermes-test", "controls": ["home-9"], "token": "t"}}})
    calls = fake(monkeypatch, {("POST", "/matches/m7/players/home-9/action"): {"ok": True}})
    out = json.loads(tool("soccer_play")({"type": "run", "dir": [0.8, -0.2], "distance": 15}))
    assert out["ok"]
    assert calls[0]["body"]["dir"] == {"x": 0.8, "y": -0.2}  # the one client fixup kept
    assert calls[0]["body"]["distance"] == 15


def test_join_by_id_routes_to_seatroute_not_body(monkeypatch):
    # matchId targets a specific room via seatRoute; it's routing, never a body field.
    calls = fake(monkeypatch, {("POST", "/matches/m9/join"): {
        "team": "home", "playerIds": ["home-9"], "did": "hermes-test", "token": "t"}})  # note: no matchId in the response
    out = json.loads(tool("soccer_join")({"matchId": "m9", "teamSize": 5}))
    assert out["ok"] and out["joined"] == "m9"        # seat.id falls back to the room we joined
    assert calls[0]["path"] == "/matches/m9/join"     # seatRoute, not /quickmatch
    assert "matchId" not in calls[0]["body"]          # routing key, kept out of the body
    assert client.load_state()["seats"]["agent-soccer"]["id"] == "m9"


def test_leave_posts_to_leave_route_and_frees_seat(monkeypatch):
    client.save_state({"seats": {"agent-soccer": {"id": "m7", "agentId": "hermes-test", "controls": ["home-9"], "token": "t"}},
                       "matchId": "m7", "token": "t"})
    calls = fake(monkeypatch, {("POST", "/matches/m7/leave"): {"left": "m7", "forfeit": True, "winner": "away"}})
    out = json.loads(tool("soccer_leave")({}))
    assert out["ok"] and out["left"] == "m7"
    assert calls[0]["path"] == "/matches/m7/leave"
    st = client.load_state()
    assert st["seats"].get("agent-soccer", {}) == {} and st["matchId"] is None  # freed


def test_leave_when_not_in_a_match_is_a_clean_error(monkeypatch):
    fake(monkeypatch, {})
    out = json.loads(tool("soccer_leave")({}))
    assert out["ok"] is False and "not in a match" in out["error"]


def test_server_url_ignores_a_non_url_env_value(monkeypatch):
    # A shell rc / nix env injected a stray script line — must NOT become the base
    # URL (that throws "unknown url type" and wedges every tool). Fall back to default.
    monkeypatch.setenv("AGENTNET_SOCCER_URL", 'if [ "$FOUND" = 0 ]; then')
    assert client.server_url() == "http://localhost:3010"
    monkeypatch.setenv("AGENTNET_SOCCER_URL", "https://pitch.example.com/")
    assert client.server_url() == "https://pitch.example.com"  # a real URL still flows through
