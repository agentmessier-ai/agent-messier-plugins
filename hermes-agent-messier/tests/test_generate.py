"""The generic tool generator (venue-agnostic-plugins.md §5.2): tools are
GENERATED per venue from spec.client — soccer's exact surface, work's surface,
and any new venue's, with zero per-game code."""
import sys

gen = sys.modules.get("hsoccer.generate")
if gen is None:
    import importlib
    # loaded by conftest under this name; import directly if not yet wired
gen = sys.modules["hsoccer.generate"]

# Minimal soccer client block (mirrors GAME_SPEC.client)
SOCCER_SPEC = {
    "game": "agent-soccer", "specVersion": 1, "rulesVersion": 2,
    "actions": {"enum": ["chase", "shoot", "pass"], "descriptions": {"shoot": "shoot at goal"}},
    "observe": {"mode": "stream", "suggestedIntervalMs": 3000},
    "routes": {"observe": "/matches/{matchId}/agents/{did}/observe",
               "state": "/matches/{matchId}/agents/{did}/state",
               "act": "/matches/{matchId}/players/{playerId}/action"},
    "instructions": {"system": "s", "play": "p", "output": "o"},
    "client": {
        "prefix": "soccer", "noun": "match",
        "lobby": {"tool": "soccer_matches", "route": "/matches", "summary": "list rooms"},
        "join": {"tool": "soccer_join", "route": "/quickmatch",
                 "params": {"teamSize": {"type": "integer"}, "team": {"type": "string"}},
                 "seat": {"id": "matchId", "token": "token", "controls": "playerIds"},
                 "summary": "join a match"},
        "observe": {"tool": "soccer_observe", "summary": "see the pitch"},
        "act": {"tool": "soccer_play", "summary": "order a player"},
        "autoplay": {"tool": "soccer_autoplay", "summary": "hands-free"},
    },
}

WORK_SPEC = {
    "game": "taskmarket", "specVersion": 1, "rulesVersion": 1,
    "actions": {"enum": ["post", "bid", "deliver"], "descriptions": {}},
    "observe": {"mode": "poll", "suggestedIntervalMs": 30000},
    "routes": {"observe": "/agents/{did}/observe", "act": "/agents/{did}/action"},
    "instructions": {"system": "s", "play": "p", "output": "o"},
    "client": {
        "prefix": "taskmarket", "noun": "task", "lobby": None, "join": None,
        "observe": {"tool": "work_observe", "summary": "see the market"},
        "act": {"tool": "work_act", "summary": "act in the market"},
        "autoplay": {"tool": "work_autoplay", "summary": "hands-free work"},
    },
}

VENUE = {"id": "agent-soccer", "origin": "pitch", "specUrl": "/spec"}
WORK_VENUE = {"id": "taskmarket", "origin": "taskmarket", "specUrl": "/spec"}


def _names(tools):
    return [t[0] for t in tools]  # (name, schema, handler, emoji)


def test_soccer_generates_its_exact_named_surface():
    tools = gen.generate_venue_tools(WORK_VENUE if False else VENUE, SOCCER_SPEC)
    assert _names(tools) == ["soccer_matches", "soccer_join", "soccer_observe", "soccer_play", "soccer_autoplay"]


def test_work_generates_seatless_surface_no_lobby_no_join():
    tools = gen.generate_venue_tools(WORK_VENUE, WORK_SPEC)
    assert _names(tools) == ["work_observe", "work_act", "work_autoplay"]


def test_join_schema_carries_params_from_spec():
    tools = gen.generate_venue_tools(VENUE, SOCCER_SPEC)
    join = next(t for t in tools if t[0] == "soccer_join")
    props = join[1]["parameters"]["properties"]
    assert "teamSize" in props and "team" in props


def test_act_schema_enum_from_spec_actions():
    tools = gen.generate_venue_tools(VENUE, SOCCER_SPEC)
    play = next(t for t in tools if t[0] == "soccer_play")
    # soccer seats a side → BATCH: moves[] with per-move type carrying the enum.
    enum = play[1]["parameters"]["properties"]["moves"]["items"]["properties"]["type"]["enum"]
    assert set(["chase", "shoot", "pass"]).issubset(set(enum))


def test_golf_thesis_zero_plugin_code():
    """A brand-new venue's spec generates a full named tool set with NO golf code."""
    golf = {**SOCCER_SPEC, "game": "agent-golf",
            "actions": {"enum": ["swing", "putt"], "descriptions": {}},
            "client": {"prefix": "golf", "noun": "round",
                       "join": {"tool": "golf_join", "route": "/quickmatch",
                                "params": {"holes": {"type": "integer"}},
                                "seat": {"id": "matchId", "token": "token", "controls": "playerIds"},
                                "summary": "join a round"},
                       "observe": {"tool": "golf_observe", "summary": "see the course"},
                       "act": {"tool": "golf_act", "summary": "take a shot"},
                       "autoplay": {"tool": "golf_autoplay", "summary": "auto"}}}
    tools = gen.generate_venue_tools({"id": "agent-golf", "origin": "golf", "specUrl": "/spec"}, golf)
    assert _names(tools) == ["golf_join", "golf_observe", "golf_act", "golf_autoplay"]
