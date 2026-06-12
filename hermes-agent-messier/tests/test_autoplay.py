"""Tests for the agent-agnostic autoplay core (decide + watcher) — no live LLM,
no network: a fake `complete` and a fake pitch transport."""
import sys
import time

decide = sys.modules["hsoccer.decide"]
watcher = sys.modules["hsoccer.watcher"]
client = sys.modules["hsoccer.client"]

VIEW = {
    "phase": "live", "team": "home", "score": {"home": 0, "away": 1},
    "mine": [
        {"id": "home-9", "number": 9, "pos": {"x": 10, "y": 0}, "hasBall": True},
        {"id": "home-10", "number": 10, "pos": {"x": -5, "y": 8}, "hasBall": False},
    ],
    "ball": {"pos": {"x": 10, "y": 0}, "owner": "home-9"},
    "opponents": [{"id": "away-9", "number": 9, "pos": {"x": 20, "y": 0}}],
}


def test_build_messages_is_geometry_free_and_lists_my_players():
    msgs = decide.build_messages(VIEW)
    txt = msgs[-1]["content"]
    assert "home-9" in txt and "home-10" in txt
    assert "shoot" in txt and "chase" in txt          # the high-level vocab
    assert "[HAS BALL]" in txt                          # carrier flagged


def test_parse_moves_extracts_valid_actions_only():
    reply = 'sure!\n```json\n{"moves":{"home-9":{"action":"shoot","say":"GOAL"},"home-10":{"action":"sprint"},"bogus":{"action":"chase"}}}\n```'
    moves = decide.parse_moves(reply, ["home-9", "home-10"])
    assert ("home-9", "shoot", "GOAL", {}) in moves
    assert all(m[0] in ("home-9", "home-10") for m in moves)   # bogus dropped
    assert not any(m[1] == "sprint" for m in moves)            # invalid action dropped


def test_decide_uses_injected_complete():
    captured = {}
    def fake_complete(messages):
        captured["called"] = True
        return '{"moves":{"home-9":{"action":"dribble"},"home-10":{"action":"press"}}}'
    moves = decide.decide(VIEW, fake_complete)
    assert captured.get("called")
    assert {(m[0], m[1]) for m in moves} == {("home-9", "dribble"), ("home-10", "press")}


def test_decide_returns_empty_on_complete_failure():
    def boom(_):
        raise RuntimeError("model down")
    assert decide.decide(VIEW, boom) == []


def test_watcher_start_requires_configuration():
    watcher.stop()
    watcher._complete = None
    assert watcher.start() is False          # not wired → won't start


def test_watcher_runs_decisions_and_posts_moves(monkeypatch):
    # fake pitch: state in m1, observe returns VIEW, capture posted actions
    posted = []
    monkeypatch.setattr(client, "load_state", lambda: {"matchId": "m1", "agentId": "t", "players": ["home-9", "home-10"], "token": "tok"})
    monkeypatch.setattr(client, "team_handle", lambda: "t")
    def fake_request(method, path, body=None, **kw):
        if method == "GET" and path.endswith("/state"):
            return VIEW
        if method == "POST" and "/action" in path:
            posted.append((path.split("/players/")[1].split("/")[0], body["type"]))
            return {"ok": True}
        return {}
    monkeypatch.setattr(client, "request", fake_request)
    watcher.configure(complete=lambda m: '{"moves":{"home-9":{"action":"shoot"},"home-10":{"action":"chase"}}}',
                      log=lambda m: None)
    assert watcher.start(cadence_ms=500) is True
    time.sleep(0.4)
    watcher.stop(); time.sleep(0.6)
    assert ("home-9", "shoot") in posted and ("home-10", "chase") in posted
    assert not watcher.is_running()
