"""The generic GSP client core: decide builds prompts FROM THE SERVER'S spec
(instructions + summary), validates against the published enum, and passes
per-action params through — zero game knowledge in the plugin."""
import sys

decide = sys.modules["hsoccer.decide"]
watcher = sys.modules["hsoccer.watcher"]
client = sys.modules["hsoccer.client"]

SPEC = {
    "game": "agent-soccer",
    "specVersion": 1,
    "rulesVersion": 2,
    "actions": {
        "enum": ["run", "kick", "chase", "shoot", "lob"],  # note: 'lob' is NOT in the static fallback
        "descriptions": {"lob": "Chip the ball over the keeper."},
    },
    "instructions": {
        "system": "You are a decisive soccer tactician.",
        "play": "Live soccer. Ball-carrier should lob when the keeper is off his line.",
        "output": 'Reply with ONLY JSON: {"moves":{"<playerId>":{"action":"...","say":"..."}}}',
    },
}

VIEW = {
    "tick": 10, "clock": 1, "phase": "live", "team": "home",
    "score": {"home": 0, "away": 0},
    "mine": [
        {"id": "home-9", "number": 9, "pos": {"x": 30, "y": 0}, "vel": {"x": 0, "y": 0}, "hasBall": True},
        {"id": "home-10", "number": 10, "pos": {"x": 10, "y": 5}, "vel": {"x": 0, "y": 0}, "hasBall": False},
    ],
    "ball": {"pos": {"x": 30, "y": 0}, "vel": {"x": 0, "y": 0}, "owner": "home-9"},
    "teammates": [], "opponents": [],
    "summary": "⚽ TEAM home — you control 2 players. SERVER-RENDERED SITUATION.",
}


def test_build_messages_uses_server_instructions_and_summary():
    msgs = decide.build_messages(VIEW, SPEC)
    assert msgs[0]["role"] == "system"
    assert msgs[0]["content"] == SPEC["instructions"]["system"]
    user = msgs[1]["content"]
    assert "SERVER-RENDERED SITUATION" in user          # view.summary, not plugin rendering
    assert "lob when the keeper" in user                # instructions.play
    assert '{"moves"' in user                           # instructions.output
    # no plugin-hardcoded soccer prose once the server provides it
    assert "you attack +x (right)" not in user.lower()


def test_build_messages_falls_back_without_spec_or_summary():
    view = {k: v for k, v in VIEW.items() if k != "summary"}
    msgs = decide.build_messages(view, None)
    user = msgs[1]["content"]
    assert "home-9" in user        # plugin-side rendering still works
    assert "moves" in user         # static output contract still taught


def test_parse_moves_validates_against_spec_enum():
    reply = '{"moves":{"home-9":{"action":"lob","say":"chip!"},"home-10":{"action":"sprint"}}}'
    moves = decide.parse_moves(reply, ["home-9", "home-10"], SPEC)
    acts = {(m[0], m[1]) for m in moves}
    assert ("home-9", "lob") in acts        # spec-published action accepted — zero plugin edit
    assert not any(m[1] == "sprint" for m in moves)  # unpublished action dropped


def test_parse_moves_passes_params_through():
    reply = '{"moves":{"home-9":{"action":"kick","dir":[1,0],"power":0.5,"say":"go"}}}'
    moves = decide.parse_moves(reply, ["home-9"], SPEC)
    assert len(moves) == 1
    pid, action, say, params = moves[0]
    assert (pid, action, say) == ("home-9", "kick", "go")
    assert params == {"dir": [1, 0], "power": 0.5}


def test_decide_threads_spec_through():
    def complete(msgs):
        assert SPEC["instructions"]["system"] in msgs[0]["content"]
        return '{"moves":{"home-9":{"action":"lob"}}}'
    moves = decide.decide(VIEW, complete, SPEC)
    assert [(m[0], m[1]) for m in moves] == [("home-9", "lob")]


def test_watcher_spec_guard_fetches_per_match_with_fallback_ladder(monkeypatch):
    """No cached spec → fetch /matches/:id/spec; that failing → /spec; that
    failing → None (static fallback). Re-checks on a later call (self-heals)."""
    calls = []

    def fake_request(method, path, body=None, **kw):
        calls.append(path)
        if path == "/matches/m1/spec":
            raise client.PitchError(503, "down")
        if path == "/spec":
            raise client.PitchError(503, "down")
        raise AssertionError(f"unexpected {path}")

    monkeypatch.setattr(client, "request", fake_request)
    watcher._reset_spec_cache()
    assert watcher._get_spec("m1") is None                  # full ladder failed → degraded, not dead
    assert calls == ["/matches/m1/spec", "/spec"]

    # network recovers → the SAME match self-heals to the snapshot
    def ok_request(method, path, body=None, **kw):
        calls.append(path)
        return SPEC

    monkeypatch.setattr(client, "request", ok_request)
    assert watcher._get_spec("m1") == SPEC
    # and it is cached per match — no further network on the next tick
    n = len(calls)
    assert watcher._get_spec("m1") == SPEC
    assert len(calls) == n


def test_watcher_spec_guard_refetches_on_match_change(monkeypatch):
    fetched = []
    monkeypatch.setattr(client, "request", lambda m, p, body=None, **kw: (fetched.append(p), SPEC)[1])
    watcher._reset_spec_cache()
    watcher._get_spec("m1")
    watcher._get_spec("m2")     # new game → new snapshot
    assert fetched == ["/matches/m1/spec", "/matches/m2/spec"]
